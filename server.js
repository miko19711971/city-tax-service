// server.js — City Tax Service (net-to-gross fees)

const express = require('express');
const Stripe  = require('stripe');
const axios   = require('axios');

const app = express();

/* ─────────── ENV ─────────── */
const PORT     = process.env.PORT || 10000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

const STRIPE_SECRET_KEY    = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const PAYPAL_ME_USERNAME   = process.env.PAYPAL_ME_USERNAME || 'MicheleB496';
const HOSTAWAY_TOKEN       = process.env.HOSTAWAY_TOKEN || '';
const CONFIRM_SECRET       = process.env.CONFIRM_SECRET || 'niceflatrome';

// Tariffe (netto desiderato = guests * nights * rate)
const RATE_LEONINA  = parseFloat(process.env.RATE_LEONINA_EUR  || 6);
const RATE_STANDARD = parseFloat(process.env.RATE_STANDARD_EUR || 5);

// Commissioni PROCESSORI
const STRIPE_FEE_PCT = parseFloat(process.env.STRIPE_FEE_PCT || 0.014);
const STRIPE_FEE_FIX = parseFloat(process.env.STRIPE_FEE_FIX_EUR || 0.25);
const PAYPAL_FEE_PCT = parseFloat(process.env.PAYPAL_FEE_PCT || 0.059);
const PAYPAL_FEE_FIX = parseFloat(process.env.PAYPAL_FEE_FIX_EUR || 0.35);

/* ─────────── Stripe SDK ─────────── */
const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

/* ─────────── HELPERS ─────────── */
const toEur = n => Number((+n).toFixed(2));
const getRate = (listing) =>
  String(listing).toLowerCase() === 'leonina' ? RATE_LEONINA : RATE_STANDARD;

function grossForNet(net, feePct, feeFix) {
  if (net <= 0) return 0;
  const raw = (net + feeFix) / (1 - feePct);
  return Math.ceil(raw * 100) / 100;
}

/* ─────────── HOSTAWAY HELPERS ─────────── */
async function findHostawayReservation(channelReservationId) {
  if (!HOSTAWAY_TOKEN || !channelReservationId) return null;
  try {
    const r = await axios.get(
      `https://api.hostaway.com/v1/reservations?channelReservationId=${encodeURIComponent(channelReservationId)}&limit=1`,
      { headers: { Authorization: `Bearer ${HOSTAWAY_TOKEN}` }, timeout: 10000 }
    );
    return r.data?.result?.[0] || null;
  } catch (e) {
    console.error('❌ findHostawayReservation:', e.message);
    return null;
  }
}

async function getConversationId(reservationId) {
  if (!HOSTAWAY_TOKEN || !reservationId) return null;
  try {
    const r = await axios.get(
      `https://api.hostaway.com/v1/conversations?reservationId=${reservationId}&limit=1`,
      { headers: { Authorization: `Bearer ${HOSTAWAY_TOKEN}` }, timeout: 10000 }
    );
    return r.data?.result?.[0]?.id || null;
  } catch (e) {
    console.error('❌ getConversationId:', e.message);
    return null;
  }
}

async function sendHostawayMessage(conversationId, message) {
  if (!HOSTAWAY_TOKEN || !conversationId) return false;
  try {
    await axios.post(
      `https://api.hostaway.com/v1/conversations/${conversationId}/messages`,
      { body: message, sendToGuest: true },
      { headers: { Authorization: `Bearer ${HOSTAWAY_TOKEN}`, 'Content-Type': 'application/json' }, timeout: 10000 }
    );
    console.log('📨 Messaggio Hostaway inviato, conversationId:', conversationId);
    return true;
  } catch (e) {
    console.error('❌ sendHostawayMessage:', e.message);
    return false;
  }
}

async function sendHostawayInternalNote(conversationId, message) {
  if (!HOSTAWAY_TOKEN || !conversationId) return;
  try {
    await axios.post(
      `https://api.hostaway.com/v1/conversations/${conversationId}/messages`,
      { body: message, isFromHost: 1, sendToGuest: false },
      { headers: { Authorization: `Bearer ${HOSTAWAY_TOKEN}`, 'Content-Type': 'application/json' }, timeout: 10000 }
    );
  } catch (e) {
    console.error('❌ sendHostawayInternalNote:', e.message);
  }
}

