const express = require('express');
const cors = require('cors');
const twilio = require('twilio');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

const PORT = process.env.PORT || 3000;

// ── System prompts ─────────────────────────────────────
const PROMPTS = {
  roofing: {
    name: 'Peak Roofing Co.',
    greeting: "Hi, thanks for calling Peak Roofing. I'm a virtual assistant available 24 hours a day. I can help with storm damage, free inspections, or insurance questions. How can I help you today?",
    prompt: `You are a friendly professional phone receptionist for Peak Roofing Co., a South Florida roofing company. Keep responses SHORT — 2-3 sentences max. NEVER use markdown, asterisks, or special formatting — plain speech only. Find out what they need, collect their FULL NAME and CALLBACK PHONE NUMBER, and let them know a specialist will call back. When you have name and phone include [LEAD:collected]. Never quote prices. NEVER say you are an AI unless directly asked.`
  },
  hvac: {
    name: 'Fire & Ice HVAC',
    greeting: "Hi, thanks for calling Fire and Ice HVAC. I'm a virtual assistant available around the clock. I can help with AC repairs, new systems, or maintenance. What can I help you with today?",
    prompt: `You are a friendly professional phone receptionist for Fire & Ice HVAC, a South Florida heating and cooling company. Keep responses SHORT — 2-3 sentences max. NEVER use markdown, asterisks, or special formatting — plain speech only. Find out if it's an emergency, collect FULL NAME and CALLBACK PHONE NUMBER and address. When you have name and phone include [LEAD:collected]. Never quote prices. NEVER say you are an AI unless directly asked.`
  },
  wallace: {
    name: 'Wallace Fitness Center',
    greeting: "Hi, thanks for calling Wallace Fitness Center! I'm a virtual assistant — I can help you learn about our programs, answer questions, or get you set up with a free consultation. What can I do for you today?",
    prompt: `You are a warm, encouraging phone receptionist for Wallace Fitness Center in Delmont, PA. Phone: (724) 433-6155. Services: Personal Training, Group Training, Nutrition Coaching, Adapted Training, Silver Sneakers, Open Gym 24/7. Keep responses SHORT — 2-3 sentences max. Find out their fitness goals, match them to the right program, collect FULL NAME and CALLBACK PHONE NUMBER. Emphasize the free consultation. When you have name and phone include [LEAD:collected]. Never quote prices. NEVER say you are an AI unless directly asked.`
  },
  bridgeai: {
    name: 'Bridge AI',
    greeting: "Hi, thanks for calling Bridge AI. I'm a virtual assistant. We build custom AI agents for businesses that capture leads 24/7. How can I help you today?",
    prompt: `You are a friendly phone receptionist for Bridge AI, a company that builds custom AI agents for businesses. Keep responses SHORT — 2-3 sentences max. NEVER use markdown, asterisks, or special formatting — plain speech only. Find out what kind of business they have, collect FULL NAME, CALLBACK PHONE NUMBER, and business type. When you have name and phone include [LEAD:collected]. NEVER say you are an AI unless directly asked.`
  }
};

// ── Storage ────────────────────────────────────────────
const activeCalls = {};
const pendingLeads = {};
const activeTimers = {};
const audioCache = {};
let audioCounter = 0;

// ── ElevenLabs TTS ─────────────────────────────────────
async function generateAudio(text, client) {
  const elevenKey = (process.env.ELEVENLABS_API_KEY || '').trim();
  if (!elevenKey) return null;

  const voiceIds = {
    wallace: process.env.VOICE_WALLACE || '9BWtsMINqrJLrRacOk9x',
    roofing: process.env.VOICE_ROOFING || 'aMSt68OGf4xUZAnLpTU8',
    hvac: process.env.VOICE_HVAC || 'aMSt68OGf4xUZAnLpTU8',
    bridgeai: process.env.VOICE_BRIDGEAI || 'aMSt68OGf4xUZAnLpTU8'
  };
  const voiceId = voiceIds[client] || 'aMSt68OGf4xUZAnLpTU8';

  try {
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'xi-api-key': elevenKey,
        'Accept': 'audio/mpeg'
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_turbo_v2',
        voice_settings: { stability: 0.2, similarity_boost: 0.9, style: 0.6, use_speaker_boost: true }
      })
    });
    if (!response.ok) throw new Error('ElevenLabs ' + response.status);
    const buffer = Buffer.from(await response.arrayBuffer());
    const id = 'a' + (++audioCounter);
    audioCache[id] = buffer;
    setTimeout(() => delete audioCache[id], 10 * 60 * 1000);
    return id;
  } catch (err) {
    console.error('ElevenLabs error:', err.message);
    return null;
  }
}

