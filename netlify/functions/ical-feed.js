const admin = require("firebase-admin");

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(
    Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_B64, "base64").toString("utf8")
  );

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const VALID_CABINS = ["lidia", "lina", "bella"];

function toICSDate(dateStr) {
  return dateStr.replace(/-/g, "");
}

function makeUID(reservationId, cabin) {
  return `${reservationId}-${cabin}@cabanaslindavista.com`;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const cabin = event.queryStringParameters?.cabin?.toLowerCase().trim();
  if (!cabin || !VALID_CABINS.includes(cabin)) {
    return {
      statusCode: 400,
      body: "Parámetro ?cabin inválido. Usa: lidia, lina o bella.",
    };
  }

  let reservations = [];
  try {
    const snapshot = await admin
      .firestore()
      .collection("reservations")
      .where("status", "==", "confirmed")
      .get();

    console.log(`[ical-feed] Documentos encontrados: ${snapshot.size}`);

    snapshot.forEach((doc) => {
      const data = doc.data();

      // Normalizar cabins para que sea un array limpio
      let cabinsRaw = data.cabins;
      if (typeof cabinsRaw === 'string') {
        cabinsRaw = cabinsRaw.trim().toLowerCase();
      }
      const cabins = Array.isArray(cabinsRaw)
        ? cabinsRaw.map(c => (typeof c === 'string' ? c.trim().toLowerCase() : c))
        : [cabinsRaw];

      console.log(
        `[ical-feed] Doc ID: ${doc.id}, status: "${data.status}", cabins normalizado: ${JSON.stringify(cabins)}`
      );

      if (cabins.includes(cabin)) {
        reservations.push({ id: doc.id, ...data });
      }
    });

    console.log(`[ical-feed] Reservas que coinciden con cabina "${cabin}": ${reservations.length}`);
    if (reservations.length > 0) {
      console.log(
        `[ical-feed] Primera reserva - checkIn tipo: ${typeof reservations[0].checkIn}, valor: ${reservations[0].checkIn}`
      );
      console.log(
        `[ical-feed] Primera reserva - checkOut tipo: ${typeof reservations[0].checkOut}, valor: ${reservations[0].checkOut}`
      );
    }
  } catch (err) {
    console.error("[ical-feed] Error leyendo Firestore:", err.message);
    return { statusCode: 500, body: "Error al leer disponibilidad." };
  }

  const now = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z/, "Z");

  const cabinLabel = {
    lidia: "Cabaña Lidia",
    lina: "Cabaña Lina",
    bella: "Cabaña Bella",
  }[cabin];

  const CRLF = "\r\n";

  const placeholder = [
    "BEGIN:VEVENT",
    `UID:placeholder-${cabin}@cabanaslindavista.com`,
    `DTSTAMP:${now}`,
    "DTSTART;VALUE=DATE:20200101",
    "DTEND;VALUE=DATE:20200102",
    `SUMMARY:Calendario ${cabinLabel}`,
    "STATUS:CONFIRMED",
    "TRANSP:TRANSPARENT",
    "END:VEVENT",
  ].join(CRLF);

  const events = reservations.map((r) => {
    return [
      "BEGIN:VEVENT",
      `UID:${makeUID(r.id, cabin)}`,
      `DTSTAMP:${now}`,
      `DTSTART;VALUE=DATE:${toICSDate(r.checkIn)}`,
      `DTEND;VALUE=DATE:${toICSDate(r.checkOut)}`,
      `SUMMARY:Reservado — ${cabinLabel}`,
      "STATUS:CONFIRMED",
      "TRANSP:OPAQUE",
      "END:VEVENT",
    ].join(CRLF);
  });

  const icsContent = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Cabañas Linda Vista//ES",
    `X-WR-CALNAME:${cabinLabel} — Reservas Web`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    placeholder,
    ...events,
    "END:VCALENDAR",
  ].join(CRLF);

  return {
    statusCode: 200,
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename="${cabin}-reservas.ics"`,
      "Cache-Control": "no-cache, no-store, must-revalidate",
    },
    body: icsContent,
  };
};
