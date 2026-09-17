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

// --- Meta Media Downloader & Multimodal Gemini Audio Transcriber ---
async function downloadAndTranscribeMetaAudio(audioId, mimeType, settings) {
  const token = settings.WHATSAPP_TOKEN;
  const version = settings.API_VERSION || 'v20.0';
  if (!token || !audioId) {
    throw new Error('Missing token or audioId for audio transcription');
  }

  console.log(`[AUDIO] Fetching media metadata for ID ${audioId}...`);
  // 1. Get media URL from Meta Graph API
  const metaMediaUrl = `https://graph.facebook.com/${version}/${audioId}`;
  const metaRes = await axios.get(metaMediaUrl, {
    headers: { Authorization: `Bearer ${token}` }
  });

  const downloadUrl = metaRes.data?.url;
  if (!downloadUrl) throw new Error('Could not retrieve media download URL from Meta');

  console.log(`[AUDIO] Downloading audio stream from Meta CDN...`);
  // 2. Download audio binary
  const audioRes = await axios.get(downloadUrl, {
    headers: { Authorization: `Bearer ${token}` },
    responseType: 'arraybuffer'
  });
  const audioBuffer = Buffer.from(audioRes.data);

  // 3. Transcribe using Google Gemini (supports multimodal audio natively)
  if (!settings.GEMINI_API_KEY) {
    console.warn('[AUDIO] No GEMINI_API_KEY configured for audio transcription');
    return null;
  }

  console.log(`[AUDIO] Transcribing audio with Google Gemini (${audioBuffer.length} bytes)...`);
  const genAI = new GoogleGenerativeAI(settings.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
  const cleanMime = (mimeType || 'audio/ogg').split(';')[0].trim();

  const prompt = `You are an expert multilingual audio transcriber for a scrap metal & plastic recycling business in Sharjah, UAE (Al Saham Al Ahmar Metal Scrap TR).
Listen to this voice message sent by a customer on WhatsApp. 
The customer may speak in English, Urdu, Hindi, Arabic, Punjabi, or a mix of these languages.
Transcribe what the person is saying accurately into readable text. 
If they ask about scrap materials, buying, selling, prices, yard location, or contact persons, ensure all details are captured verbatim.
Output ONLY the transcribed words. Do not include any explanations, disclaimers, or quotation marks.`;

  const result = await model.generateContent([
    {
      inlineData: {
        data: audioBuffer.toString('base64'),
        mimeType: cleanMime
      }
    },
    { text: prompt }
  ]);

  const transcription = result.response.text().trim();
  console.log(`[AUDIO] Transcribed successfully: "${transcription}"`);
  return transcription;
}

// --- Universal LLM Caller (DeepSeek / Gemini with Failover) ---
async function callLLM(prompt, systemInstruction = "You are an AI assistant for Al Saham Al Ahmar Metal Scrap TR.") {
  const settings = await getSettings();
  const provider = (settings.ACTIVE_AI_PROVIDER || 'deepseek').toLowerCase();

  // Try DeepSeek if selected
  if (provider === 'deepseek' && settings.DEEPSEEK_API_KEY) {
    try {
      const openai = new OpenAI({ baseURL: 'https://api.deepseek.com', apiKey: settings.DEEPSEEK_API_KEY, timeout: 30000 });
      const completion = await openai.chat.completions.create({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: systemInstruction },
          { role: 'user', content: prompt }
        ],
        temperature: 0.7
      });
      const text = completion.choices[0]?.message?.content?.trim();
      if (text) return text;
    } catch (e) {
      console.warn('[callLLM] DeepSeek failed, falling back to Gemini:', e.message);
    }
  }

  // Gemini as primary or fallback
  if (settings.GEMINI_API_KEY) {
    try {
      const genAI = new GoogleGenerativeAI(settings.GEMINI_API_KEY);
      const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash', systemInstruction });
      const res = await model.generateContent(prompt);
      const text = res.response.text().trim();
      if (text) return text;
    } catch (e) {
      console.error('[callLLM] Gemini failed:', e.message);
    }
  }

  // DeepSeek fallback if Gemini was primary and failed
  if (provider === 'gemini' && settings.DEEPSEEK_API_KEY) {
    try {
      const openai = new OpenAI({ baseURL: 'https://api.deepseek.com', apiKey: settings.DEEPSEEK_API_KEY, timeout: 30000 });
      const completion = await openai.chat.completions.create({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: systemInstruction },
          { role: 'user', content: prompt }
        ],
        temperature: 0.7
      });
      return completion.choices[0]?.message?.content?.trim();
    } catch (e) {
      console.error('[callLLM] Secondary DeepSeek failed:', e.message);
    }
  }

  throw new Error('No AI provider succeeded. Check your API keys in Settings.');
}