async function sayWithVoice(twiml, text, client, host) {
  const audioId = await generateAudio(text, client);
  if (audioId && host) {
    twiml.play(`https://${host}/audio/${audioId}`);
  } else {
    twiml.say({ voice: 'Polly.Joanna-Neural' }, text);
  }
}

// ── Serve audio ────────────────────────────────────────
app.get('/audio/:id', (req, res) => {
  const buf = audioCache[req.params.id];
  if (!buf) return res.status(404).send('Not found');
  res.set('Content-Type', 'audio/mpeg');
  res.send(buf);
});

// ── Inbound call ───────────────────────────────────────
app.post('/voice/:client', async (req, res) => {
  const client = req.params.client;
  const config = PROMPTS[client];
  const callSid = req.body.CallSid;
  const host = req.get('host');

  if (!config) {
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say('Sorry, this number is not configured.');
    return res.type('text/xml').send(twiml.toString());
  }

  activeCalls[callSid] = { client, history: [] };

  const twiml = new twilio.twiml.VoiceResponse();
  const gather = twiml.gather({
    input: 'speech',
    action: `/voice/${client}/respond`,
    method: 'POST',
    speechTimeout: '1',
    speechModel: 'phone_call',
    enhanced: true,
    language: 'en-US',
    actionOnEmptyResult: true
  });

  await sayWithVoice(gather, config.greeting, client, host);
  gather.pause({ length: 1 });
  twiml.redirect(`/voice/${client}`);

  res.type('text/xml').send(twiml.toString());
});

// ── Response handler ───────────────────────────────────
app.post('/voice/:client/respond', async (req, res) => {
  const client = req.params.client;
  const config = PROMPTS[client];
  const callSid = req.body.CallSid;
  const speechResult = req.body.SpeechResult || '';
  const host = req.get('host');

  const call = activeCalls[callSid] || { client, history: [] };
  activeCalls[callSid] = call;
  call.history.push({ role: 'user', content: speechResult });

  const twiml = new twilio.twiml.VoiceResponse();

  try {
    const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim();
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 256,
        system: config.prompt,
        messages: call.history
      })
    });

    const data = await response.json();
    if (data.error) throw new Error(data.error.message);

    let reply = data.content[0].text;
    const leadCollected = reply.includes('[LEAD:collected]');
    reply = reply.replace('[LEAD:collected]', '').trim();
    // Strip markdown for voice
    reply = reply.replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*(.+?)\*/g, '$1').replace(/#{1,6}\s/g, '').replace(/\n+/g, ' ').trim();
    call.history.push({ role: 'assistant', content: reply });

    if (leadCollected) {
      const sessionKey = callSid;
      if (activeTimers[sessionKey]) clearTimeout(activeTimers[sessionKey]);
      pendingLeads[sessionKey] = { history: [...call.history], client };
      activeTimers[sessionKey] = setTimeout(() => {
        if (pendingLeads[sessionKey]) {
          captureVoiceLead(pendingLeads[sessionKey].history, pendingLeads[sessionKey].client);
          delete pendingLeads[sessionKey];
        }
        delete activeTimers[sessionKey];
        delete activeCalls[callSid];
      }, 60 * 1000);
    }

    const gather = twiml.gather({
      input: 'speech',
      action: `/voice/${client}/respond`,
      method: 'POST',
      speechTimeout: '1',
      speechModel: 'phone_call',
      enhanced: true,
      language: 'en-US',
      actionOnEmptyResult: true
    });
    await sayWithVoice(gather, reply, client, host);

  } catch (err) {
    console.error('Response error:', err.message);
    twiml.say({ voice: 'Polly.Joanna-Neural' }, 'Sorry, I had a technical issue. Please call back shortly. Thank you!');
  }

  res.type('text/xml').send(twiml.toString());
});

// ── Missed call SMS ────────────────────────────────────
app.post('/voice/:client/missed', async (req, res) => {
  const client = req.params.client;
  const callerPhone = req.body.From || req.body.Caller;

  const messages = {
    roofing: `Hi! You called Peak Roofing but we missed you. Our AI can help right now at mybridgeai.com — or we'll call you back shortly!`,
    hvac: `Hi! You called Fire & Ice HVAC but we missed you. For AC emergencies our AI can help now at mybridgeai.com!`,
    wallace: `Hi! You called Wallace Fitness but we missed you. Our AI assistant can answer questions and set up your free consultation right now at wallacefitnesscenter.com!`,
    bridgeai: `Hi! You called Bridge AI but we missed you. Check out a live demo at mybridgeai.com or we'll call you back shortly!`
  };

  try {
    const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    await twilioClient.messages.create({
      body: messages[client] || messages.bridgeai,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: callerPhone
    });
    console.log(`Missed call SMS sent to ${callerPhone}`);
  } catch (err) {
    console.error('SMS error:', err.message);
  }

  res.sendStatus(200);
});

