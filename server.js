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
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(() => console.log('✅ MongoDB connected'))
.catch(err => console.error('❌ MongoDB error:', err));

// ── App & Global State ──
const app = express();
let aiConfig     = { businessName:'', industry:'', instructions:'' };
let qrCodeBase64 = null;
const sessions   = {};

// ── DeepSeek Helper ── (unchanged)
// ...

// ── Express Setup ──
app.use(express.urlencoded({ extended:false }));
app.use(express.static(path.join(__dirname,'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'keyboard cat',
  resave: false,
  saveUninitialized: false
}));
app.use(passport.initialize());
app.use(passport.session());
app.use(flash());
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

// ── Routes ──
app.use('/',     require('./routes/index'));
app.use('/auth', require('./routes/auth'));
const { ensureAuthenticated } = require('./middleware/auth');
app.get('/setup', ensureAuthenticated, (req,res)=> res.render('wizard',{ title:'Configure Your Bot' }));
app.post('/setup', ensureAuthenticated, (req,res)=>{
  aiConfig.businessName = req.body.businessName.trim();
  aiConfig.industry     = req.body.industry;
  aiConfig.instructions = req.body.instructions.trim();
  res.redirect('/setup');
});

// ── Start Venom *then* Server ──
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
  // QR callback: first arg is always the Base64 PNG
  (base64Qrimg, asciiQR) => {
    qrCodeBase64 = base64Qrimg.replace(/^data:image\/png;base64,/, '');
    console.log('🔄 New QR generated! ASCII fallback:\n', asciiQR);
  }
)
.then(client => {
  console.log('✅ Venom is ready');
  // Now start Express
  app.listen(PORT, () => console.log(`🚀 Server listening on http://localhost:${PORT}`));

  client.onStateChange(state => {
    console.log('⚙️  Venom state:', state);
    if (['CONFLICT','UNPAIRED','UNLAUNCHED'].includes(state)) {
      client.useHere();
      console.log('🔄 Session reclaimed');
    }
  });

  client.onMessage(async msg => {
    const jid  = msg.from;
    const txt  = msg.body?.trim();
    if (!txt) return;
    const sess = sessions[jid] = sessions[jid] || { conversationHistory: [] };
    sess.conversationHistory.push({ role:'user', content: txt });
    const reply = await askDeepSeek(txt, sess.conversationHistory);
    await client.sendText(jid, reply);
    sess.conversationHistory.push({ role:'assistant', content:reply });
    if (sess.conversationHistory.length > 20)
      sess.conversationHistory = sess.conversationHistory.slice(-16);
  });
})
.catch(err => {
  console.error('❌ Venom init failed:', err.message || err);
  // Still start the server so /setup works
  app.listen(PORT, () => console.log(`🚀 Server listening (no WhatsApp) on http://localhost:${PORT}`));
});
