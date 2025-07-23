// server.js
require('dotenv').config();

const express      = require('express');
const path         = require('path');
const mongoose     = require('mongoose');
const session      = require('express-session');
const MongoStore   = require('connect-mongo');
const flash        = require('connect-flash');
const passport     = require('passport');
const venom        = require('venom-bot');
const fetch        = globalThis.fetch || require('node-fetch');

const CHROME_PATH  = process.env.CHROME_PATH
  || 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';

//
// — Passport & MongoDB —
//
require('./config/passport')(passport);
mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser:    true,
  useUnifiedTopology: true
})
.then(() => console.log('✅ MongoDB connected'))
.catch(e => console.error('❌ MongoDB error:', e));

//
// — Multi-session state —
//
const app = express();
let aiConfig = { businessName:'', industry:'', instructions:'' };

// Store multiple WhatsApp sessions
const whatsappSessions = new Map(); // sessionId -> { client, qrCode, status, chatSessions }
let currentSessionId = null; // Currently active session for setup

//
// — DeepSeek helper —
//
async function askDeepSeek(userInput, history = []) {
  if (!aiConfig.businessName) {
    return '🤖 Please complete the setup form at /setup first.';
  }
  const systemPrompt = `
You are a WhatsApp assistant for the *${aiConfig.industry}* business named *${aiConfig.businessName}*.
${aiConfig.instructions}
  `.trim();
  const messages = [
    { role:'system',  content: systemPrompt },
    ...history,
    { role:'user',    content: userInput }
  ];
  try {
    const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method:'POST',
      headers:{
        Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
        'Content-Type':  'application/json'
      },
      body: JSON.stringify({
        model:       'deepseek-chat',
        temperature: 0.7,
        messages
      })
    });
    if (!res.ok) {
      console.error('DeepSeek error', res.status, await res.text());
      return '😓 DeepSeek is unavailable.';
    }
    const { choices } = await res.json();
    return choices?.[0]?.message?.content.trim() || '…';
  } catch (err) {
    console.error('DeepSeek fetch error:', err);
    return '😓 Something went wrong.';
  }
}

//
// — Create new WhatsApp session —
//
async function createWhatsAppSession(sessionId) {
  if (whatsappSessions.has(sessionId)) {
    console.log(`⚠️ Session ${sessionId} already exists`);
    return whatsappSessions.get(sessionId);
  }

  console.log(`🔄 Creating new WhatsApp session: ${sessionId}`);
  
  const sessionData = {
    client: null,
    qrCode: null,
    status: 'initializing',
    chatSessions: {} // jid -> { history: [] }
  };

  whatsappSessions.set(sessionId, sessionData);

  try {
    const client = await venom.create(
      {
        session: sessionId,
        multidevice: true,
        headless: 'new',
        puppeteerOptions: {
          executablePath: CHROME_PATH,
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu'
          ]
        }
      },
      (base64Qrimg) => {
        sessionData.qrCode = base64Qrimg.replace(/^data:image\/png;base64,/, '');
        sessionData.status = 'qr_ready';
        console.log(`🔄 QR generated for session ${sessionId}`);
      },
      undefined,
      {
        logQR: true,
        disableWelcome: true,
        autoClose: false,
        qrRefreshS: 20,
        qrTimeout: 300
      }
    );

    sessionData.client = client;
    sessionData.status = 'connected';
    console.log(`✅ Session ${sessionId} is ready`);

    // Handle state changes
    client.onStateChange(state => {
      console.log(`⚙️ Session ${sessionId} state:`, state);
      sessionData.status = state.toLowerCase();
      
      if (['CONFLICT','UNPAIRED','UNLAUNCHED'].includes(state)) {
        client.useHere();
        console.log(`🔄 Reclaimed session ${sessionId}`);
      }
    });

    // Handle incoming messages
    client.onMessage(async msg => {
      const jid = msg.from;
      const text = msg.body?.trim();
      if (!text) return;

      // Initialize chat session if doesn't exist
      if (!sessionData.chatSessions[jid]) {
        sessionData.chatSessions[jid] = { history: [] };
      }
      
      const chatSession = sessionData.chatSessions[jid];
      chatSession.history.push({ role:'user', content: text });
      
      const reply = await askDeepSeek(text, chatSession.history);

      try {
        await client.sendText(jid, reply);
        console.log(`✅ Session ${sessionId} replied to ${jid}`);
      } catch (e) {
        console.error(`❌ Session ${sessionId} sendText error:`, e);
      }

      chatSession.history.push({ role:'assistant', content: reply });
      
      // Keep history manageable
      if (chatSession.history.length > 20) {
        chatSession.history = chatSession.history.slice(-16);
      }
    });

    return sessionData;

  } catch (err) {
    console.error(`❌ Failed to create session ${sessionId}:`, err);
    sessionData.status = 'error';
    sessionData.error = err.message;
    return sessionData;
  }
}