async function notifyCityTaxPaid({ channelReservationId, provider, amountGross, amountNet, guestName }) {
  const reservation = await findHostawayReservation(channelReservationId);
  if (!reservation) {
    console.warn(`⚠️ notifyCityTaxPaid: prenotazione non trovata per res=${channelReservationId}`);
    return false;
  }
  const conversationId = await getConversationId(reservation.id || reservation.reservationId);
  if (!conversationId) {
    console.warn(`⚠️ notifyCityTaxPaid: conversazione non trovata per res=${channelReservationId}`);
    return false;
  }

  const lang = (reservation.guestLanguage || reservation.guestLocale || 'en').toLowerCase();
  const langMap = { spanish:'es', french:'fr', italian:'it', german:'de', english:'en',
                    deutsch:'de', italiano:'it', español:'es' };
  const l = langMap[lang.split(',')[0].trim()] || lang.slice(0, 2) || 'en';

  const msgs = {
    en: `✅ City tax payment confirmed!\n\nWe have received your payment of €${amountGross.toFixed(2)} via ${provider}. The city tax is now settled — thank you!\n\nKind regards,\nMichele`,
    it: `✅ Pagamento tassa di soggiorno confermato!\n\nAbbiamo ricevuto il tuo pagamento di €${amountGross.toFixed(2)} tramite ${provider}. La tassa di soggiorno è ora saldata — grazie!\n\nCordiali saluti,\nMichele`,
    fr: `✅ Paiement de la taxe de séjour confirmé !\n\nNous avons reçu votre paiement de €${amountGross.toFixed(2)} via ${provider}. La taxe de séjour est maintenant réglée — merci !\n\nCordialement,\nMichele`,
    de: `✅ Kurtaxe-Zahlung bestätigt!\n\nWir haben Ihre Zahlung von €${amountGross.toFixed(2)} über ${provider} erhalten. Die Kurtaxe ist nun beglichen — vielen Dank!\n\nMit freundlichen Grüßen,\nMichele`,
    es: `✅ ¡Pago de la tasa turística confirmado!\n\nHemos recibido su pago de €${amountGross.toFixed(2)} a través de ${provider}. La tasa turística está ahora saldada — ¡gracias!\n\nAtentamente,\nMichele`,
  };

  const guestMsg  = msgs[l] || msgs.en;
  const hostNote  = `💰 Tassa soggiorno pagata — ${guestName || reservation.guestName || 'Ospite'} | ${provider} | €${amountGross.toFixed(2)} (netto €${amountNet.toFixed(2)}) | res:${channelReservationId}`;

  await sendHostawayMessage(conversationId, guestMsg);
  await sendHostawayInternalNote(conversationId, hostNote);
  return true;
}

/* ─────────── ROUTES ─────────── */
app.get('/', (req, res) => res.send('<h3>city-tax-service ✅</h3>'));
app.get('/health', (req, res) => res.json({ ok: true, service: 'city-tax-service' }));

/* ─────────── STRIPE CHECKOUT ─────────── */
app.get('/pay/stripe', async (req, res) => {
  const {
    listing = 'standard',
    guests = 1,
    nights = 1,
    res: reservationId = ''
  } = req.query;

  const rate      = getRate(listing);
  const baseNet   = toEur(Number(guests) * Number(nights) * rate);
  if (!baseNet || baseNet <= 0) return res.status(400).send('Invalid amount.');

  const totalGross = toEur(grossForNet(baseNet, STRIPE_FEE_PCT, STRIPE_FEE_FIX));

  if (!stripe) return res.status(500).send('Stripe not configured.');

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      currency: 'eur',
      line_items: [{
        quantity: 1,
        price_data: {
          currency: 'eur',
          unit_amount: Math.round(totalGross * 100),
          product_data: {
            name: 'Tourist Tax (City Tax)',
            description: reservationId
              ? `Reservation ${reservationId} — net €${baseNet.toFixed(2)}`
              : `Net €${baseNet.toFixed(2)}`
          }
        }
      }],
      metadata: {
        reservationId,
        listing,
        guests: String(guests),
        nights: String(nights),
        net: baseNet.toFixed(2)
      },
      success_url: `${BASE_URL}/success?res=${encodeURIComponent(reservationId)}&net=${baseNet.toFixed(2)}&gross=${totalGross.toFixed(2)}&provider=stripe`,
      cancel_url:  `${BASE_URL}/cancel?res=${encodeURIComponent(reservationId)}`
    });

    return res.redirect(303, session.url);
  } catch (err) {
    console.error('Stripe error:', err?.message || err);
    return res.status(500).send('Stripe checkout creation failed.');
  }
});

/* ─────────── STRIPE WEBHOOK ─────────── */
app.post('/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('❌ Stripe webhook firma non valida:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  res.json({ received: true }); // risposta immediata a Stripe

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const meta    = session.metadata || {};
    const channelReservationId = meta.reservationId || '';
    const amountGross = (session.amount_total || 0) / 100;
    const amountNet   = parseFloat(meta.net || 0);

    console.log(`💳 Stripe pagato: res=${channelReservationId} gross=€${amountGross} net=€${amountNet}`);

    if (channelReservationId) {
      await notifyCityTaxPaid({
        channelReservationId,
        provider: 'Stripe',
        amountGross,
        amountNet,
        guestName: session.customer_details?.name || ''
      });
    }
  }
});

