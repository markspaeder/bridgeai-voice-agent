const express = require('express');
const cors = require('cors');
const twilio = require('twilio');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

const PORT = process.env.PORT || 3000;

// ── System prompts per client ──────────────────────────
const PROMPTS = {
  roofing: {
    name: 'Peak Roofing Co.',
    greeting: "Hi, thanks for calling Peak Roofing. I'm a virtual assistant available 24 hours a day. I can help with storm damage, free inspections, or insurance questions. How can I help you today?",
    prompt: `You are a friendly professional phone receptionist for Peak Roofing Co., a South Florida roofing company.

Your job is to:
1. Greet the caller warmly
2. Find out what they need — storm damage, free inspection, insurance claim, general quote, or other
3. Collect their FULL NAME and CALLBACK PHONE NUMBER
4. Get a brief description of their roofing issue or need
5. Let them know a roofing specialist will call them back shortly
6. Thank them and end the call professionally

IMPORTANT RULES:
- Keep responses SHORT — this is a phone call, not a chat. 2-3 sentences max per response.
- Never quote prices — always say a specialist will provide a free estimate
- Always mention free no-obligation inspections
- Be warm and empathetic — storm damage is stressful
- When you have name and phone number, include [LEAD:collected] at the end of your response
- After collecting info, wrap up the call warmly
- NEVER say you are an AI unless directly asked. If asked, say you are a virtual assistant.`
  },

  hvac: {
    name: 'Fire & Ice HVAC',
    greeting: "Hi, thanks for calling Fire and Ice HVAC. I'm a virtual assistant available around the clock. I can help with AC repairs, new systems, or maintenance. What can I help you with today?",
    prompt: `You are a friendly professional phone receptionist for Fire & Ice HVAC, a South Florida heating and cooling company.

Your job is to:
1. Find out if it's an emergency (AC out in Florida heat = urgent)
2. Collect their FULL NAME and CALLBACK PHONE NUMBER
3. Get their address and describe the issue
4. For emergencies — assure them a technician will call within the hour
5. For non-emergencies — schedule a callback within 24 hours

IMPORTANT RULES:
- Keep responses SHORT — 2-3 sentences max
- Never quote prices
- For AC emergencies be extra reassuring and urgent
- When you have name and phone include [LEAD:collected]
- After collecting info wrap up warmly
- NEVER say you are an AI unless directly asked.`
  },

  wallace: {
    name: 'Wallace Fitness Center',
    greeting: "Hi, thanks for calling Wallace Fitness Center! I'm a virtual assistant — I can help you learn about our programs, answer questions, or get you set up with a free consultation. What can I do for you today?",
    prompt: `You are a warm, encouraging, and energetic phone receptionist for Wallace Fitness Center, a full-service fitness facility in Delmont, Pennsylvania.

BUSINESS INFO:
- Address: 100 Center Ice Dr, Delmont, PA 15626
- Phone: (724) 433-6155
- Open 24/7 for members
- Serving Delmont, Greensburg, Murrysville, and Westmoreland County

SERVICES:
- Personal Training: One-on-one with certified coaches. Custom plan for your goals.
- Group Training: Coach-led strength and conditioning classes. Great community.
- Nutrition Coaching: Sustainable habits to support health and fitness.
- Adapted Personal Training: Safe exercise for people with injuries, disabilities, or health conditions.
- Silver Sneakers: Classes for older adults. Strength, balance, and mobility.
- Open Gym: 24/7 app-access. Free weights, machines, cardio, functional training.
- Free consultation available for anyone interested — no commitment required.

Your job is to:
1. Find out what the caller's fitness goals are
2. Match them to the right program
3. Encourage them with a warm, positive tone — fitness can be intimidating
4. Collect their FULL NAME and CALLBACK PHONE NUMBER
5. Book them for a FREE CONSULTATION or have a coach call them back
6. Thank them warmly and end the call

IMPORTANT RULES:
- Keep responses SHORT — 2-3 sentences max per response
- Never quote specific prices — direct to free consultation
- Be warm, encouraging, and positive — never make anyone feel judged
- Emphasize the free consultation — no commitment, no pressure
- When you have name and phone include [LEAD:collected]
- After collecting info wrap up warmly
- NEVER say you are an AI unless directly asked.`
  },

  bridgeai: {
    name: 'Bridge AI',
    greeting: "Hi, thanks for calling Bridge AI. I'm a virtual assistant. We build custom AI agents for businesses that capture leads 24/7. How can I help you today?",
    prompt: `You are a friendly professional phone receptionist for Bridge AI, a company that builds custom AI agents for businesses.

Your job is to:
1. Find out what kind of business they have and what they're interested in
2. Explain briefly — we build custom AI agents that capture leads 24/7
3. Collect their FULL NAME, CALLBACK PHONE NUMBER, and business type
4. Let them know Mark will call them back personally
5. Point them to mybridgeai.com to see a live demo while they wait

PRICING if asked:
- Setup: $500-1,000 depending on complexity
- Annual maintenance: $1,500/year

IMPORTANT RULES:
- Keep responses SHORT — 2-3 sentences max
- Be enthusiastic but not pushy
- When you have name and phone include [LEAD:collected]
- After collecting info wrap up warmly
- NEVER say you are an AI unless directly asked.`
  }
};

