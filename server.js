// server.js
require('dotenv').config();

const express  = require('express');
const path     = require('path');
const mongoose = require('mongoose');
const session  = require('express-session');
const flash    = require('connect-flash');
const passport = require('passport');
const venom    = require('venom-bot');
const fsExtra  = require('fs-extra');
const dayjs    = require('dayjs');
const fetch    = globalThis.fetch || require('node-fetch');

const SESSION_NAME = 'session-name';
const BOOK_FILE    = 'bookings.json';
const REVIEW_LINK  = 'https://vayaride.com/review';

// Passport config
require('./config/passport')(passport);

// Connect to MongoDB
mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB error:', err));

const app = express();

// — Global state —
let qrCodeBase64 = null;
let aiConfig = {
  businessName: '',
  industry:     '',
  instructions: ''
};
const sessions = {}; // per-JID conversation history

// — DeepSeek helper —
async function askDeepSeek(userInput, conversationHistory = []) {
  const systemPrompt = aiConfig.businessName && aiConfig.industry && aiConfig.instructions
    ? `You are a WhatsApp assistant for the *${aiConfig.industry}* business named *${aiConfig.businessName}*.\n${aiConfig.instructions}`
    : `You are a ride-booking assistant for VayaRide. Collect details and generate a receipt then ask for a review: ${REVIEW_LINK}`;

  const messages = [
    { role: 'system', content: systemPrompt },
    ...conversationHistory,
    { role: 'user',   content: userInput }
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
      console.error(`DeepSeek error ${res.status}:`, await res.text());
      return 'Sorry, DeepSeek is having trouble.';
    }

    const data = await res.json();
    return data.choices?.[0]?.message?.content.trim() || '…';
  } catch (e) {
    console.error('DeepSeek fetch error:', e);
    return 'Sorry, an error occurred.';
  }
}

// — Booking persistence —
fsExtra.ensureFileSync(BOOK_FILE);
if (!fsExtra.readJsonSync(BOOK_FILE, { throws: false })) {
  fsExtra.writeJsonSync(BOOK_FILE, [], { spaces: 2 });
}
function saveBooking(data) {
  const arr = fsExtra.readJsonSync(BOOK_FILE, { throws: false }) || [];
  const entry = {
    ...data,
    id:        `VR-${Date.now().toString().slice(-6)}`,
    timestamp: dayjs().toISOString()
  };
  arr.push(entry);
  fsExtra.writeJsonSync(BOOK_FILE, arr, { spaces: 2 });
  return entry;
}
function extractBookingData(text) {
  const lines = text.split('\n');
  const data = {};
  lines.forEach(line => {
    if (line.includes('Name:')) {
      const v = line.split('Name:')[1].trim();
      if (v && v !== '—') {
        const parts = v.split(' ');
        data.firstName = parts.shift();
        data.surname   = parts.join(' ');
      }
    }
    if (line.includes('Email:')) {
      const v = line.split('Email:')[1].trim();
      if (v && v !== '—') data.email = v;
    }
    if (line.includes('Phone:')) {
      const v = line.split('Phone:')[1].trim();
      if (v && v !== '—') data.phone = v;
    }
    if (line.includes('From:')) {
      const v = line.split('From:')[1].split('To:')[0].trim();
      if (v) data.pickup = v;
    }
    if (line.includes('To:')) {
      const v = line.split('To:')[1].trim();
      if (v) data.destination = v;
    }
    if (line.includes('When:')) {
      const v = line.split('When:')[1].trim();
      if (v) data.datetime = v;
    }
  });
  return Object.keys(data).length ? data : null;
}

// — Express & middleware —
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'keyboard cat',
  resave: false,
  saveUninitialized: false
}));
app.use(passport.initialize());
app.use(passport.session());
app.use(flash());

// expose locals to all views
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

// — Routes —
app.use('/',    require('./routes/index'));
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

// — Venom‑bot + DeepSeek integration —
venom
  .create(
    {
      session: SESSION_NAME,
      multidevice: true,
      headless: 'new',
      browserArgs: ['--no-sandbox']
    },
    (base64Qrimg) => {
      qrCodeBase64 = base64Qrimg.replace(/^data:image\/png;base64,/, '');
      console.log('🔄 New QR generated — refresh /setup to view it');
    }
  )
  .then(client => {
    console.log('✅ Venom bot is ready');

    client.onStateChange(state => {
      console.log('🔄 Venom state:', state);
      if (['CONFLICT','UNPAIRED','UNLAUNCHED'].includes(state)) {
        client.useHere();
        console.log('🔄 Reclaimed session with useHere()');
      }
    });

    client.onMessage(async msg => {
      console.log('📩 Received:', msg.body, 'from', msg.from);
      const jid  = msg.from;
      const text = msg.body?.trim();
      if (!text) return console.log('⚠️ Empty message, skipping');

      sessions[jid] = sessions[jid] || { conversationHistory: [] };
      const sess = sessions[jid];

      sess.conversationHistory.push({ role:'user', content:text });
      console.log('📝 History length:', sess.conversationHistory.length);

      let reply;
      try {
        reply = await askDeepSeek(text, sess.conversationHistory);
      } catch (e) {
        console.error('❌ askDeepSeek error:', e);
        reply = 'Sorry, something went wrong.';
      }

      console.log('🤖 Reply:', reply);
      try {
        await client.sendText(jid, reply);
        console.log('✅ Reply sent');
      } catch (e) {
        console.error('❌ Failed to send reply:', e);
      }

      sess.conversationHistory.push({ role:'assistant', content:reply });

      if (reply.includes('VAYARIDE BOOKING RECEIPT') && reply.includes('CONFIRMED')) {
        const data = extractBookingData(reply);
        if (data) {
          saveBooking(data);
          console.log('💾 Booking saved:', data);
        }
        setTimeout(() => delete sessions[jid], 5000);
      }

      if (sess.conversationHistory.length > 20) {
        sess.conversationHistory = sess.conversationHistory.slice(-16);
      }
    });
  })
  .catch(err => console.error('❌ Venom init failed:', err));

// — Start HTTP server —
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running at http://localhost:${PORT}`));
