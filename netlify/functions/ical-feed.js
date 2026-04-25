const admin = require("firebase-admin");

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId:   process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    }),
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

  const cabin = event.queryStringParameters?.cabin?.toLowerCase();
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

    snapshot.forEach((doc) => {
      const data = doc.data();
      const cabins = Array.isArray(data.cabins) ? data.cabins : [data.cabins];
      if (cabins.includes(cabin)) {
        reservations.push({ id: doc.id, ...data });
      }
    });
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
    lina:  "Cabaña Lina",
    bella: "Cabaña Bella",
  }[cabin];

  const events = reservations.map((r) => {
    const checkOutDate = new Date(r.checkOut + "T00:00:00Z");
    checkOutDate.setDate(checkOutDate.getDate() + 1);
    const checkOutICS = checkOutDate.toISOString().split("T")[0].replace(/-/g, "");

    return [
      "BEGIN:VEVENT",
      `UID:${makeUID(r.id, cabin)}`,
      `DTSTAMP:${now}`,
      `DTSTART;VALUE=DATE:${toICSDate(r.checkIn)}`,
      `DTEND;VALUE=DATE:${checkOutICS}`,
      `SUMMARY:Reservado — ${cabinLabel}`,
      `DESCRIPTION:Reserva confirmada desde cabanaslindavista.com`,
      "STATUS:CONFIRMED",
      "TRANSP:OPAQUE",
      "END:VEVENT",
    ].join("\r\n");
  });

  const icsContent = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Cabañas Linda Vista//ES",
    `X-WR-CALNAME:${cabinLabel} — Reservas Web`,
    "X-WR-CALDESC:Reservas confirmadas en cabanaslindavista.com",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-PUBLISHED-TTL:PT1H",
    ...events,
    "END:VCALENDAR",
  ].join("\r\n");

  return {
    statusCode: 200,
    headers: {
      "Content-Type":        "text/calendar; charset=utf-8",
      "Content-Disposition": `inline; filename="${cabin}-reservas.ics"`,
      "Cache-Control":       "no-cache, no-store, must-revalidate",
    },
    body: icsContent,
  };
};
