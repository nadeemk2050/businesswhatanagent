import express from 'express';
import dotenv from 'dotenv';
import axios from 'axios';
import OpenAI from 'openai';
import { GoogleGenerativeAI } from '@google/generative-ai';
import path from 'path';
import { fileURLToPath } from 'url';
import { initializeApp } from "firebase/app";
import { 
  getFirestore, doc, setDoc, getDoc, deleteDoc, collection, 
  addDoc, query, orderBy, getDocs, limit, where 
} from "firebase/firestore";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Firebase Configuration for businesswhatanagent
const firebaseConfig = {
  apiKey: "AIzaSyBR4wTVSfzBEJtbkogCaVYj3lDMbIgWtAc",
  authDomain: "businesswhatanagent.firebaseapp.com",
  databaseURL: "https://businesswhatanagent-default-rtdb.firebaseio.com",
  projectId: "businesswhatanagent",
  storageBucket: "businesswhatanagent.firebasestorage.app",
  messagingSenderId: "923437563558",
  appId: "1:923437563558:web:efbcff305b81a1f2f27e67",
  measurementId: "G-X04L8LZM8R"
};

const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp);

const app = express();
app.use(express.json({ limit: '15mb' }));
app.use(express.static('public', {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html') || filePath.endsWith('sw.js')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  }
}));

// --- Settings Resolver (Firestore first, fallback to .env) ---
let cachedSettings = null;
let lastSettingsFetch = 0;

async function getSettings(force = false) {
  const now = Date.now();
  if (!force && cachedSettings && (now - lastSettingsFetch < 30000)) {
    return cachedSettings;
  }
  try {
    const sDoc = await getDoc(doc(db, "appData", "settings"));
    const data = sDoc.exists() ? sDoc.data() : {};
    cachedSettings = {
      ACTIVE_AI_PROVIDER: data.ACTIVE_AI_PROVIDER || process.env.ACTIVE_AI_PROVIDER || 'deepseek',
      DEEPSEEK_API_KEY: data.DEEPSEEK_API_KEY || process.env.DEEPSEEK_API_KEY || '',
      GEMINI_API_KEY: data.GEMINI_API_KEY || process.env.GEMINI_API_KEY || '',
      WHATSAPP_TOKEN: data.WHATSAPP_TOKEN || process.env.WHATSAPP_TOKEN || '',
      PHONE_NUMBER_ID: data.PHONE_NUMBER_ID || process.env.PHONE_NUMBER_ID || '',
      VERIFY_TOKEN: data.VERIFY_TOKEN || process.env.VERIFY_TOKEN || 'my_whatsapp_agent_verify_token_2026',
      API_VERSION: data.API_VERSION || process.env.API_VERSION || 'v20.0'
    };
    lastSettingsFetch = now;
  } catch (e) {
    cachedSettings = {
      ACTIVE_AI_PROVIDER: process.env.ACTIVE_AI_PROVIDER || 'deepseek',
      DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY || '',
      GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
      WHATSAPP_TOKEN: process.env.WHATSAPP_TOKEN || '',
      PHONE_NUMBER_ID: process.env.PHONE_NUMBER_ID || '',
      VERIFY_TOKEN: process.env.VERIFY_TOKEN || 'my_whatsapp_agent_verify_token_2026',
      API_VERSION: process.env.API_VERSION || 'v20.0'
    };
  }
  return cachedSettings;
}

// --- Health Probe (Used by Render / Uptime monitors to keep service warm) ---
app.get('/healthz', (req, res) => {
  res.json({ ok: true, service: 'businesswhatanagent', role: 'render', uptimeSec: Math.round(process.uptime()) });
});

app.get('/', (req, res) => {
  res.send('Business WhatsApp AI Agent (Meta Cloud API) is active! <br><a href="/admin.html">Go to Admin Dashboard</a>');
});

// --- WhatsApp Graph API Sender ---
async function sendWhatsAppMessage(to, messageText) {
  const settings = await getSettings();
  const token = settings.WHATSAPP_TOKEN;
  const phoneId = settings.PHONE_NUMBER_ID;
  const version = settings.API_VERSION;

  if (!token || !phoneId) {
    console.error('[META API] Missing WHATSAPP_TOKEN or PHONE_NUMBER_ID in settings');
    return { success: false, error: 'Missing token or phone ID' };
  }

  const url = `https://graph.facebook.com/${version}/${phoneId}/messages`;
  try {
    const response = await axios.post(url, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: to.replace(/[^0-9]/g, ''),
      type: 'text',
      text: { body: messageText }
    }, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      timeout: 25000
    });
    console.log(`[META API] Sent message to ${to}:`, response.data);
    return { success: true, data: response.data };
  } catch (error) {
    const errData = error.response ? error.response.data : error.message;
    console.error(`[META API] Failed to send message to ${to}:`, errData);
    return { success: false, error: errData };
  }
}