// ── Lead capture ───────────────────────────────────────
async function captureVoiceLead(history, client) {
  const config = PROMPTS[client];
  const allText = history.map(m => m.content).join('\n');
  const assistantText = history.filter(m => m.role === 'assistant').map(m => m.content).join('\n');

  let name = 'Not captured';
  const skipWords = /^(there|you|me|sir|mam|friend|sure|yes|no|ok|well|it|that|this|question|help|hi|hello|hey)$/i;
  const confirmedName = assistantText.match(/(?:thank you|thanks|great)[,!]?\s+([A-Za-z][a-z]+(?:\s+[A-Za-z][a-z]+)?)[,!\.]/i);
  if (confirmedName && !skipWords.test(confirmedName[1])) name = confirmedName[1];

  const phoneMatch = allText.match(/\d*?(\(?\d{3}\)?[\s\-.]?\d{3}[\s\-.]?\d{4})/);
  const phone = phoneMatch ? phoneMatch[1] : 'Not captured';

  let project = 'Voice call inquiry';
  const userMessages = history.filter(m => m.role === 'user').map(m => m.content);
  const serviceKeywords = /train|fitness|weight|muscle|lose|gain|workout|gym|nutrition|coach|silver|adapt|injury|health|roof|damage|insurance|inspection|ac|hvac|cool|heat/i;
  for (const msg of userMessages) {
    if (serviceKeywords.test(msg) && msg.length > 8) { project = msg.slice(0, 120).trim(); break; }
  }

  const timestamp = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  const snippet = history.map(m => `${m.role === 'user' ? (name !== 'Not captured' ? name : 'Caller') : config.name}: ${m.content}`).join('\n\n');
  const lead = { name, phone, project, timestamp, snippet };

  console.log('Voice lead:', lead.name, lead.phone, lead.project);

  // Email
  try {
    const resendKey = (process.env.RESEND_API_KEY || '').trim();
    const recipients = [process.env.GMAIL_USER, process.env.CLIENT_EMAIL].filter(Boolean);
    const names = { bridgeai: 'Bridge AI', roofing: 'Peak Roofing Co.', hvac: 'Fire & Ice HVAC', wallace: 'Wallace Fitness Center' };
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + resendKey },
      body: JSON.stringify({
        from: 'Bridge AI <leads@mybridgeai.com>',
        to: recipients,
        subject: `📞 New Voice Lead — ${names[client] || client}: ${lead.name} | ${lead.phone}`,
        html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;"><div style="background:#211F58;padding:20px;border-radius:8px 8px 0 0;"><h2 style="color:#A0A09F;margin:0;">📞 New Voice Lead — ${names[client] || client}</h2></div><div style="background:#f9f9f9;padding:24px;border:1px solid #e0e0e0;"><p><b>Name:</b> ${lead.name}</p><p><b>Phone:</b> <a href="tel:${lead.phone}">${lead.phone}</a></p><p><b>Inquiry:</b> ${lead.project}</p><p><b>Time:</b> ${lead.timestamp}</p><hr/><h3>Conversation</h3><pre style="background:#fff;padding:12px;border:1px solid #ddd;border-radius:4px;font-size:12px;white-space:pre-wrap;">${lead.snippet}</pre></div><div style="background:#211F58;padding:10px 20px;border-radius:0 0 8px 8px;text-align:center;"><p style="color:rgba(160,160,159,0.7);margin:0;font-size:11px;">Powered by Bridge AI</p></div></div>`
      })
    });
    console.log('Email sent');
  } catch (err) { console.error('Email error:', err.message); }

  // GHL webhook
  try {
    const webhookUrls = { wallace: process.env.GHL_WEBHOOK_WALLACE, roofing: process.env.GHL_WEBHOOK_ROOFING, hvac: process.env.GHL_WEBHOOK_HVAC, bridgeai: process.env.GHL_WEBHOOK_BRIDGEAI };
    const webhookUrl = webhookUrls[client];
    if (webhookUrl) {
      await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ firstName: lead.name.split(' ')[0], lastName: lead.name.split(' ').slice(1).join(' '), phone: lead.phone, source: 'Voice Call', notes: lead.project, tags: ['Bridge AI', 'Voice Call', client] })
      });
      console.log('GHL webhook sent');
    }
  } catch (err) { console.error('GHL error:', err.message); }
}

// ── Health check ───────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'Bridge AI Voice Server running', clients: Object.keys(PROMPTS), timestamp: new Date().toISOString() });
});

app.listen(PORT, () => console.log(`Voice server running on port ${PORT}`));
