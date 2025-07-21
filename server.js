require('dotenv').config();

const express  = require('express');
const path     = require('path');
const mongoose = require('mongoose');
const session  = require('express-session');
const flash    = require('connect-flash');
const passport = require('passport');
const venom    = require('venom-bot');
const fetch    = globalThis.fetch || require('node-fetch');

const PORT         = process.env.PORT || 3000;
const SESSION_NAME = 'session-name';

// ── Mongo & Passport ──
require('./config/passport')(passport);
mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser:    true,
  useUnifiedTopology: true
})
.then(() => console.log('✅ MongoDB connected'))
.catch(err => console.error('❌ MongoDB error:', err));

// ── App & Global State ──
const app = express();
let aiConfig     = { businessName:'', industry:'', instructions:'' };
let qrCodeBase64 = null;
const sessions   = {};

// ── DeepSeek helper ── (unchanged)
async function askDeepSeek(userInput, conversationHistory = []) {
  if (!aiConfig.businessName) {
    return '🤖 Please complete the setup form at /setup before chatting.';
  }

  const systemPrompt =
    `You are a WhatsApp assistant for the *${aiConfig.industry}* business named *${aiConfig.businessName}*.\n`
    + aiConfig.instructions;

  const messages = [
    { role:'system',  content: systemPrompt },
    ...conversationHistory,
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

// ── Express setup ──
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

// ── Routes ──
app.use('/',     require('./routes/index'));
app.use('/auth', require('./routes/auth'));
const { ensureAuthenticated } = require('./middleware/auth');

app.get('/setup', ensureAuthenticated, (req, res) => {
  res.render('wizard', { title: 'Configure Your Bot' });
});

app.post('/setup', ensureAuthenticated, (req, res) => {
  aiConfig.businessName = req.body.businessName.trim();
  aiConfig.industry     = req.body.industry;
  aiConfig.instructions = req.body.instructions.trim();
  res.redirect('/setup');
});

// ── Start Venom, then bind Express ──
venom.create(
  {
    session:     SESSION_NAME,
    multidevice: true,
    headless:    'new',
    logQR:       true,
    browserArgs: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage'
    ]
  },
  // QR callback
  (base64Qrimg, asciiQR) => {
    qrCodeBase64 = base64Qrimg.replace(/^data:image\/png;base64,/, '');
    console.log('🔄 New QR — scan or refresh /setup\n', asciiQR);
  }
)
.then(client => {
  console.log('✅ Venom is ready');
  // **Bind to 0.0.0.0** so Render’s proxy can reach you
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server listening on http://0.0.0.0:${PORT}`);
  });

  client.onStateChange(state => {
    console.log('⚙️  Venom state:', state);
    if (['CONFLICT','UNPAIRED','UNLAUNCHED'].includes(state)) {
      client.useHere();
      console.log('🔄 Session reclaimed');
    }
  });

  client.onMessage(async msg => {
    const jid = msg.from;
    const txt = msg.body?.trim();
    if (!txt) return;

    const sess = sessions[jid] = sessions[jid] || { conversationHistory: [] };
    sess.conversationHistory.push({ role:'user', content:txt });

    const reply = await askDeepSeek(txt, sess.conversationHistory);
    await client.sendText(jid, reply);

    sess.conversationHistory.push({ role:'assistant', content:reply });
    if (sess.conversationHistory.length > 20) {
      sess.conversationHistory = sess.conversationHistory.slice(-16);
    }
  });
})
.catch(err => {
  console.error('❌ Venom init failed:', err.message || err);
  // start Express anyway, so /setup still works
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server (no WhatsApp) listening on http://0.0.0.0:${PORT}`);
  });
});