// --- AI Response Engine (Gemini + DeepSeek with Automatic Fallback) ---
async function generateAIResponse(senderNumber, incomingText) {
  const settings = await getSettings();
  
  // 1. Fetch Knowledge Base
  let kb = {};
  try {
    const kDoc = await getDoc(doc(db, "appData", "knowledge"));
    if (kDoc.exists()) kb = kDoc.data();
  } catch (e) {
    console.warn('[AI] Error fetching knowledge base:', e.message);
  }

  // 2. Fetch Recent Conversation History (Last 15 messages)
  let chatHistory = [];
  try {
    const q = query(collection(db, "chats", senderNumber, "messages"), orderBy("timestamp", "asc"));
    const snap = await getDocs(q);
    chatHistory = snap.docs.map(d => d.data()).slice(-15);
  } catch (e) {
    console.warn('[AI] Error fetching chat history:', e.message);
  }

  // 3. Construct System Prompt
  const systemInstruction = `You are the professional, friendly, and efficient WhatsApp AI Sales Assistant for AL SAHAM AL AHMAR METAL SCRAP TR (a scrap recycling and trading business based in Saja Industrial Area, Sharjah, UAE).

--- COMPANY KNOWLEDGE ---
Company: ${kb.companyProfile || "AL SAHAM AL AHMAR METAL SCRAP TR - Metal and plastic scrap recyclers and traders."}
Timings & Working Hours: ${kb.timings || "7:00 AM to 12:00 PM, then 3:00 PM to 7:00 PM, Saturday to Thursday. Closed on Fridays."}
Location & Branches: ${kb.locationAndBranches || "Main Yard: SAJA INDUSTRIAL AREA, SHARJAH, UAE. Branches: Axiom Polymer (UAQ), Brandspoint LLC, Al Qaryan Industries."}
Google Maps Verification Link: ${kb.googleMapsLink || "https://maps.google.com/?q=Saja+Industrial+Area+Sharjah"}
Scrap Products We Buy & Sell: ${kb.products || "HDPE 100 pipes scrap, PVC pipes scrap, PET scrap, PC scrap, Aluminium ACSR wire scrap, Aluminium Dross scrap, and industrial metal scrap."}
Logistics & Transport: ${kb.logistics || "We offer local UAE transport and sea freight export solutions."}
Special Instructions: ${kb.customRules || "Always greet politely. Be helpful, concise, and professional. For specific daily rates, provide standard estimates or invite them to share quantity details."}
Onboarding / First Message Guideline: ${kb.onboardingPrompt || "Welcome the client warmly to Al Saham Al Ahmar Metal Scrap TR."}

--- OPERATIONAL GUIDELINES ---
- Format your response for WhatsApp: use concise paragraphs, bullet points, and appropriate emojis.
- Never make up fake technical specifications or unauthorized contracts.
- Speak in the language the customer addresses you in (English, Urdu/Hindi, or Arabic).`;

  let reply = "";
  const provider = (settings.ACTIVE_AI_PROVIDER || 'deepseek').toLowerCase();

  // Try DeepSeek first if selected
  if (provider === 'deepseek' && settings.DEEPSEEK_API_KEY) {
    try {
      const openai = new OpenAI({ baseURL: 'https://api.deepseek.com', apiKey: settings.DEEPSEEK_API_KEY, timeout: 30000 });
      const messages = [{ role: 'system', content: systemInstruction }];
      chatHistory.forEach(m => {
        messages.push({ role: m.sender === 'user' ? 'user' : 'assistant', content: m.text || '' });
      });
      messages.push({ role: 'user', content: incomingText });
      
      const completion = await openai.chat.completions.create({
        model: 'deepseek-chat',
        messages: messages,
        max_tokens: 600,
        temperature: 0.7
      });
      reply = completion.choices[0]?.message?.content?.trim() || '';
    } catch (dsErr) {
      console.warn('[AI] DeepSeek attempt failed, falling back to Gemini:', dsErr.message);
    }
  }

  // If reply is still empty, try Gemini (as primary or fallback)
  if (!reply && settings.GEMINI_API_KEY) {
    try {
      const genAI = new GoogleGenerativeAI(settings.GEMINI_API_KEY);
      const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash', systemInstruction: systemInstruction });
      
      const geminiContents = [];
      chatHistory.forEach(m => {
        const role = m.sender === 'user' ? 'user' : 'model';
        geminiContents.push({ role, parts: [{ text: m.text || '' }] });
      });
      geminiContents.push({ role: 'user', parts: [{ text: incomingText }] });

      const result = await model.generateContent({ contents: geminiContents });
      reply = result.response.text().trim();
    } catch (gemErr) {
      console.error('[AI] Gemini attempt also failed:', gemErr.message);
    }
  }

  if (!reply) {
    reply = "Thank you for reaching out to AL SAHAM AL AHMAR METAL SCRAP TR! We have received your inquiry. A representative will get back to you shortly, or you can visit us at Saja Industrial Area, Sharjah.";
  }

  return reply;
}

