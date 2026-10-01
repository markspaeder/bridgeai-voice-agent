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

// ── Audio cache for ElevenLabs audio ─────────────────
const audioCache = {};
let audioCounter = 0;

async function generateAndCacheAudio(text, client) {
  const elevenKey = (process.env.ELEVENLABS_API_KEY || '').trim();
  if (!elevenKey) return null;

  const voiceIds = {
    wallace: process.env.VOICE_WALLACE || 'aMSt68OGf4xUZAnLpTU8',
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
        voice_settings: { stability: 0.5, similarity_boost: 0.75 }
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
  const audioId = await generateAndCacheAudio(text, client);
  if (audioId && host) {
    twiml.play(`https://${host}/audio/${audioId}`);
  } else {
    twiml.say({ voice: 'Polly.Joanna-Neural' }, text);
  }
}

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

// ── Audio cache ───────────────────────────────────────
const audioCache = {};
let audioCounter = 0;

// ── Serve cached audio ────────────────────────────────
app.get('/audio/:id', (req, res) => {
  const buf = audioCache[req.params.id];
  if (!buf) return res.status(404).send('Not found');
  res.set('Content-Type', 'audio/mpeg');
  res.send(buf);
});

// ── Health check ───────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'Bridge AI Voice Server running', timestamp: new Date().toISOString(), clients: Object.keys(PROMPTS) });
});

app.listen(PORT, () => console.log(`Voice server running on port ${PORT}`));
