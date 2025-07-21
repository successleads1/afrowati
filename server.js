// server.js
require('dotenv').config();

const express  = require('express');
const path     = require('path');
const mongoose = require('mongoose');
const session  = require('express-session');
const flash    = require('connect-flash');
const passport = require('passport');
const venom    = require('venom-bot');
const fetch    = globalThis.fetch || require('node-fetch');

// ── Constants ───────────────────────────────────────────────────────────────────
const PORT         = process.env.PORT || 3000;
const SESSION_NAME = 'session-name';

// ── Mongo & Passport setup ─────────────────────────────────────────────────────
require('./config/passport')(passport);
mongoose
  .connect(process.env.MONGO_URI, {
    useNewUrlParser:    true,
    useUnifiedTopology: true
  })
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB error:', err));

// ── App & Global State ─────────────────────────────────────────────────────────
const app         = express();
let   aiConfig    = { businessName:'', industry:'', instructions:'' };
let   qrCodeBase64= null;
const sessions    = {};  // per‑JID message history

// ── DeepSeek helper ─────────────────────────────────────────────────────────────
async function askDeepSeek(userInput, history = []) {
  if (!aiConfig.businessName) {
    return '🤖 Please complete the setup form at /setup before chatting.';
  }

  const systemPrompt = 
    `You are a WhatsApp assistant for the *${aiConfig.industry}* business named *${aiConfig.businessName}*.\n`
    + aiConfig.instructions;

  const messages = [
    { role:'system',  content: systemPrompt },
    ...history,
    { role:'user',    content: userInput }
  ];

  try {
    const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model:       'deepseek-chat',
        temperature: 0.7,
        messages
      })
    });
    if (!res.ok) {
      console.error('DeepSeek error', res.status, await res.text());
      return '😓 DeepSeek is not available right now.';
    }
    const data = await res.json();
    return data.choices?.[0]?.message?.content.trim() || '…';
  } catch (e) {
    console.error('DeepSeek fetch error:', e);
    return '😓 Something went wrong.';
  }
}

// ── Express middleware ─────────────────────────────────────────────────────────
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret:            process.env.SESSION_SECRET || 'keyboard cat',
  resave:            false,
  saveUninitialized: false
}));
app.use(passport.initialize());
app.use(passport.session());
app.use(flash());

// Expose common locals to all EJS views
app.use((req, res, next) => {
  res.locals.user         = req.user;
  res.locals.success_msg  = req.flash('success_msg');
  res.locals.error_msg    = req.flash('error_msg');
  res.locals.error        = req.flash('error');
  res.locals.qr           = qrCodeBase64;
  res.locals.businessName = aiConfig.businessName;
  res.locals.industry     = aiConfig.industry;
  res.locals.instructions = aiConfig.instructions;
  next();
});

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ── Routes ──────────────────────────────────────────────────────────────────────
app.use('/',     require('./routes/index'));
app.use('/auth', require('./routes/auth'));
const { ensureAuthenticated } = require('./middleware/auth');

app.get('/setup', ensureAuthenticated, (req, res) => {
  res.render('wizard', { title:'Configure Your Bot' });
});
app.post('/setup', ensureAuthenticated, (req, res) => {
  aiConfig.businessName = req.body.businessName.trim();
  aiConfig.industry     = req.body.industry;
  aiConfig.instructions = req.body.instructions.trim();
  res.redirect('/setup');
});

// ── Venom + HTTP bootstrap ────────────────────────────────────────────────────
venom
  .create(
    {
      session:     SESSION_NAME,
      multidevice: true,
      headless:    'new',
      browserArgs: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage'
      ]
    },
    // QR callback: base64 + an ASCII fallback
    (base64Qrimg, asciiQR) => {
      qrCodeBase64 = base64Qrimg.replace(/^data:image\/png;base64,/, '');
      console.log('🔄 New QR — scan me!\n', asciiQR);
    }
  )
  .then(client => {
    console.log('✅ Venom is ready');

    // 1) Start your HTTP server *inside* the .then
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`🚀 Server listening on http://0.0.0.0:${PORT}`);
    });

    // 2) Re‑claim on state conflict
    client.onStateChange(state => {
      console.log('⚙️  Venom state:', state);
      if (['CONFLICT','UNPAIRED','UNLAUNCHED'].includes(state)) {
        client.useHere();
        console.log('🔄 Session reclaimed');
      }
    });

    // 3) Handle inbound WhatsApp messages
    client.onMessage(async msg => {
      const jid = msg.from;
      const txt = msg.body?.trim();
      if (!txt) return;

      const sess = sessions[jid] ||= { conversationHistory: [] };
      sess.conversationHistory.push({ role:'user',      content:txt });
      const reply = await askDeepSeek(txt, sess.conversationHistory);
      await client.sendText(jid, reply);
      sess.conversationHistory.push({ role:'assistant', content:reply });

      // Keep only the last 20 messages
      if (sess.conversationHistory.length > 20) {
        sess.conversationHistory = sess.conversationHistory.slice(-16);
      }
    });
  })
  .catch(err => {
    console.error('❌ Venom init failed:', err.message || err);
    // Even if Venom fails, we still spin up Express so /setup is reachable
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`🚀 Server listening (no WhatsApp) on http://0.0.0.0:${PORT}`);
    });
  });
