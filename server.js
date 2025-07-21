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

// ————— Constants —————
const PORT         = process.env.PORT || 3000;
const SESSION_NAME = 'session-name';
const TOKENS_DIR   = path.join(__dirname, 'tokens');
const CHROME_PATH  = process.env.CHROME_PATH || (
  process.platform === 'win32'
    ? 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
    : '/usr/bin/chromium-browser'
);

// ————— Global State —————
let qrCodeBase64 = null;
let aiConfig     = { businessName:'', industry:'', instructions:'' };
const sessions   = {}; // per‑JID conversation history

// ————— Mongo & Passport —————
require('./config/passport')(passport);
mongoose
  .connect(process.env.MONGO_URI)
  .then(()=> console.log('✅ MongoDB connected'))
  .catch(e=> console.error('❌ MongoDB error:', e));

// ————— DeepSeek helper —————
async function askDeepSeek(userInput, conversationHistory = []) {
  if (!aiConfig.businessName) {
    return '🤖 Please complete setup at /setup first.';
  }

  const systemPrompt = `
You are a WhatsApp assistant for the *${aiConfig.industry}* business named *${aiConfig.businessName}*.
${aiConfig.instructions}
  `.trim();

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
      console.error('DeepSeek HTTP', res.status, await res.text());
      return '😓 DeepSeek is unavailable right now.';
    }
    const { choices } = await res.json();
    return choices?.[0]?.message?.content.trim() || '…';
  } catch (err) {
    console.error('DeepSeek error:', err);
    return '😓 Error contacting DeepSeek.';
  }
}

// ————— Express setup —————
const app = express();
app.use(express.urlencoded({ extended:false }));
app.use(express.static(path.join(__dirname,'public')));
app.use(session({
  secret:            process.env.SESSION_SECRET || 'keyboard cat',
  resave:            false,
  saveUninitialized: false
}));
app.use(passport.initialize());
app.use(passport.session());
app.use(flash());

// expose to all EJS views
app.use((req,res,next)=>{
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

app.set('view engine','ejs');
app.set('views', path.join(__dirname,'views'));

// ————— Routes & Setup Wizard —————
app.use('/',     require('./routes/index'));
app.use('/auth', require('./routes/auth'));
const { ensureAuthenticated } = require('./middleware/auth');

app.get('/setup', ensureAuthenticated, (req,res)=> {
  res.render('wizard', { title:'Configure Your Bot' });
});
app.post('/setup', ensureAuthenticated, (req,res)=> {
  aiConfig.businessName = req.body.businessName.trim();
  aiConfig.industry     = req.body.industry;
  aiConfig.instructions = req.body.instructions.trim();
  res.redirect('/setup');
});

// ————— Start Express Server NOW —————
app.listen(PORT, () => {
  console.log(`🚀 HTTP server listening on http://localhost:${PORT}`);
});

// ————— Initialize Venom *after* server is up —————
venom.create(
  {
    session:         SESSION_NAME,
    multidevice:     true,
    headless:        'new',      // use the new headless mode
    useChrome:       true,
    executablePath:  CHROME_PATH,
    sessionDataPath: TOKENS_DIR,
    browserArgs: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu'
    ]
  },
  base64Qrimg => {
    qrCodeBase64 = base64Qrimg.replace(/^data:image\/png;base64,/, '');
    console.log('🔄 New QR generated — refresh your dashboard to scan');
  }
)
.then(client => {
  console.log('✅ Venom bot ready');

  client.onStateChange(state => {
    console.log('⚙️ Venom state:', state);
    if (['CONFLICT','UNPAIRED','UNLAUNCHED'].includes(state)) {
      client.useHere();
      console.log('🔄 Session reclaimed with useHere()');
    }
  });

  client.onMessage(async msg => {
    const jid  = msg.from;
    const text = msg.body?.trim();
    if (!text) return;

    console.log(`📩 Message from ${jid}: ${text}`);
    // initialize history
    sessions[jid] = sessions[jid] || { conversationHistory: [] };
    const sess = sessions[jid];

    sess.conversationHistory.push({ role:'user', content: text });
    const reply = await askDeepSeek(text, sess.conversationHistory);

    try {
      await client.sendText(jid, reply);
      console.log(`✅ Replied to ${jid}`);
    } catch (e) {
      console.error('❌ sendText failed:', e);
    }

    sess.conversationHistory.push({ role:'assistant', content: reply });
    // keep last 20 messages
    if (sess.conversationHistory.length > 20) {
      sess.conversationHistory = sess.conversationHistory.slice(-20);
    }
  });
})
.catch(err => {
  console.error('❌ Venom init failed:', err);
  // Note: Express is still up, so you can still hit /setup and dashboard
});