// ── Active calls storage ───────────────────────────────
const activeCalls = {};
const pendingLeads = {};
const activeTimers = {};

// ── ElevenLabs TTS ────────────────────────────────────
async function textToSpeech(text, voiceId) {
  const elevenKey = (process.env.ELEVENLABS_API_KEY || '').trim();
  
  // Use ElevenLabs if key is available, otherwise fall back to Polly
  if (!elevenKey) {
    return null; // Fall back to Polly
  }

  // Default voice IDs per client type
  const voices = {
    roofing: process.env.VOICE_ROOFING || 'EXAVITQu4vr4xnSDxMaL', // Sarah - professional
    hvac: process.env.VOICE_HVAC || 'EXAVITQu4vr4xnSDxMaL',
    wallace: process.env.VOICE_WALLACE || 'XrExE9yKIg1WjnnlVkGX', // Matilda - warm & friendly
    bridgeai: process.env.VOICE_BRIDGEAI || 'ErXwobaYiN019PkySvjV' // Antoni - confident
  };

  const vid = voices[voiceId] || voices.bridgeai;

  try {
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${vid}/stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'xi-api-key': elevenKey,
      },
      body: JSON.stringify({
        text: text,
        model_id: 'eleven_turbo_v2',
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
          style: 0.3,
          use_speaker_boost: true
        }
      })
    });

    if (!response.ok) throw new Error('ElevenLabs error: ' + response.status);
    
    const buffer = await response.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');
    return `data:audio/mpeg;base64,${base64}`;
  } catch (err) {
    console.error('ElevenLabs TTS error:', err.message);
    return null;
  }
}

// ── Helper: say with ElevenLabs or Polly fallback ─────
function sayWithVoice(twiml, text, client) {
  // For now use Polly — ElevenLabs requires audio hosting
  // TODO: Upload audio to S3/CDN and use twiml.play()
  const voices = {
    wallace: 'Polly.Joanna-Neural',
    roofing: 'Polly.Joanna-Neural',
    hvac: 'Polly.Joanna-Neural',
    bridgeai: 'Polly.Matthew-Neural'
  };
  const voice = voices[client] || 'Polly.Joanna-Neural';
  twiml.say({ voice }, text);
}

// ── Inbound call handler ───────────────────────────────
app.post('/voice/:client', (req, res) => {
  const client = req.params.client;
  const config = PROMPTS[client];
  const callSid = req.body.CallSid;

  if (!config) {
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say('Sorry, this number is not configured.');
    return res.type('text/xml').send(twiml.toString());
  }

  // Initialize call state
  activeCalls[callSid] = {
    client,
    history: [],
    collected: { name: null, phone: null }
  };

  const twiml = new twilio.twiml.VoiceResponse();
  const gather = twiml.gather({
    input: 'speech',
    action: `/voice/${client}/respond`,
    method: 'POST',
    speechTimeout: 'auto',
    speechModel: 'phone_call',
    enhanced: true,
    language: 'en-US'
  });

  sayWithVoice(gather, config.greeting, client);
  twiml.redirect(`/voice/${client}`);

  res.type('text/xml').send(twiml.toString());
});

// ── Response handler ───────────────────────────────────
app.post('/voice/:client/respond', async (req, res) => {
  const client = req.params.client;
  const config = PROMPTS[client];
  const callSid = req.body.CallSid;
  const speechResult = req.body.SpeechResult || '';

  const call = activeCalls[callSid] || { client, history: [], collected: { name: null, phone: null } };
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

    call.history.push({ role: 'assistant', content: reply });

    if (leadCollected) {
      // Delayed lead capture — wait for call to end
      const sessionKey = callSid;
      if (activeTimers[sessionKey]) clearTimeout(activeTimers[sessionKey]);
      pendingLeads[sessionKey] = { history: [...call.history], client };
      activeTimers[sessionKey] = setTimeout(() => {
        if (pendingLeads[sessionKey]) {
          captureVoiceLead(pendingLeads[sessionKey].history, pendingLeads[sessionKey].client, callSid);
          delete pendingLeads[sessionKey];
        }
        delete activeTimers[sessionKey];
        delete activeCalls[callSid];
      }, 60 * 1000); // 1 min after lead collected

      const gather = twiml.gather({
        input: 'speech',
        action: `/voice/${client}/respond`,
        method: 'POST',
        speechTimeout: 'auto',
        speechModel: 'phone_call',
        enhanced: true,
        language: 'en-US'
      });
      sayWithVoice(gather, reply, client);
      sayWithVoice(twiml, 'Thank you for calling. Have a great day!', client);
    } else {
      const gather = twiml.gather({
        input: 'speech',
        action: `/voice/${client}/respond`,
        method: 'POST',
        speechTimeout: 'auto',
        speechModel: 'phone_call',
        enhanced: true,
        language: 'en-US'
      });
      sayWithVoice(gather, reply, client);
      sayWithVoice(twiml, 'Are you still there? Take your time.', client);
    }

  } catch (err) {
    console.error('Response error:', err.message);
    sayWithVoice(twiml, 'Sorry, I had a technical issue. Please call back or visit our website. Thank you!', client);
  }

  res.type('text/xml').send(twiml.toString());
});

