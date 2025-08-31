const express = require('express');
const Stripe  = require('stripe');

const app = express();

/* ─────────── ENV ─────────── */
const PORT   = process.env.PORT || 10000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

const STRIPE_SECRET_KEY  = process.env.STRIPE_SECRET_KEY || '';
const PAYPAL_ME_USERNAME = process.env.PAYPAL_ME_USERNAME || 'MicheleB496';

const RATE_LEONINA       = parseFloat(process.env.RATE_LEONINA_EUR   || 6);
const RATE_STANDARD      = parseFloat(process.env.RATE_STANDARD_EUR  || 5);
const SURCHARGE_STRIPE   = parseFloat(process.env.SURCHARGE_STRIPE_EUR || 1.00);
const SURCHARGE_PAYPAL   = parseFloat(process.env.SURCHARGE_PAYPAL_EUR || 1.40);

/* ─────────── Stripe SDK ─────────── */
const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

/* ─────────── HELPERS ─────────── */
const toEur = n => Number((+n).toFixed(2));
const getRate = (listing) =>
  String(listing).toLowerCase() === 'leonina' ? RATE_LEONINA : RATE_STANDARD;

/* ─────────── ROUTES ─────────── */
app.get('/', (req, res) => {
  res.send(`
    <h3>city-tax-service ✅</h3>
    <p>Try:</p>
    <ul>
      <li>/health</li>
      <li>/pay/paypal?listing=standard&guests=2&nights=3</li>
      <li>/pay/stripe?listing=leonina&guests=2&nights=3&res=TEST123</li>
    </ul>
  `);
});

app.get('/health', (req, res) =>
  res.json({ ok: true, service: 'city-tax-service' })
);

/* ─────────── STRIPE CHECKOUT (vero) ─────────── */
app.get('/pay/stripe', async (req, res) => {
  const {
    listing = 'standard',
    guests = 1,
    nights = 1,
    res: reservationId = ''
  } = req.query;

  const rate       = getRate(listing);
  const baseAmount = toEur(Number(guests) * Number(nights) * rate);
  if (!baseAmount || baseAmount <= 0) return res.status(400).send('Invalid amount.');

  const totalAmount = toEur(baseAmount + SURCHARGE_STRIPE);

  if (!stripe) {
    // Fallback se manca la chiave: mostra i calcoli (non dovrebbe capitare in produzione)
    return res.json({
      provider: 'stripe',
      listing, guests, nights, reservationId,
      baseAmount, surcharge: SURCHARGE_STRIPE, totalAmount,
      error: 'Missing STRIPE_SECRET_KEY'
    });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      currency: 'eur',
      line_items: [{
        quantity: 1,
        price_data: {
          currency: 'eur',
          unit_amount: Math.round(totalAmount * 100), // centesimi
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

    // Redirect diretto al Checkout Stripe
    return res.redirect(303, session.url);
  } catch (err) {
    console.error('Stripe error:', err?.message || err);
    // Mostra info utili senza bloccare
    return res.json({
      provider: 'stripe',
      listing, guests, nights, reservationId,
      baseAmount, surcharge: SURCHARGE_STRIPE, totalAmount,
      error: 'Stripe checkout creation failed',
      details: String(err?.message || err)
    });
  }
});

/* ─────────── PAYPAL.ME (redirect) ─────────── */
app.get('/pay/paypal', (req, res) => {
  const { listing = 'standard', guests = 1, nights = 1 } = req.query;

  const rate       = getRate(listing);
  const baseAmount = toEur(Number(guests) * Number(nights) * rate);
  if (!baseAmount || baseAmount <= 0) return res.status(400).send('Invalid amount.');

  const totalAmount = toEur(baseAmount + SURCHARGE_PAYPAL);
  const url = `https://www.paypal.me/${PAYPAL_ME_USERNAME}/${totalAmount.toFixed(2)}`;

  return res.redirect(302, url);
});

/* ─────────── ESITI ─────────── */
app.get('/success', (req, res) => {
  const { res: reservationId = '', amt = '' } = req.query;
  res.send(`<h3>Payment received ✅</h3>
            ${reservationId ? `<p>Reservation: ${reservationId}</p>` : ''}
            ${amt ? `<p>Amount: €${amt}</p>` : ''}`);
});

app.get('/cancel', (req, res) =>
  res.send('<h3>Payment canceled</h3>')
);

/* ─────────── START ─────────── */
app.listen(PORT, () => console.log(`City-tax-service listening on ${PORT}`));