// --- AI Response Engine (Gemini + DeepSeek with Automatic Fallback & Rich Knowledge) ---
async function generateAIResponse(senderNumber, incomingText, isVoiceNote = false) {
  const settings = await getSettings();
  
  // 1. Fetch Knowledge Base
  let kb = {};
  try {
    const kDoc = await getDoc(doc(db, "appData", "knowledge"));
    if (kDoc.exists()) kb = kDoc.data();
  } catch (e) {
    console.warn('[AI] Error fetching knowledge base:', e.message);
  }

  // Format FAQs (Q&A Knowledge Manager)
  let faqsText = "";
  if (Array.isArray(kb.faqs) && kb.faqs.length > 0) {
    faqsText = "\n--- FREQUENTLY ASKED QUESTIONS (Q&A KNOWLEDGE BASE) ---\n" +
      kb.faqs.map((f, i) => `Q${i+1}: ${f.question}\nA${i+1}: ${f.answer}`).join("\n\n");
  }

  // Format Product Catalog (Inventory & Capacities)
  let catalogText = "";
  if (Array.isArray(kb.catalog) && kb.catalog.length > 0) {
    catalogText = "\n--- PRODUCT & INVENTORY CATALOG (CURRENT SCRAP RATES & CAPACITIES) ---\n" +
      kb.catalog.map(p => `- Product: ${p.name || 'Material'} | Available Qty: ${p.qty || 'Inquire'} | Approx Rate: ${p.rate || 'Market Rate'} | Buying Capacity: ${p.buyCap || 'Flexible'} | Selling Capacity: ${p.sellCap || 'Flexible'}${p.comments ? ` | Notes: "${p.comments}"` : ''}`).join("\n");
  }

  const brandVoice = kb.aiPersona?.brandVoice || "Friendly & Supportive (Uses Emojis)";
  const fallbackLogic = kb.aiPersona?.fallbackLogic || "Share Team Contacts: Nadeem (+971529244592), Farhan (+971554779240), Obaidullah (+971527455831)";

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
  const systemInstruction = `You are the professional, friendly, and efficient WhatsApp AI Sales Assistant for AL SAHAM AL AHMAR METAL SCRAP TR (a leading scrap recycling and trading business based in Saja Industrial Area, Sharjah, UAE).

--- BRAND VOICE & PERSONA ---
Tone & Style: ${brandVoice}
Fallback Protocol (When you don't know the exact answer or deal terms): ${fallbackLogic}

--- COMPANY KNOWLEDGE ---
Company: ${kb.companyProfile || "AL SAHAM AL AHMAR METAL SCRAP TR - Metal and plastic scrap recyclers and traders."}
Timings & Working Hours: ${kb.timings || "7:00 AM to 12:00 PM, then 3:00 PM to 7:00 PM, Saturday to Thursday. Closed on Fridays."}
Location & Branches: ${kb.locationAndBranches || "Main Yard: SAJA INDUSTRIAL AREA, SHARJAH, UAE. Branches: Axiom Polymer (UAQ), Brandspoint LLC, Al Qaryan Industries."}
Google Maps Verification Link: ${kb.googleMapsLink || "https://maps.google.com/?q=Saja+Industrial+Area+Sharjah"}
Scrap Products We Buy & Sell: ${kb.products || "HDPE 100 pipes scrap, PVC pipes scrap, PET scrap, PC scrap, Aluminium ACSR wire scrap, Aluminium Dross scrap, and industrial metal scrap."}
Logistics & Transport: ${kb.logistics || "We offer local UAE transport and sea freight export solutions."}
Special Instructions: ${kb.customRules || "Always greet politely. Be helpful, concise, and professional. For specific daily rates, provide standard estimates or invite them to share quantity details."}
Onboarding / First Message Guideline: ${kb.onboardingPrompt || "Welcome the client warmly to Al Saham Al Ahmar Metal Scrap TR."}
${faqsText}
${catalogText}

--- OPERATIONAL GUIDELINES ---
- Format your response for WhatsApp: use concise paragraphs, bullet points, and appropriate emojis.
- If the customer sent an audio/voice note (marked with 🎤), acknowledge that you listened to their voice note warmly, and respond directly to their inquiry.
- When customers ask questions answered in the Q&A knowledge base, match that answer accurately.
- When customers ask for rates or capacities, refer to the Product & Inventory Catalog.
- When contact persons are requested, give the direct contacts: Nadeem (+971529244592), Farhan (+971554779240), and Obaidullah (+971527455831).
- Never make up fake technical specifications or unauthorized contract commitments.
- Speak naturally in the language the customer addresses you in (English, Urdu/Hindi, Arabic, or Punjabi).`;

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

// Webhook Event Receiver (Processes Text, Voice Notes/Audio, and Interactive)
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
    let isVoiceNote = false;

    if (msg.type === 'text') {
      incomingText = msg.text?.body || '';
    } else if (msg.type === 'audio' || msg.type === 'voice') {
      isVoiceNote = true;
      const audioObj = msg.audio || msg.voice;
      const audioId = audioObj?.id;
      const mimeType = audioObj?.mime_type || 'audio/ogg';
      console.log(`[AUDIO INCOMING] From ${sender}, media ID: ${audioId}, mime: ${mimeType}`);

      try {
        const settings = await getSettings();
        const transcription = await downloadAndTranscribeMetaAudio(audioId, mimeType, settings);
        if (transcription) {
          incomingText = `🎤 [Voice Note]: "${transcription}"`;
        } else {
          incomingText = `🎤 [Customer sent a Voice Note. Please acknowledge receipt and assist them with scrap buying, selling, or company information.]`;
        }
      } catch (audioErr) {
        console.error('[AUDIO ERROR] Could not transcribe voice note:', audioErr.message);
        incomingText = `🎤 [Customer sent a Voice Note. Please acknowledge their voice message warmly and ask for details about their requirement.]`;
      }
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
      status: "delivered",
      isVoiceNote: isVoiceNote
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
    const aiReply = await generateAIResponse(sender, incomingText, isVoiceNote);

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

// Quick AI Provider Switcher (DeepSeek vs Gemini)
app.post('/api/set-ai-provider', async (req, res) => {
  try {
    const { provider } = req.body;
    if (!provider || !['deepseek', 'gemini'].includes(provider.toLowerCase())) {
      return res.status(400).json({ error: 'Invalid provider. Must be "deepseek" or "gemini".' });
    }
    await setDoc(doc(db, "appData", "settings"), {
      ACTIVE_AI_PROVIDER: provider.toLowerCase()
    }, { merge: true });
    cachedSettings = null; // Flush cache
    console.log(`[AI PROVIDER] Switched active provider to: ${provider}`);
    res.json({ success: true, provider: provider.toLowerCase() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// AI Suggestion: Persona & Fallback Logic
app.post('/api/ai/suggest-persona', async (req, res) => {
  try {
    const prompt = `Al Saham Al Ahmar Metal Scrap TR is an established scrap trading and recycling business in Saja Industrial Area, Sharjah, UAE.
We trade HDPE pipes, PVC pipe scrap, iron HMS, aluminium, and industrial plastics.
Recommend the ideal "brandVoice" and "fallbackLogic" for our WhatsApp AI assistant to maximize trust and conversion.
Choose or Brand Voices: "Friendly & Supportive (Uses Emojis)", "Professional & Formal (Concise)", "Sales-Focused & Persuasive".
Fallback Logic: "Ask for email/number for follow-up", "Share Team Contacts: Nadeem (+971529244592), Farhan (+971554779240), Obaidullah (+971527455831)".

Return ONLY a valid JSON object in this exact shape without markdown code blocks:
{
  "brandVoice": "Friendly & Supportive (Uses Emojis)",
  "fallbackLogic": "Share Team Contacts: Nadeem (+971529244592), Farhan (+971554779240), Obaidullah (+971527455831)"
}`;

    const raw = await callLLM(prompt, "You are an expert conversational AI designer. Output only raw JSON, no markdown fences.");
    const cleaned = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    res.json(parsed);
  } catch (err) {
    console.warn('[SUGGEST PERSONA ERROR]', err.message);
    res.json({
      brandVoice: "Friendly & Supportive (Uses Emojis)",
      fallbackLogic: "Share Team Contacts: Nadeem (+971529244592), Farhan (+971554779240), Obaidullah (+971527455831)"
    });
  }
});

// AI Suggestion: Auto-Generate 5 FAQs
app.post('/api/ai/generate-faqs', async (req, res) => {
  try {
    const prompt = `Generate 5 realistic, high-value FAQ pairs for Al Saham Al Ahmar Metal Scrap TR (scrap metal & plastic recycling business in Saja Industrial Area, Sharjah, UAE).
Company details:
- Scrap bought: HDPE100 pipes scrap, PVC pipe scrap, Iron HMS scrap, Aluminium ACSR, window profile scrap.
- Key contacts: Nadeem +971529244592, Farhan +971554779240, Obaidullah +971527455831.
- Location: Saja Industrial Area, Sharjah. Branches in Umm Al Quwain & Karachi.
- Logistics: Local transport and sea export containers available.
- Timings: 7 AM to 12 PM and 3 PM to 7 PM, Sat to Thu. Closed Fridays.

Include diverse, real-world customer questions like scrap buying mission, who to meet, UBC beverage cans policy, delivery options, and payment/weighbridge terms.

Return ONLY a valid JSON array of 5 objects with keys "question" and "answer", without markdown code blocks:
[
  { "question": "...", "answer": "..." }
]`;

    const raw = await callLLM(prompt, "You are a scrap trading consultant. Output only raw JSON array.");
    const cleaned = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
    const faqs = JSON.parse(cleaned);
    res.json(Array.isArray(faqs) ? faqs : []);
  } catch (err) {
    console.error('[GENERATE FAQS ERROR]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// AI Suggestion: Auto-Suggest Product Details
app.post('/api/ai/suggest-product', async (req, res) => {
  try {
    const { productName } = req.body;
    const name = productName || "Copper Wire Scrap";
    const prompt = `Suggest realistic inventory specifications for scrap trading product: "${name}" in the UAE/GCC market.
Return realistic values for:
- "availableQty": (e.g. "20 MTONS APPROX" or "10 TONS" or "5,000 kg")
- "approxRate": (e.g. "2100 DHS PER TON" or "750 DHS LAST WEEK" or "2100-2200 AED/TON")
- "buyCapacity": (e.g. "50 TONS" or "100 TONS/mo")
- "sellCapacity": (e.g. "50 TONS" or "100 TONS/mo")
- "comments": (Material notes, e.g. "Clean sorted material, baled or loose, yard inspection welcomed.")

Return ONLY a valid JSON object with these keys without markdown code fences:
{
  "availableQty": "...",
  "approxRate": "...",
  "buyCapacity": "...",
  "sellCapacity": "...",
  "comments": "..."
}`;

    const raw = await callLLM(prompt, "You are a scrap materials pricing and inventory specialist. Output only raw JSON object.");
    const cleaned = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
    res.json(JSON.parse(cleaned));
  } catch (err) {
    console.error('[SUGGEST PRODUCT ERROR]', err.message);
    res.status(500).json({ error: err.message });
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