// ── Missed call handler ────────────────────────────────
app.post('/voice/:client/missed', async (req, res) => {
  const client = req.params.client;
  const callerPhone = req.body.From || req.body.Caller;
  const config = PROMPTS[client];

  if (!callerPhone || !config) return res.sendStatus(200);

  const siteUrls = {
    roofing: 'mybridgeai.com',
    hvac: 'mybridgeai.com',
    wallace: 'wallacefitnesscenter.com',
    bridgeai: 'mybridgeai.com'
  };

  const messages = {
    roofing: `Hi! You called Peak Roofing but we missed you. Our AI assistant can help right now at ${siteUrls[client]} — or we'll call you back shortly!`,
    hvac: `Hi! You called Fire & Ice HVAC but we missed you. For AC emergencies our AI can help now at ${siteUrls[client]} — or we'll call back soon!`,
    wallace: `Hi! You called Wallace Fitness Center but we missed you. Our AI assistant can answer questions and set up your free consultation right now at ${siteUrls[client]}!`,
    bridgeai: `Hi! You called Bridge AI but we missed you. Check out a live demo at mybridgeai.com or we'll call you back shortly!`
  };

  try {
    const twilioClient = twilio(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN
    );

    await twilioClient.messages.create({
      body: messages[client] || messages.bridgeai,
      from: process.env.TWILIO_PHONE_NUMBER || '+18662805386',
      to: callerPhone
    });

    console.log(`Missed call SMS sent to ${callerPhone} for ${client}`);
  } catch (err) {
    console.error('SMS error:', err.message);
  }

  res.sendStatus(200);
});