// ==========================================
// --- META WHATSAPP WEBHOOK ENDPOINTS ---
// ==========================================

// Webhook Verification (Meta handshake)
app.get('/webhook', async (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  const settings = await getSettings();
  const configuredToken = settings.VERIFY_TOKEN;

  if (mode === 'subscribe' && token === configuredToken) {
    console.log('[WEBHOOK] Verified successfully with Meta!');
    res.status(200).send(challenge);
  } else {
    console.warn('[WEBHOOK] Verification failed. Token mismatch.');
    res.sendStatus(403);
  }
});

// Webhook Event Receiver
app.post('/webhook', async (req, res) => {
  // Always return 200 immediately to Meta
  res.sendStatus(200);

  const body = req.body;
  if (!body || body.object !== 'whatsapp_business_account') return;

  try {
    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const messages = value?.messages;

    if (!messages || messages.length === 0) return;

    const msg = messages[0];
    const sender = msg.from; // e.g. "971501234567"
    const msgId = msg.id;
    const timestamp = msg.timestamp ? parseInt(msg.timestamp) * 1000 : Date.now();
    const contactName = value.contacts?.[0]?.profile?.name || sender;

    let incomingText = '';
    if (msg.type === 'text') {
      incomingText = msg.text?.body || '';
    } else if (msg.type === 'interactive') {
      incomingText = msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || '';
    } else if (msg.type === 'location') {
      incomingText = `[Customer shared location: lat ${msg.location?.latitude}, lng ${msg.location?.longitude}]`;
    } else {
      incomingText = `[Customer sent ${msg.type} media]`;
    }

    if (!incomingText) return;

    console.log(`[INCOMING] From ${contactName} (${sender}): "${incomingText}"`);

    // 1. Record incoming message in Firestore
    await setDoc(doc(db, "chats", sender, "messages", msgId), {
      text: incomingText,
      sender: "user",
      timestamp: timestamp,
      id: msgId,
      status: "delivered"
    }, { merge: true });

    // 2. Check or update Contact Record
    const contactRef = doc(db, "contacts", sender);
    const contactSnap = await getDoc(contactRef);
    const contactData = contactSnap.exists() ? contactSnap.data() : {};
    
    await setDoc(contactRef, {
      name: contactData.name || contactName,
      number: sender,
      lastInteraction: timestamp,
      lastMessage: incomingText,
      aiPaused: contactData.aiPaused === true
    }, { merge: true });

    // 3. Check if AI is paused for this contact
    if (contactData.aiPaused === true) {
      console.log(`[AI PAUSED] Skipping auto-reply for ${sender} (human agent mode).`);
      return;
    }

    // 4. Generate AI Reply
    const aiReply = await generateAIResponse(sender, incomingText);

    // 5. Send via WhatsApp Graph API
    const sendResult = await sendWhatsAppMessage(sender, aiReply);

    // 6. Save outgoing message to Firestore
    const outMsgId = sendResult.data?.messages?.[0]?.id || `out_${Date.now()}`;
    await setDoc(doc(db, "chats", sender, "messages", outMsgId), {
      text: aiReply,
      sender: "bot",
      timestamp: Date.now(),
      id: outMsgId,
      status: sendResult.success ? "sent" : "failed"
    }, { merge: true });

  } catch (err) {
    console.error('[WEBHOOK ERROR] Processing failed:', err);
  }
});

// ==========================================
// --- REST ENDPOINTS FOR ADMIN DASHBOARD ---
// ==========================================

