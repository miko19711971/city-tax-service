// server.js — City Tax Service (net-to-gross fees)

const express = require('express');
const Stripe  = require('stripe');

const app = express();

/* ─────────── ENV ─────────── */
const PORT     = process.env.PORT || 10000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

const STRIPE_SECRET_KEY  = process.env.STRIPE_SECRET_KEY || '';
const PAYPAL_ME_USERNAME = process.env.PAYPAL_ME_USERNAME || 'MicheleB496';

// Tariffe (netto desiderato = guests * nights * rate)
const RATE_LEONINA  = parseFloat(process.env.RATE_LEONINA_EUR  || 6);
const RATE_STANDARD = parseFloat(process.env.RATE_STANDARD_EUR || 5);

// Commissioni PROCESSORI — tassi reali da transazioni verificate
const STRIPE_FEE_PCT = parseFloat(process.env.STRIPE_FEE_PCT || 0.0327); // 3.27% non-EU (es. USA)
const STRIPE_FEE_FIX = parseFloat(process.env.STRIPE_FEE_FIX_EUR || 0.25); // €0.25

// PayPal: 5.4% + €0.35 verificato su transazione reale (Mikaela Burrows, Australia)
const PAYPAL_FEE_PCT = parseFloat(process.env.PAYPAL_FEE_PCT || 0.054); // 5.4%
const PAYPAL_FEE_FIX = parseFloat(process.env.PAYPAL_FEE_FIX_EUR || 0.35); // €0.35

/* ─────────── Stripe SDK ─────────── */
const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

/* ─────────── HELPERS ─────────── */
const toEur = n => Number((+n).toFixed(2));
const getRate = (listing) =>
  String(listing).toLowerCase() === 'leonina' ? RATE_LEONINA : RATE_STANDARD;

/**
 * Calcola il lordo da far pagare per ottenere 'net' dopo una fee % + fissA.
 * Formula: gross = (net + fee_fix) / (1 - fee_pct)
 * Arrotondo SEMPRE verso l'alto al centesimo per coprire arrotondamenti del gateway.
 */
function grossForNet(net, feePct, feeFix) {
  if (net <= 0) return 0;
  const raw = (net + feeFix) / (1 - feePct);
  return Math.ceil(raw * 100) / 100; // arrotondo up a 2 decimali
}

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

/* ─────────── STRIPE CHECKOUT (NET→GROSS) ─────────── */
app.get('/pay/stripe', async (req, res) => {
  const {
    listing = 'standard',
    guests = 1,
    nights = 1,
    net: netParam = null,
    res: reservationId = ''
  } = req.query;

  const rate       = getRate(listing);
  const baseNet    = netParam !== null
    ? toEur(Number(netParam))
    : toEur(Number(guests) * Number(nights) * rate);
  if (!baseNet || baseNet <= 0) return res.status(400).send('Invalid amount.');

  // Calcolo il lordo da mostrare in checkout per incassare baseNet dopo le fee Stripe
  const totalGross = toEur(grossForNet(baseNet, STRIPE_FEE_PCT, STRIPE_FEE_FIX));

  if (!stripe) {
    // Fallback se manca la chiave: mostra i calcoli (non dovrebbe capitare in produzione)
    return res.json({
      provider: 'stripe',
      listing, guests, nights, reservationId,
      net_wanted: baseNet,
      fee_pct: STRIPE_FEE_PCT, fee_fix: STRIPE_FEE_FIX,
      gross_to_charge: totalGross,
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
          unit_amount: Math.round(totalGross * 100), // centesimi
          product_data: {
            name: 'Tourist Tax (City Tax)',
            description: reservationId
              ? `Reservation ${reservationId} — net €${baseNet.toFixed(2)}`
              : `Net €${baseNet.toFixed(2)}`
          }
        }
      }],
      success_url: `${BASE_URL}/success?res=${encodeURIComponent(reservationId)}&net=${baseNet.toFixed(2)}&gross=${totalGross.toFixed(2)}&provider=stripe`,
      cancel_url:  `${BASE_URL}/cancel?res=${encodeURIComponent(reservationId)}`
    });

    // Redirect diretto al Checkout Stripe
    return res.redirect(303, session.url);
  } catch (err) {
    console.error('Stripe error:', err?.message || err);
    return res.json({
      provider: 'stripe',
      listing, guests, nights, reservationId,
      net_wanted: baseNet,
      fee_pct: STRIPE_FEE_PCT, fee_fix: STRIPE_FEE_FIX,
      gross_to_charge: totalGross,
      error: 'Stripe checkout creation failed',
      details: String(err?.message || err)
    });
  }
});

/* ─────────── PAYPAL.ME (NET→GROSS REDIRECT) ─────────── */
app.get('/pay/paypal', (req, res) => {
  const { listing = 'standard', guests = 1, nights = 1, net: netParam = null } = req.query;

  const rate    = getRate(listing);
  const baseNet = netParam !== null
    ? toEur(Number(netParam))
    : toEur(Number(guests) * Number(nights) * rate);
  if (!baseNet || baseNet <= 0) return res.status(400).send('Invalid amount.');

  // Calcolo lordo per coprire fee PayPal
  const totalGross = toEur(grossForNet(baseNet, PAYPAL_FEE_PCT, PAYPAL_FEE_FIX));
  const url = `https://www.paypal.me/${PAYPAL_ME_USERNAME}/${totalGross.toFixed(2)}`;

  return res.redirect(302, url);
});

/* ─────────── ESITI ─────────── */
app.get('/success', (req, res) => {
  const { res: reservationId = '', net = '', gross = '', provider = '' } = req.query;
  res.send(
    `<h3>Payment received ✅</h3>
     ${reservationId ? `<p>Reservation: ${reservationId}</p>` : ''}
     ${provider ? `<p>Provider: ${provider}</p>` : ''}
     ${net ? `<p>Net expected: €${net}</p>` : ''}
     ${gross ? `<p>Charged gross: €${gross}</p>` : ''}`
  );
});

app.get('/cancel', (req, res) =>
  res.send('<h3>Payment canceled</h3>')
);

/* ─────────── START ─────────── */
app.listen(PORT, () => console.log(`City-tax-service listening on ${PORT}`));