// ── Voice lead capture ─────────────────────────────────
async function captureVoiceLead(history, client, callSid) {
  const config = PROMPTS[client];
  const allText = history.map(m => m.content).join('\n');
  const assistantText = history.filter(m => m.role === 'assistant').map(m => m.content).join('\n');

  // Extract name
  let name = 'Not captured';
  const skipWords = /^(there|you|me|sir|mam|friend|buddy|sure|yes|no|ok|all|so|well|it|that|this|question|help|quote|call|hi|hello|hey)$/i;
  const confirmedName = assistantText.match(/(?:thank you|thanks|great)[,!]?\s+([A-Za-z][a-z]+(?:\s+[A-Za-z][a-z]+)?)[,!\.]/i);
  if (confirmedName && !skipWords.test(confirmedName[1])) name = confirmedName[1];
  if (name === 'Not captured') {
    const userText = history.filter(m => m.role === 'user').map(m => m.content).join('\n');
    const explicitName = userText.match(/(?:my name is|i'm|i am|this is|call me)\s+([A-Za-z]+(?:\s+[A-Za-z]+)?)/i);
    if (explicitName && !skipWords.test(explicitName[1])) name = explicitName[1];
  }

  // Extract phone
  const phoneMatch = allText.match(/\d*?((?:\(?\d{3}\)?[\s\-.]?\d{3}[\s\-.]?\d{4}))/);
  const phone = phoneMatch ? phoneMatch[1] : 'Not captured';

  // Extract project/goal
  let project = 'Voice call inquiry';
  const userMessages = history.filter(m => m.role === 'user').map(m => m.content);
  const serviceKeywords = /train|fitness|weight|muscle|lose|gain|workout|gym|nutrition|coach|silver|adapt|injury|health|class|group|open gym|consultation/i;
  for (const msg of userMessages) {
    if (serviceKeywords.test(msg) && msg.length > 8) {
      project = msg.slice(0, 120).trim();
      break;
    }
  }

  const timestamp = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  const snippet = history.map(m => `${m.role === 'user' ? (name !== 'Not captured' ? name : 'Caller') : config.name}: ${m.content}`).join('\n\n');
  const lead = { name, phone, project, timestamp, snippet, source: 'Voice Call' };

  console.log('Voice lead captured:', lead.name, lead.phone, lead.project);

  await sendLeadEmail(lead, client).catch(e => console.error('Email failed:', e.message));
  await appendSheet(lead, client).catch(e => console.error('Sheet failed:', e.message));
  await sendToGHL(lead, client).catch(e => console.error('GHL failed:', e.message));
}

// ── Email ──────────────────────────────────────────────
async function sendLeadEmail(lead, client) {
  const resendKey = (process.env.RESEND_API_KEY || '').trim();
  const names = { bridgeai: 'Bridge AI', roofing: 'Peak Roofing Co.', hvac: 'Fire & Ice HVAC', wallace: 'Wallace Fitness Center' };
  const clientName = names[client] || client;
  const recipients = [process.env.GMAIL_USER, process.env.CLIENT_EMAIL].filter(Boolean).map(e => e.trim());

  const sourceIcon = lead.source === 'Voice Call' ? '📞' : '💬';

  const body = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
      <div style="background:#211F58;padding:20px;border-radius:8px 8px 0 0;">
        <h2 style="color:#A0A09F;margin:0;">${sourceIcon} New ${lead.source} Lead — ${clientName}</h2>
      </div>
      <div style="background:#f9f9f9;padding:24px;border:1px solid #e0e0e0;">
        <p><b>Name:</b> ${lead.name}</p>
        <p><b>Phone:</b> <a href="tel:${lead.phone}">${lead.phone}</a></p>
        <p><b>Inquiry:</b> ${lead.project}</p>
        <p><b>Source:</b> ${lead.source}</p>
        <p><b>Time:</b> ${lead.timestamp}</p>
        <hr/>
        <h3>Conversation</h3>
        <pre style="background:#fff;padding:12px;border:1px solid #ddd;border-radius:4px;font-size:12px;white-space:pre-wrap;">${lead.snippet}</pre>
      </div>
      <div style="background:#211F58;padding:10px 20px;border-radius:0 0 8px 8px;text-align:center;">
        <p style="color:rgba(160,160,159,0.7);margin:0;font-size:11px;">Powered by Bridge AI</p>
      </div>
    </div>`;

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + resendKey },
    body: JSON.stringify({
      from: 'Bridge AI <leads@mybridgeai.com>',
      to: recipients,
      subject: `${sourceIcon} New ${lead.source} Lead — ${clientName}: ${lead.name} | ${lead.phone}`,
      html: body
    })
  });
  console.log('Email sent to:', recipients.join(', '));
}

// ── Google Sheets ──────────────────────────────────────
async function appendSheet(lead, client) {
  const { google } = require('googleapis');
  const creds = JSON.parse((process.env.GOOGLE_SERVICE_ACCOUNT || '{}').trim());
  const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  const sheets = google.sheets({ version: 'v4', auth });
  const sheetIds = {
    bridgeai: process.env.BRIDGEAI_SHEET_ID,
    wallace: process.env.WALLACE_SHEET_ID || process.env.BRIDGEAI_SHEET_ID,
    roofing: process.env.BRIDGEAI_SHEET_ID,
    hvac: process.env.BRIDGEAI_SHEET_ID
  };
  await sheets.spreadsheets.values.append({
    spreadsheetId: (sheetIds[client] || process.env.BRIDGEAI_SHEET_ID).trim(),
    range: 'Sheet1!A:G',
    valueInputOption: 'RAW',
    requestBody: { values: [[lead.timestamp, lead.name, lead.phone, 'N/A', lead.project, lead.source, 'New']] }
  });
  console.log('Sheet updated');
}

// ── GHL Webhook ────────────────────────────────────────
async function sendToGHL(lead, client) {
  const webhookUrls = {
    wallace: process.env.GHL_WEBHOOK_WALLACE,
    roofing: process.env.GHL_WEBHOOK_ROOFING,
    hvac: process.env.GHL_WEBHOOK_HVAC,
    bridgeai: process.env.GHL_WEBHOOK_BRIDGEAI
  };

  const webhookUrl = webhookUrls[client];
  if (!webhookUrl) return;

  await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      firstName: lead.name.split(' ')[0] || lead.name,
      lastName: lead.name.split(' ').slice(1).join(' ') || '',
      phone: lead.phone,
      source: lead.source,
      notes: lead.project,
      tags: ['Bridge AI', lead.source, client]
    })
  });
  console.log('GHL webhook sent for', client);
}

// ── Health check ───────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'Bridge AI Voice Server running', timestamp: new Date().toISOString(), clients: Object.keys(PROMPTS) });
});

app.listen(PORT, () => console.log(`Voice server running on port ${PORT}`));