// Knowledge Base
app.get('/api/knowledge', async (req, res) => {
  try {
    const kDoc = await getDoc(doc(db, "appData", "knowledge"));
    res.json(kDoc.exists() ? kDoc.data() : {});
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/knowledge', async (req, res) => {
  try {
    await setDoc(doc(db, "appData", "knowledge"), req.body, { merge: true });
    res.json({ success: true, message: 'Knowledge base updated successfully.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Contacts & Chats List
app.get('/api/contacts', async (req, res) => {
  try {
    const snap = await getDocs(collection(db, "contacts"));
    const contacts = {};
    snap.docs.forEach(d => {
      contacts[d.id] = d.data();
    });
    res.json(contacts);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Specific Chat Messages
app.get('/api/chats/:number/messages', async (req, res) => {
  try {
    const { number } = req.params;
    const q = query(collection(db, "chats", number, "messages"), orderBy("timestamp", "asc"));
    const snap = await getDocs(q);
    const messages = snap.docs.map(d => d.data());
    res.json(messages);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Manual Agent Reply from Live Chat
app.post('/api/chats/reply', async (req, res) => {
  try {
    const { number, text } = req.body;
    if (!number || !text) return res.status(400).json({ error: 'Missing number or text' });

    const result = await sendWhatsAppMessage(number, text);
    if (!result.success) return res.status(500).json({ error: result.error });

    const outMsgId = result.data?.messages?.[0]?.id || `manual_${Date.now()}`;
    await setDoc(doc(db, "chats", number, "messages", outMsgId), {
      text: text,
      sender: "bot",
      timestamp: Date.now(),
      id: outMsgId,
      status: "sent",
      manual: true
    }, { merge: true });

    res.json({ success: true, messageId: outMsgId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Toggle AI per customer
app.post('/api/chats/toggleAI', async (req, res) => {
  try {
    const { number, aiPaused } = req.body;
    await setDoc(doc(db, "contacts", number), { aiPaused: Boolean(aiPaused) }, { merge: true });
    res.json({ success: true, aiPaused: Boolean(aiPaused) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Contact Book CRUD
app.get('/api/contactbook', async (req, res) => {
  try {
    const snap = await getDocs(collection(db, "contacts"));
    const contacts = snap.docs.map(d => ({ phone: d.id, ...d.data() }));
    res.json(contacts);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/contactbook', async (req, res) => {
  try {
    const { phone, name, email, address, company, tags, notes } = req.body;
    if (!phone) return res.status(400).json({ error: 'Phone is required' });
    const cleanPhone = phone.replace(/[^0-9]/g, '');
    await setDoc(doc(db, "contacts", cleanPhone), {
      name: name || '',
      email: email || '',
      address: address || '',
      company: company || '',
      tags: tags || [],
      notes: notes || '',
      updatedAt: Date.now()
    }, { merge: true });
    res.json({ success: true, message: 'Contact saved' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/contactbook/:phone', async (req, res) => {
  try {
    await deleteDoc(doc(db, "contacts", req.params.phone));
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Leads Book CRUD
app.get('/api/leads', async (req, res) => {
  try {
    const snap = await getDocs(collection(db, "leads"));
    const leads = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json(leads);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/leads', async (req, res) => {
  try {
    const { phone, name, status, materialInterest, estimatedTonnage, notes } = req.body;
    const leadRef = doc(collection(db, "leads"));
    await setDoc(leadRef, {
      phone: phone || '',
      name: name || '',
      status: status || 'New',
      materialInterest: materialInterest || '',
      estimatedTonnage: estimatedTonnage || '',
      notes: notes || '',
      createdAt: Date.now()
    });
    res.json({ success: true, id: leadRef.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Environment & API Key Settings
app.get('/api/env', async (req, res) => {
  try {
    const settings = await getSettings();
    res.json({
      ACTIVE_AI_PROVIDER: settings.ACTIVE_AI_PROVIDER || 'deepseek',
      DEEPSEEK_API_KEY: settings.DEEPSEEK_API_KEY || '',
      GEMINI_API_KEY: settings.GEMINI_API_KEY || '',
      WHATSAPP_TOKEN: settings.WHATSAPP_TOKEN || '',
      PHONE_NUMBER_ID: settings.PHONE_NUMBER_ID || '',
      VERIFY_TOKEN: settings.VERIFY_TOKEN || ''
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/env', async (req, res) => {
  try {
    const data = req.body;
    const prev = await getSettings();
    const keep = (v, old) => (v !== undefined && v !== null ? v : (old || ''));
    
    await setDoc(doc(db, "appData", "settings"), {
      ACTIVE_AI_PROVIDER: keep(data.ACTIVE_AI_PROVIDER, prev.ACTIVE_AI_PROVIDER),
      DEEPSEEK_API_KEY: keep(data.DEEPSEEK_API_KEY, prev.DEEPSEEK_API_KEY),
      GEMINI_API_KEY: keep(data.GEMINI_API_KEY, prev.GEMINI_API_KEY),
      WHATSAPP_TOKEN: keep(data.WHATSAPP_TOKEN, prev.WHATSAPP_TOKEN),
      PHONE_NUMBER_ID: keep(data.PHONE_NUMBER_ID, prev.PHONE_NUMBER_ID),
      VERIFY_TOKEN: keep(data.VERIFY_TOKEN, prev.VERIFY_TOKEN)
    }, { merge: true });

    cachedSettings = null; // force reload
    res.json({ success: true, message: 'Settings saved successfully.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Start Server ---
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Business WhatsApp AI Agent (Meta Cloud API) running on port ${PORT}`);
});