/* ─────────── PAYPAL.ME REDIRECT ─────────── */
app.get('/pay/paypal', (req, res) => {
  const { listing = 'standard', guests = 1, nights = 1 } = req.query;
  const rate      = getRate(listing);
  const baseNet   = toEur(Number(guests) * Number(nights) * rate);
  if (!baseNet || baseNet <= 0) return res.status(400).send('Invalid amount.');
  const totalGross = toEur(grossForNet(baseNet, PAYPAL_FEE_PCT, PAYPAL_FEE_FIX));
  return res.redirect(302, `https://www.paypal.me/${PAYPAL_ME_USERNAME}/${totalGross.toFixed(2)}`);
});

/* ─────────── PAYPAL CONFIRM (manuale, solo per te) ─────────── */
app.get('/confirm-paypal', (req, res) => {
  const { secret = '', res: reservationId = '', amount = '' } = req.query;
  if (secret !== CONFIRM_SECRET) return res.status(403).send('Accesso negato.');

  res.send(`<!doctype html><html lang="it"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Conferma PayPal</title>
<style>*{box-sizing:border-box}body{margin:0;background:#120d09;color:#f5ead8;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}
.card{max-width:400px;width:100%;background:rgba(255,255,255,.05);border-radius:16px;padding:28px}
h2{margin:0 0 20px;font-size:20px;color:#d6b06d}label{display:block;font-size:13px;color:#b7a894;margin-bottom:6px}
input{width:100%;padding:12px;background:rgba(255,255,255,.08);border:1px solid rgba(214,176,109,.3);border-radius:10px;color:#f5ead8;font-size:15px;margin-bottom:16px}
button{width:100%;padding:14px;background:linear-gradient(135deg,#e8c67a,#c89a48);color:#120d09;font-weight:700;font-size:15px;border:none;border-radius:12px;cursor:pointer}
</style></head><body><div class="card">
<h2>💙 Conferma pagamento PayPal</h2>
<form method="POST" action="/confirm-paypal">
  <input type="hidden" name="secret" value="${secret}">
  <label>ID Prenotazione (channel_reservation_id)</label>
  <input type="text" name="reservationId" value="${reservationId}" placeholder="es. 74831194163" required>
  <label>Importo incassato (€ lordi)</label>
  <input type="number" step="0.01" name="amountGross" value="${amount}" placeholder="es. 63.58" required>
  <label>Importo netto (€)</label>
  <input type="number" step="0.01" name="amountNet" placeholder="es. 60.00" required>
  <button type="submit">✅ Conferma e invia messaggio Hostaway</button>
</form>
</div></body></html>`);
});

app.post('/confirm-paypal', express.urlencoded({ extended: false }), async (req, res) => {
  const { secret, reservationId, amountGross, amountNet } = req.body;
  if (secret !== CONFIRM_SECRET) return res.status(403).send('Accesso negato.');
  if (!reservationId || !amountGross) return res.status(400).send('Dati mancanti.');

  const ok = await notifyCityTaxPaid({
    channelReservationId: reservationId,
    provider: 'PayPal',
    amountGross: parseFloat(amountGross),
    amountNet: parseFloat(amountNet || 0),
    guestName: ''
  });

  res.send(`<!doctype html><html lang="it"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Conferma PayPal</title>
<style>body{margin:0;background:#120d09;color:#f5ead8;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px;text-align:center}
.card{max-width:360px}.icon{font-size:52px;margin-bottom:16px}h2{color:#d6b06d}p{color:#b7a894}
a{display:inline-block;margin-top:20px;background:rgba(214,176,109,.15);border:1px solid rgba(214,176,109,.4);color:#d6b06d;padding:12px 24px;border-radius:10px;text-decoration:none;font-weight:700}</style>
</head><body><div class="card">
<div class="icon">${ok ? '✅' : '❌'}</div>
<h2>${ok ? 'Messaggio inviato!' : 'Errore'}</h2>
<p>${ok ? `Hostaway notificato per prenotazione ${reservationId} — PayPal €${parseFloat(amountGross).toFixed(2)}` : 'Prenotazione non trovata o errore Hostaway. Controlla i log.'}</p>
<a href="/confirm-paypal?secret=${secret}">← Nuova conferma</a>
</div></body></html>`);
});

/* ─────────── ESITI ─────────── */
app.get('/success', (req, res) => {
  const { res: reservationId = '', net = '', gross = '', provider = '' } = req.query;
  res.send(`<h3>Payment received ✅</h3>
    ${reservationId ? `<p>Reservation: ${reservationId}</p>` : ''}
    ${provider ? `<p>Provider: ${provider}</p>` : ''}
    ${net ? `<p>Net expected: €${net}</p>` : ''}
    ${gross ? `<p>Charged gross: €${gross}</p>` : ''}`);
});

app.get('/cancel', (req, res) => res.send('<h3>Payment canceled</h3>'));

/* ─────────── START ─────────── */
app.listen(PORT, () => console.log(`City-tax-service listening on ${PORT}`));
