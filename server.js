const express = require('express');
const Stripe  = require('stripe');

const app = express();

// ── ENV ───────────────────────────────────────────────────────────────────────
const PORT   = process.env.PORT || 10000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

const STRIPE_SECRET_KEY   = process.env.STRIPE_SECRET_KEY;            // sk_test_... / sk_live_...
const PAYPAL_ME_USERNAME  = process.env.PAYPAL_ME_USERNAME || "micheleb469";

const RATE_LEONINA        = parseFloat(process.env.RATE_LEONINA_EUR   || 6);
const RATE_STANDARD       = parseFloat(process.env.RATE_STANDARD_EUR  || 5);
const SURCHARGE_STRIPE    = parseFloat(process.env.SURCHARGE_STRIPE_EUR || 1.00);
const SURCHARGE_PAYPAL    = parseFloat(process.env.SURCHARGE_PAYPAL_EUR || 1.40);

// Stripe SDK (solo se c'è la chiave)
const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

// ── HELPERS ──────────────────────────────────────────────────────────────────
function toEur(n) {
  return Number((+n).toFixed(2));
}
function getRate(listing) {
  return (String(listing).toLowerCase() === 'leonina') ? RATE_LEONINA : RATE_STANDARD;
}

// ── HEALTHCHECK ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'city-tax-service' });
});

// ── STRIPE: crea Checkout Session e reindirizza ──────────────────────────────
app.get('/pay/stripe', async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).send('Stripe is not configured. Missing STRIPE_SECRET_KEY.');
    }

    const {
      listing = 'standard',
      guests  = 1,
      nights  = 1,
      res: reservationId = ''
    } = req.query;

    const rate       = getRate(listing);
    const baseAmount = toEur(rate * Number(guests) * Number(nights));
    if (!baseAmount || baseAmount <= 0) return res.status(400).send('Invalid amount.');

    const totalAmount = toEur(baseAmount + SURCHARGE_STRIPE);

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      currency: 'eur',
      line_items: [{
        quantity: 1,
        price_data: {
          currency: 'eur',
          unit_amount: Math.round(totalAmount * 100), // in centesimi
          product_data: {
            name: 'Tourist Tax (City Tax)',
            description: reservationId
              ? `Reservation ${reservationId} — base €${baseAmount.toFixed(2)} + processing`
              : `Base €${baseAmount.toFixed(2)} + processing`
          }
        }
      }],
      success_url: `${BASE_URL}/success?res=${encodeURIComponent(reservationId)}&amt=${totalAmount.toFixed(2)}`,
      cancel_url:  `${BASE_URL}/cancel?res=${encodeURIComponent(reservationId)}`
    });

    return res.redirect(303, session.url);
  } catch (err) {
    console.error('Stripe error:', err);
    return res.status(500).send('Stripe error.');
  }
});

// ── PAYPAL.ME: calcola importo e reindirizza ─────────────────────────────────
app.get('/pay/paypal', (req, res) => {
  const {
    listing = 'standard',
    guests  = 1,
    nights  = 1,
    res: reservationId = ''
  } = req.query;

  const rate       = getRate(listing);
  const baseAmount = toEur(rate * Number(guests) * Number(nights));
  if (!baseAmount || baseAmount <= 0) return res.status(400).send('Invalid amount.');

  const totalAmount = toEur(baseAmount + SURCHARGE_PAYPAL);
  // PayPal.Me usa il punto per i decimali
  const url = `https://www.paypal.me/${PAYPAL_ME_USERNAME}/${totalAmount.toFixed(2)}`;

  // Nota: PayPal.Me non supporta una "causale"; mettila nella mail HostAway.
  return res.redirect(302, url);
});

// ── PAGINE DI ESITO SEMPLICI ─────────────────────────────────────────────────
app.get('/success', (req, res) => {
  const { res: reservationId = '', amt = '' } = req.query;
  res.send(`
    <h3>Payment received ✅</h3>
    ${reservationId ? `<p>Reservation: ${reservationId}</p>` : ''}
    ${amt ? `<p>Amount: €${amt}</p>` : ''}
    <p>Thank you! We will remit the city tax to the Municipality.</p>
  `);
});

app.get('/cancel', (req, res) => {
  res.send('<h3>Payment canceled</h3><p>You can close this page and try again later.</p>');
});

// ── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`City-tax-service listening on ${PORT}`);
});
