// server.js — City Tax Service (net-to-gross fees)

const express = require('express');
const https   = require('https');

const app = express();

/* ─────────── ENV ─────────── */
const PORT     = process.env.PORT || 10000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

const STRIPE_SECRET_KEY         = process.env.STRIPE_SECRET_KEY         || '';
const STRIPE_SECRET_KEY_LEONINA = process.env.STRIPE_SECRET_KEY_LEONINA || '';

const PAYPAL_ME_USERNAME         = process.env.PAYPAL_ME_USERNAME         || 'MicheleB496';
const PAYPAL_ME_USERNAME_LEONINA = process.env.PAYPAL_ME_USERNAME_LEONINA || '';

// Tariffe (netto desiderato = guests * nights * rate)
const RATE_LEONINA  = parseFloat(process.env.RATE_LEONINA_EUR  || 6);
const RATE_STANDARD = parseFloat(process.env.RATE_STANDARD_EUR || 5);

// Commissioni PROCESSORI — tassi reali da transazioni verificate
const STRIPE_FEE_PCT = parseFloat(process.env.STRIPE_FEE_PCT || 0.0327); // 3.27% non-EU
const STRIPE_FEE_FIX = parseFloat(process.env.STRIPE_FEE_FIX_EUR || 0.25); // €0.25

// PayPal: 5.4% + €0.35 verificato su transazione reale
const PAYPAL_FEE_PCT = parseFloat(process.env.PAYPAL_FEE_PCT || 0.054);
const PAYPAL_FEE_FIX = parseFloat(process.env.PAYPAL_FEE_FIX_EUR || 0.35);

/* ─────────── HELPERS ─────────── */
const toEur     = n => Number((+n).toFixed(2));
const isLeonina = listing => String(listing).toLowerCase().includes('leonina');
const getRate   = listing => isLeonina(listing) ? RATE_LEONINA : RATE_STANDARD;

function getStripeKey(listing) {
  return isLeonina(listing) ? STRIPE_SECRET_KEY_LEONINA : STRIPE_SECRET_KEY;
}

function grossForNet(net, feePct, feeFix) {
  if (net <= 0) return 0;
  const raw = (net + feeFix) / (1 - feePct);
  return Math.ceil(raw * 100) / 100;
}

// Chiama Stripe API direttamente via HTTPS (evita problemi connessione SDK su Render)
function stripePost(path, params, secretKey) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(params).toString();
    const options = {
      hostname: 'api.stripe.com',
      path,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${secretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Stripe request timeout')); });
    req.write(body);
    req.end();
  });
}

/* ─────────── ROUTES ─────────── */
app.get('/', (req, res) => {
  res.send(`<h3>city-tax-service ✅</h3><p>Try /pay/stripe?listing=leonina&guests=2&nights=3&res=TEST123</p>`);
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

  const rate    = getRate(listing);
  const baseNet = netParam !== null
    ? toEur(Number(netParam))
    : toEur(Number(guests) * Number(nights) * rate);
  if (!baseNet || baseNet <= 0) return res.status(400).send('Invalid amount.');

  const totalGross  = toEur(grossForNet(baseNet, STRIPE_FEE_PCT, STRIPE_FEE_FIX));
  const amountCents = Math.round(totalGross * 100);
  const secretKey   = getStripeKey(listing);

  console.log(`🔑 Stripe: ${isLeonina(listing) ? 'LEONINA (Stella)' : 'principale'} | net:${baseNet} | gross:${totalGross}`);

  if (!secretKey) {
    return res.status(500).json({
      error: isLeonina(listing) ? 'Missing STRIPE_SECRET_KEY_LEONINA' : 'Missing STRIPE_SECRET_KEY'
    });
  }

  try {
    const params = new URLSearchParams();
    params.append('mode', 'payment');
    params.append('payment_method_types[]', 'card');
    params.append('line_items[0][price_data][currency]', 'eur');
    params.append('line_items[0][price_data][unit_amount]', String(amountCents));
    params.append('line_items[0][price_data][product_data][name]', 'Tassa di soggiorno - Roma');
    params.append('line_items[0][price_data][product_data][description]',
      reservationId ? `Prenotazione ${reservationId}` : `Net €${baseNet.toFixed(2)}`);
    params.append('line_items[0][quantity]', '1');
    if (reservationId) {
      params.append('metadata[reservation_id]', reservationId);
      params.append('payment_intent_data[metadata][reservation_id]', reservationId);
    }
    params.append('success_url', `${BASE_URL}/success?res=${encodeURIComponent(reservationId)}&net=${baseNet.toFixed(2)}&gross=${totalGross.toFixed(2)}&provider=stripe`);
    params.append('cancel_url',  `${BASE_URL}/cancel?res=${encodeURIComponent(reservationId)}`);

    const session = await stripePost('/v1/checkout/sessions', Object.fromEntries(params), secretKey);

    if (session.error) {
      console.error('Stripe error:', session.error.message);
      return res.status(500).json({ error: 'Stripe checkout creation failed', details: session.error.message });
    }

    console.log(`💳 Session: ${session.id} | res:${reservationId} | EUR ${totalGross}`);
    return res.redirect(303, session.url);
  } catch (err) {
    console.error('Stripe error:', err.message);
    return res.status(500).json({ error: 'Stripe checkout creation failed', details: err.message });
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

  const totalGross = toEur(grossForNet(baseNet, PAYPAL_FEE_PCT, PAYPAL_FEE_FIX));
  const username   = isLeonina(listing) && PAYPAL_ME_USERNAME_LEONINA
    ? PAYPAL_ME_USERNAME_LEONINA
    : PAYPAL_ME_USERNAME;

  console.log(`💙 PayPal: ${username} | listing:${listing} | net:${baseNet} | gross:${totalGross}`);
  return res.redirect(302, `https://www.paypal.me/${username}/${totalGross.toFixed(2)}`);
});

/* ─────────── ESITI ─────────── */
app.get('/success', (req, res) => {
  const { res: reservationId = '', net = '', gross = '', provider = '' } = req.query;
  res.send(`<h3>Pagamento ricevuto ✅</h3>
    ${reservationId ? `<p>Prenotazione: ${reservationId}</p>` : ''}
    ${net ? `<p>Tassa: €${net}</p>` : ''}
    ${gross ? `<p>Pagato: €${gross}</p>` : ''}`);
});

app.get('/cancel', (req, res) =>
  res.send('<h3>Pagamento annullato ❌</h3><p>Puoi riprovare usando il link ricevuto via email.</p>')
);

/* ─────────── START ─────────── */
app.listen(PORT, () => console.log(`City-tax-service listening on ${PORT}`));
