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
    greeting: "Hi, thanks for calling Peak Roofing. I'm an AI assistant available 24 hours a day. I can help with storm damage, free inspections, or insurance questions. How can I help you today?",
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

NEVER say you are an AI unless directly asked. If asked, say you are a virtual assistant.`
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
- After collecting info wrap up warmly`
  },

  bridgeai: {
    name: 'Bridge AI',
    greeting: "Hi, thanks for calling Bridge AI. I'm a virtual assistant. We build custom AI agents for trade businesses. How can I help you today?",
    prompt: `You are a friendly professional phone receptionist for Bridge AI, a company that builds custom AI agents for trade businesses.

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
- After collecting info wrap up warmly`
  }
};

// ── Conversation state (in-memory) ────────────────────
const conversations = {};

// ── Incoming call handler ──────────────────────────────
app.post('/voice/:client', async (req, res) => {
  const client = req.params.client || 'roofing';
  const callSid = req.body.CallSid;
  const config = PROMPTS[client] || PROMPTS.roofing;

  // Initialize conversation
  conversations[callSid] = {
    history: [],
    client: client,
    leadCaptured: false
  };

  const twiml = new twilio.twiml.VoiceResponse();
  
  // Greet caller
  const gather = twiml.gather({
    input: 'speech',
    action: `/respond/${client}`,
    method: 'POST',
    speechTimeout: 'auto',
    language: 'en-US'
  });
  
  gather.say({
    voice: 'Polly.Joanna-Neural',
    language: 'en-US'
  }, config.greeting);

  res.type('text/xml');
  res.send(twiml.toString());
});

// ── Speech response handler ────────────────────────────
app.post('/respond/:client', async (req, res) => {
  const client = req.params.client || 'roofing';
  const callSid = req.body.CallSid;
  const speechResult = req.body.SpeechResult || '';
  const config = PROMPTS[client] || PROMPTS.roofing;

  // Get or init conversation
  if (!conversations[callSid]) {
    conversations[callSid] = { history: [], client, leadCaptured: false };
  }

  const conv = conversations[callSid];
  conv.history.push({ role: 'user', content: speechResult });

  let reply = '';

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 200,
        system: config.prompt,
        messages: conv.history
      })
    });

    const data = await response.json();
    reply = data.content?.[0]?.text || "I'm sorry, could you repeat that?";

    // Check for lead capture
    if (reply.includes('[LEAD:collected]') && !conv.leadCaptured) {
      conv.leadCaptured = true;
      captureLeadAsync(conv.history, reply, client, callSid);
      reply = reply.replace('[LEAD:collected]', '').trim();
    }

    conv.history.push({ role: 'assistant', content: reply });

  } catch (err) {
    console.error('AI error:', err.message);
    reply = "I'm sorry, I'm having a little trouble. Please hold while I connect you to someone who can help.";
  }

  const twiml = new twilio.twiml.VoiceResponse();

  // Check if conversation should end
  const endPhrases = ['thank you for calling', 'have a great day', 'goodbye', 'take care'];
  const shouldEnd = endPhrases.some(p => reply.toLowerCase().includes(p));

  if (shouldEnd) {
    twiml.say({ voice: 'Polly.Joanna-Neural' }, reply);
    twiml.hangup();
  } else {
    const gather = twiml.gather({
      input: 'speech',
      action: `/respond/${client}`,
      method: 'POST',
      speechTimeout: 'auto',
      language: 'en-US'
    });
    gather.say({ voice: 'Polly.Joanna-Neural' }, reply);

    // If no response, prompt again
    twiml.say({ voice: 'Polly.Joanna-Neural' }, "Are you still there? Take your time.");
    twiml.redirect(`/respond/${client}`);
  }

  res.type('text/xml');
  res.send(twiml.toString());
});

