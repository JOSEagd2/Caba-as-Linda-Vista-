const admin = require("firebase-admin");
const https = require("https");

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(
    Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_B64, "base64").toString("utf8")
  );

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

// Las URLs ahora se toman de las variables de entorno
function getICAL_SOURCES() {
  const sources = {
    lidia: [],
    lina: [],
    bella: [],
  };

  if (process.env.AIRBNB_ICAL_LIDIA) sources.lidia.push(process.env.AIRBNB_ICAL_LIDIA);
  if (process.env.BOOKING_ICAL_LIDIA) sources.lidia.push(process.env.BOOKING_ICAL_LIDIA);
  if (process.env.AIRBNB_ICAL_LINA) sources.lina.push(process.env.AIRBNB_ICAL_LINA);
  // Lina no tiene Booking, así que no se agrega
  if (process.env.AIRBNB_ICAL_BELLA) sources.bella.push(process.env.AIRBNB_ICAL_BELLA);
  // Bella tampoco tiene Booking

  return sources;
}

function fetchURL(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve(data));
    }).on("error", reject);
  });
}

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
    const endExclusive = toDateStr(endMatch[1]);

    ranges.push({ from, to: endExclusive });
  }

  return ranges;
}

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

exports.handler = async () => {
  const ICAL_SOURCES = getICAL_SOURCES();
  const cabins = Object.keys(ICAL_SOURCES);
  const result = {};

  await Promise.all(
    cabins.map(async (cabin) => {
      const allRanges = [];

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

      const firestoreRanges = await getFirestoreRanges(cabin);
      allRanges.push(...firestoreRanges);

      result[cabin] = allRanges;
    })
  );

  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-cache",
      "Access-Control-Allow-Origin": "*",
    },
    body: JSON.stringify(result),
  };
};
