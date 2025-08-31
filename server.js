const express = require('express');
const app = express();

// Carico le variabili d'ambiente
const PORT = process.env.PORT || 10000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const PAYPAL_ME_USERNAME = process.env.PAYPAL_ME_USERNAME;

const RATE_LEONINA = parseFloat(process.env.RATE_LEONINA_EUR || 6);
const RATE_STANDARD = parseFloat(process.env.RATE_STANDARD_EUR || 5);
const SURCHARGE_STRIPE = parseFloat(process.env.SURCHARGE_STRIPE_EUR || 1.0);
const SURCHARGE_PAYPAL = parseFloat(process.env.SURCHARGE_PAYPAL_EUR || 1.4);

// Healthcheck → ci serve per testare se il servizio risponde
app.get('/health', (req, res) => {
  res.json({ ok: true, service: "city-tax-service" });
});

// Calcolo tassa e redirect a Stripe (dummy per ora)
app.get('/pay/stripe', (req, res) => {
  const { listing = "standard", guests = 1, nights = 1, res: reservationId = "TEST" } = req.query;

  const rate = (listing.toLowerCase() === "leonina") ? RATE_LEONINA : RATE_STANDARD;
  const baseAmount = rate * guests * nights;
  const totalAmount = baseAmount + SURCHARGE_STRIPE;

  res.json({
    provider: "stripe",
    listing,
    guests,
    nights,
    reservationId,
    baseAmount,
    surcharge: SURCHARGE_STRIPE,
    totalAmount,
    message: `Qui andrebbe creato il link checkout Stripe con importo ${totalAmount} EUR`
  });
});

// Calcolo tassa e redirect a PayPal.Me
app.get('/pay/paypal', (req, res) => {
  const { listing = "standard", guests = 1, nights = 1 } = req.query;

  const rate = (listing.toLowerCase() === "leonina") ? RATE_LEONINA : RATE_STANDARD;
  const baseAmount = rate * guests * nights;
  const totalAmount = baseAmount + SURCHARGE_PAYPAL;

  const paypalUrl = `https://www.paypal.me/${PAYPAL_ME_USERNAME}/${totalAmount}`;

  res.json({
    provider: "paypal",
    listing,
    guests,
    nights,
    baseAmount,
    surcharge: SURCHARGE_PAYPAL,
    totalAmount,
    link: paypalUrl
  });
});

// Avvio server
app.listen(PORT, () => {
  console.log(`City-tax-service listening on port ${PORT}`);
});