// ── Lead capture ───────────────────────────────────────
async function captureLeadAsync(history, lastResponse, client, callSid) {
  const fullText = history.map(m => m.content).join('\n');
  
  const phoneMatch = fullText.match(/(\(?\d{3}\)?[\s\-.]?\d{3}[\s\-.]?\d{4})/);
  
  let name = 'Not captured';
  const nameMatch = fullText.match(/(?:name is|I'm|I am|call me|my name's)\s+([A-Za-z]+(?:\s+[A-Za-z]+)?)/i)
    || lastResponse.match(/(?:thanks|thank you|got it|great)[,!]?\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)[,!\.]/);
  if (nameMatch) name = nameMatch[1];

  const issueMatch = fullText.match(/(?:damage|leak|repair|replace|inspection|insurance|estimate|quote|install)[^.]{0,60}/i);

  const lead = {
    name,
    phone: phoneMatch ? phoneMatch[0] : 'Not captured',
    project: issueMatch ? issueMatch[0].trim() : 'Phone inquiry — see transcript',
    timestamp: new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }),
    snippet: history.slice(-8).map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n'),
    client,
    source: 'Phone Call'
  };

  console.log(`📞 Phone Lead [${client}]:`, lead.name, lead.phone);

  sendLeadEmail(lead).catch(e => console.error('Email failed:', e.message));
  appendSheet(lead).catch(e => console.error('Sheet failed:', e.message));
}

// ── Email ──────────────────────────────────────────────
async function sendLeadEmail(lead) {
  const resendKey = (process.env.RESEND_API_KEY || '').trim();
  const toEmail = process.env.GMAIL_USER || 'mspaeder@gmail.com';
  
  const names = {
    roofing: 'Peak Roofing Co.',
    hvac: 'Fire & Ice HVAC',
    bridgeai: 'Bridge AI'
  };

  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + resendKey },
    body: JSON.stringify({
      from: 'Bridge AI <leads@mybridgeai.com>',
      to: [toEmail],
      subject: `📞 Phone Lead — ${names[lead.client] || lead.client}: ${lead.name} | ${lead.phone}`,
      html: `<div style="font-family:Arial,sans-serif;max-width:600px;">
        <div style="background:#122949;padding:20px;border-radius:8px 8px 0 0;">
          <h2 style="color:#6B8FFF;margin:0;">📞 New Phone Lead — ${names[lead.client] || lead.client}</h2>
        </div>
        <div style="background:#f9f9f9;padding:24px;border:1px solid #e0e0e0;">
          <p><b>Name:</b> ${lead.name}</p>
          <p><b>Phone:</b> <a href="tel:${lead.phone}">${lead.phone}</a></p>
          <p><b>Issue:</b> ${lead.project}</p>
          <p><b>Time:</b> ${lead.timestamp}</p>
          <p><b>Source:</b> Phone Call (AI Receptionist)</p>
          <hr/>
          <pre style="font-size:12px;white-space:pre-wrap;background:#fff;padding:12px;border:1px solid #ddd;">${lead.snippet}</pre>
        </div>
        <div style="background:#122949;padding:10px;text-align:center;border-radius:0 0 8px 8px;">
          <p style="color:#6B8FFF;font-size:11px;margin:0;">Powered by Bridge AI Voice — mybridgeai.com</p>
        </div>
      </div>`
    })
  });

  if (!r.ok) {
    const err = await r.json();
    throw new Error(JSON.stringify(err));
  }
  console.log('📧 Email sent to:', toEmail);
}

// ── Google Sheets ──────────────────────────────────────
async function appendSheet(lead) {
  const { google } = require('googleapis');
  const creds = JSON.parse((process.env.GOOGLE_SERVICE_ACCOUNT || '{}').trim());
  const sheetId = (process.env.BRIDGEAI_SHEET_ID || '').trim();
  if (!sheetId) return;

  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  const sheets = google.sheets({ version: 'v4', auth });
  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: 'Sheet1!A:G',
    valueInputOption: 'RAW',
    requestBody: {
      values: [[lead.timestamp, lead.name, lead.phone, lead.project, lead.client, 'Phone Call', 'New']]
    }
  });
  console.log('📊 Sheet updated:', lead.client);
}

// ── Health check ───────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'Bridge AI Voice Agent running', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => console.log(`Bridge AI Voice Agent running on port ${PORT}`));
