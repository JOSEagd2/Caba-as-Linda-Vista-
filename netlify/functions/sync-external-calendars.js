const fetch = require("node-fetch");
const ical = require("ical.js");
const admin = require("firebase-admin");

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(
    Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_B64, "base64").toString("utf8")
  );
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const CABIN_FEEDS = {
  lidia: {
    airbnb: process.env.AIRBNB_ICAL_LIDIA,
    booking: process.env.BOOKING_ICAL_LIDIA,
  },
  lina: {
    airbnb: process.env.AIRBNB_ICAL_LINA,
    booking: process.env.BOOKING_ICAL_LINA,
  },
  bella: {
    airbnb: process.env.AIRBNB_ICAL_BELLA,
    booking: process.env.BOOKING_ICAL_BELLA,
  },
};

function icalDateToYYYYMMDD(icalDate) {
  if (!icalDate) return null;
  if (typeof icalDate === "string") {
    if (icalDate.length === 8) {
      return `${icalDate.slice(0, 4)}-${icalDate.slice(4, 6)}-${icalDate.slice(6, 8)}`;
    }
    return icalDate.slice(0, 10);
  }
  if (icalDate.year && icalDate.month && icalDate.day) {
    const y = icalDate.year;
    const m = String(icalDate.month).padStart(2, "0");
    const d = String(icalDate.day).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return null;
}

exports.handler = async (event) => {
  const results = [];

  for (const [cabin, feeds] of Object.entries(CABIN_FEEDS)) {
    for (const [source, url] of Object.entries(feeds)) {
      if (!url) {
        results.push(`${cabin}-${source}: URL no configurada`);
        continue;
      }

      try {
        const response = await fetch(url);
        if (!response.ok) {
          results.push(`${cabin}-${source}: HTTP ${response.status}`);
          continue;
        }

        const rawData = await response.text();
        const parsed = ical.parse(rawData);
        const comp = new ical.Component(parsed);
        const vevents = comp.getAllSubcomponents("vevent");

        let added = 0;
        for (const vevent of vevents) {
          const uid = vevent.getFirstPropertyValue("uid");
          const dtstart = vevent.getFirstPropertyValue("dtstart");
          const dtend = vevent.getFirstPropertyValue("dtend");
          const summary = vevent.getFirstPropertyValue("summary") || "";

          if (summary.toLowerCase().includes("placeholder") || summary.toLowerCase().includes("calendario")) continue;

          const checkIn = icalDateToYYYYMMDD(dtstart);
          const checkOut = icalDateToYYYYMMDD(dtend);

          if (!checkIn || !checkOut) continue;

          const now = new Date();
          const checkInDate = new Date(checkIn + "T00:00:00");
          if (checkInDate < new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)) continue;

          await admin
            .firestore()
            .collection("external_blockings")
            .doc(uid)
            .set(
              {
                cabin,
                source,
                checkIn,
                checkOut,
                summary,
                uid,
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              },
              { merge: true }
            );

          added++;
        }

        results.push(`${cabin}-${source}: ${added} eventos importados`);
      } catch (error) {
        results.push(`${cabin}-${source}: Error - ${error.message}`);
      }
    }
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ results }, null, 2),
  };
};
