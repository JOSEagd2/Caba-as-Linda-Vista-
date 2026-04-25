 const Stripe = require("stripe");
const admin = require("firebase-admin");

// ── Precios oficiales — única fuente de verdad ─────────────────────────────
const CABIN_PRICES = {
  lidia: 2800,
  lina:  2700,
  bella: 2300,
};
const EXTRA_PERSON_PRICE = 400; // MXN por persona extra por noche
const MAX_EXTRA_GUESTS = 2;
const MIN_NIGHTS = 2;
const MAX_NIGHTS = 90;

// ── Inicializar Firebase Admin SDK (una sola vez) ──────────────────────────
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId:   process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    }),
  });
}

exports.handler = async (event) => {
  // ── Solo POST ────────────────────────────────────────────────────────────
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  // ── 1. Verificar idToken de Firebase ────────────────────────────────────
  const authHeader = event.headers["authorization"] || "";
  const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!idToken) {
    return {
      statusCode: 401,
      body: JSON.stringify({ error: "No autorizado. Inicia sesión para continuar." }),
    };
  }

  let decodedToken;
  try {
    decodedToken = await admin.auth().verifyIdToken(idToken);
  } catch {
    return {
      statusCode: 401,
      body: JSON.stringify({ error: "Token inválido o expirado. Inicia sesión de nuevo." }),
    };
  }

  const uid = decodedToken.uid;

  // ── 2. Parsear y validar el body ─────────────────────────────────────────
  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Body inválido." }) };
  }

  const { cabins, checkIn, checkOut, extraGuests = 0, guestEmail, paymentMethodId } = body;

  // Validar cabañas
  if (!Array.isArray(cabins) || cabins.length === 0) {
    return { statusCode: 400, body: JSON.stringify({ error: "Debes seleccionar al menos una cabaña." }) };
  }
  for (const cabin of cabins) {
    if (!CABIN_PRICES[cabin]) {
      return { statusCode: 400, body: JSON.stringify({ error: `Cabaña inválida: ${cabin}` }) };
    }
  }

  // Validar fechas
  const checkInDate  = new Date(checkIn  + "T00:00:00Z");
  const checkOutDate = new Date(checkOut + "T00:00:00Z");
  if (isNaN(checkInDate) || isNaN(checkOutDate) || checkOutDate <= checkInDate) {
    return { statusCode: 400, body: JSON.stringify({ error: "Fechas inválidas." }) };
  }
  const nights = Math.round((checkOutDate - checkInDate) / 86400000);
  if (nights < MIN_NIGHTS || nights > MAX_NIGHTS) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: `La reservación debe ser entre ${MIN_NIGHTS} y ${MAX_NIGHTS} noches.` }),
    };
  }

  // Validar extras
  const extras = parseInt(extraGuests, 10);
  if (isNaN(extras) || extras < 0 || extras > MAX_EXTRA_GUESTS) {
    return { statusCode: 400, body: JSON.stringify({ error: "Número de personas extra inválido." }) };
  }

  // Validar paymentMethodId
  if (!paymentMethodId || typeof paymentMethodId !== "string") {
    return { statusCode: 400, body: JSON.stringify({ error: "Método de pago inválido." }) };
  }

  // ── 3. Recalcular el monto en el servidor ────────────────────────────────
  const nightPrice  = cabins.reduce((sum, k) => sum + (CABIN_PRICES[k] || 0), 0);
  const extraCost   = extras * EXTRA_PERSON_PRICE * nights;
  const totalMXN    = nightPrice * nights + extraCost;
  const amountCents = Math.round(totalMXN * 100);

  // ── 4. Crear y confirmar el PaymentIntent con Stripe ────────────────────
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  let paymentIntent;
  try {
    paymentIntent = await stripe.paymentIntents.create({
      amount:         amountCents,
      currency:       "mxn",
      payment_method: paymentMethodId,
      confirm:        true,
      receipt_email:  guestEmail,
      return_url:     "https://cabanaslindavista.com",
      metadata: {
        uid,
        cabins:   cabins.join(", "),
        checkIn,
        checkOut,
        nights:   String(nights),
        extras:   String(extras),
        total:    String(totalMXN),
      },
    });
  } catch (err) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: err.message }),
    };
  }

  // ── 5. Guardar reserva en Firestore con Admin SDK ────────────────────────
  try {
    await admin.firestore().collection("reservations").add({
      uid,
      cabins,
      checkIn,
      checkOut,
      nights,
      extraGuests: extras,
      total:       totalMXN,
      guestEmail,
      paymentIntentId: paymentIntent.id,
      status:     "confirmed",
      createdAt:  admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (fsErr) {
    console.error("[Firestore] Error al guardar reserva:", fsErr.message);
  }

  // ── 6. Responder con clientSecret ────────────────────────────────────────
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientSecret: paymentIntent.client_secret }),
  };
};
