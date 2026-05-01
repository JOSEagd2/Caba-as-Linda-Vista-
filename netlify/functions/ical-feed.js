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

/**
 * Aplica el plegado de línea según RFC 5545 (máximo 75 octetos).
 */
function foldLine(line) {
  const MAX = 75;
  if (line.length <= MAX) return line;
  let result = line.substring(0, MAX);
  let remaining = line.substring(MAX);
  while (remaining.length > 0) {
    result += "\r\n " + remaining.substring(0, MAX - 1);
    remaining = remaining.substring(MAX - 1);
  }
  return result;
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
      let cabinsRaw = data.cabins;
      if (typeof cabinsRaw === 'string') {
        cabinsRaw = cabinsRaw.trim().toLowerCase();
      }
      const cabins = Array.isArray(cabinsRaw)
        ? cabinsRaw.map(c => (typeof c === 'string' ? c.trim().toLowerCase() : c))
        : [cabinsRaw];

      if (cabins.includes(cabin)) {
        reservations.push({ id: doc.id, ...data });
      }
    });
  } catch (err) {
    console.error("[ical-feed] Error leyendo Firestore:", err.message);
    return { statusCode: 500, body: "Error al leer disponibilidad." };
  }

  // ========== NUEVO: Obtener bloqueos externos ==========
  let externalBlockings = [];
  try {
    const extSnapshot = await admin
      .firestore()
      .collection("external_blockings")
      .where("cabin", "==", cabin)
      .get();

    extSnapshot.forEach((doc) => {
      const block = doc.data();
      // Solo incluir eventos futuros (o con margen de 1 día)
      const nowDate = new Date();
      const checkInDate = new Date(block.checkIn + "T00:00:00");
      if (checkInDate >= new Date(nowDate.getTime() - 1 * 24 * 60 * 60 * 1000)) {
        externalBlockings.push(block);
      }
    });
  } catch (err) {
    console.error("[ical-feed] Error leyendo bloqueos externos:", err.message);
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
    `UID:placeholder-${cabin}-${Date.now()}@cabanaslindavista.com`,
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

  // ========== NUEVO: Eventos de bloqueos externos ==========
  const externalEvents = externalBlockings.map((block) => {
    return [
      "BEGIN:VEVENT",
      `UID:${block.uid}`,
      `DTSTAMP:${now}`,
      `DTSTART;VALUE=DATE:${toICSDate(block.checkIn)}`,
      `DTEND;VALUE=DATE:${toICSDate(block.checkOut)}`,
      `SUMMARY:${block.summary}`,
      "STATUS:CONFIRMED",
      "TRANSP:OPAQUE",
      "END:VEVENT",
    ].join(CRLF);
  });

  // Construimos el contenido iCal, aplicando plegado a cada línea
  const icsContent = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Cabañas Linda Vista//ES",
    `X-WR-CALNAME:${cabinLabel} — Reservas Web`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    placeholder,
    ...events,
    ...externalEvents,   // <-- incluimos los bloqueos externos
    "END:VCALENDAR",
  ].map(foldLine).join(CRLF);

  return {
    statusCode: 200,
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `inline; filename="${cabin}-reservas.ics"`,
      "Cache-Control": "no-cache, no-store, must-revalidate",
    },
    body: icsContent,
  };
};
