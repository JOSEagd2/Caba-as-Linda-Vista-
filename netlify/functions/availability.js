const admin = require("firebase-admin");
const https = require("https");

// ── Inicializar Firebase Admin SDK ────────────────────────────────────────
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId:   process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    }),
  });
}

// ── URLs iCal de las OTAs por cabaña ─────────────────────────────────────
const ICAL_SOURCES = {
  lidia: [
    "https://www.airbnb.com/calendar/ical/1017583253365154978.ics?t=8fe607394a104ba5a8baeb3d7035251f&locale=es-419",
    "https://ical.booking.com/v1/export?t=062d9969-f6ea-4a39-88c3-7b93a2be54c0g",
  ],
  lina: [
    "https://www.airbnb.com/calendar/ical/1021750622514893793.ics?t=6f478838eb7b4fc1a81582b4888ec790&locale=es-419",
    // Booking pendiente — agregar URL cuando esté disponible
  ],
  bella: [
    "https://www.airbnb.com/calendar/ical/1052462481828244019.ics?t=bac773f1a7214bd9ae111e613c332526&locale=es-419",
    // Booking pendiente — agregar URL cuando esté disponible
  ],
};

// ── Descarga una URL y devuelve el texto ──────────────────────────────────
function fetchURL(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve(data));
    }).on("error", reject);
  });
}

// ── Parsea un archivo .ics y extrae rangos { from, to } en formato YYYY-MM-DD
function parseICAL(icsText) {
  const ranges = [];
  const events = icsText.split("BEGIN:VEVENT");

  for (let i = 1; i < events.length; i++) {
    const block = events[i];

    const startMatch =
      block.match(/DTSTART;VALUE=DATE:(\d{8})/) ||
      block.match(/DTSTART:(\d{8})/);
    const endMatch =
      block.match(/DTEND;VALUE=DATE:(\d{8})/) ||
      block.match(/DTEND:(\d{8})/);

    if (!startMatch || !endMatch) continue;

    const toDateStr = (raw) => {
      const s = raw.slice(0, 8);
      return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
    };

    const from = toDateStr(startMatch[1]);
    const endDate = new Date(toDateStr(endMatch[1]) + "T00:00:00Z");
    endDate.setDate(endDate.getDate() - 1);
    const to = endDate.toISOString().split("T")[0];

    if (from <= to) {
      ranges.push({ from, to });
    }
  }
  return ranges;
}

// ── Lee reservas web desde Firestore para una cabaña ─────────────────────
async function getFirestoreRanges(cabin) {
  const ranges = [];
  try {
    const snapshot = await admin
      .firestore()
      .collection("reservations")
      .where("status", "==", "confirmed")
      .get();

    snapshot.forEach((doc) => {
      const data = doc.data();
      const cabins = Array.isArray(data.cabins) ? data.cabins : [data.cabins];
      if (cabins.includes(cabin) && data.checkIn && data.checkOut) {
        ranges.push({ from: data.checkIn, to: data.checkOut });
      }
    });
  } catch (err) {
    console.warn("[availability] Error leyendo Firestore:", err.message);
  }
  return ranges;
}

// ── Handler principal ─────────────────────────────────────────────────────
exports.handler = async () => {
  const cabins = Object.keys(ICAL_SOURCES);
  const result = {};

  await Promise.all(
    cabins.map(async (cabin) => {
      const allRanges = [];

      // 1. Leer feeds iCal de OTAs
      await Promise.all(
        ICAL_SOURCES[cabin].map(async (url) => {
          try {
            const icsText = await fetchURL(url);
            const ranges = parseICAL(icsText);
            allRanges.push(...ranges);
          } catch (err) {
            console.warn(`[availability] Error fetcheando iCal (${cabin}):`, err.message);
          }
        })
      );

      // 2. Leer reservas web desde Firestore
      const firestoreRanges = await getFirestoreRanges(cabin);
      allRanges.push(...firestoreRanges);

      result[cabin] = allRanges;
    })
  );

  return {
    statusCode: 200,
    headers: {
      "Content-Type":                "application/json",
      "Cache-Control":               "no-cache",
      "Access-Control-Allow-Origin": "*",
    },
    body: JSON.stringify(result),
  };
};