//
// — Express & middleware —
//
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  name: 'admin-session',
  secret: process.env.SESSION_SECRET || 'keyboard cat',
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({ mongoUrl: process.env.MONGO_URI })
}));
app.use(passport.initialize());
app.use(passport.session());
app.use(flash());

app.use((req, res, next) => {
  res.locals.user = req.user;
  res.locals.success_msg = req.flash('success_msg');
  res.locals.error_msg = req.flash('error_msg');
  res.locals.error = req.flash('error');
  res.locals.businessName = aiConfig.businessName;
  res.locals.industry = aiConfig.industry;
  res.locals.instructions = aiConfig.instructions;
  
  // Pass session data to views
  res.locals.whatsappSessions = Array.from(whatsappSessions.entries()).map(([id, data]) => ({
    id,
    status: data.status,
    qrCode: data.qrCode,
    error: data.error,
    connectedChats: Object.keys(data.chatSessions).length
  }));
  
  next();
});

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

//
// — Routes & API —
//
app.use('/', require('./routes/index'));
app.use('/auth', require('./routes/auth'));
const { ensureAuthenticated } = require('./middleware/auth');

// Main setup page
app.get('/setup', ensureAuthenticated, (req, res) => {
  res.render('wizard', { 
    title: 'Configure Your Bot',
    currentSessionId
  });
});

// Update bot configuration
app.post('/setup', ensureAuthenticated, async (req, res) => {
  aiConfig.businessName = req.body.businessName.trim();
  aiConfig.industry = req.body.industry;
  aiConfig.instructions = req.body.instructions.trim();
  
  req.flash('success_msg', 'Bot configuration updated successfully!');
  res.redirect('/setup');
});

// Create new WhatsApp session
app.post('/whatsapp/create', ensureAuthenticated, async (req, res) => {
  const sessionId = `whatsapp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  try {
    currentSessionId = sessionId;
    await createWhatsAppSession(sessionId);
    req.flash('success_msg', `New WhatsApp session created: ${sessionId}`);
  } catch (error) {
    req.flash('error_msg', `Failed to create session: ${error.message}`);
  }
  
  res.redirect('/setup');
});

// Get QR code for specific session
app.get('/whatsapp/:sessionId/qr', ensureAuthenticated, (req, res) => {
  const { sessionId } = req.params;
  const sessionData = whatsappSessions.get(sessionId);
  
  if (!sessionData || !sessionData.qrCode) {
    return res.status(404).json({ error: 'QR code not available' });
  }
  
  res.json({ qrCode: sessionData.qrCode, status: sessionData.status });
});

// Delete WhatsApp session
app.delete('/whatsapp/:sessionId', ensureAuthenticated, async (req, res) => {
  const { sessionId } = req.params;
  const sessionData = whatsappSessions.get(sessionId);
  
  if (sessionData && sessionData.client) {
    try {
      await sessionData.client.logout();
      await sessionData.client.close();
      console.log(`🔔 Session ${sessionId} logged out and closed`);
    } catch (e) {
      console.error(`⚠️ Error closing session ${sessionId}:`, e);
    }
  }
  
  whatsappSessions.delete(sessionId);
  
  if (currentSessionId === sessionId) {
    currentSessionId = null;
  }
  
  req.flash('success_msg', `Session ${sessionId} deleted successfully`);
  res.json({ success: true });
});

// Get session status
app.get('/whatsapp/:sessionId/status', ensureAuthenticated, (req, res) => {
  const { sessionId } = req.params;
  const sessionData = whatsappSessions.get(sessionId);
  
  if (!sessionData) {
    return res.status(404).json({ error: 'Session not found' });
  }
  
  res.json({
    sessionId,
    status: sessionData.status,
    connectedChats: Object.keys(sessionData.chatSessions).length,
    hasQrCode: !!sessionData.qrCode,
    error: sessionData.error
  });
});

//
// — Start HTTP server —
//
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log('📱 Ready to handle multiple WhatsApp sessions');
});