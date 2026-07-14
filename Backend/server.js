require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

// ---------------------------------------------------------------------------
// Schemes cache
// ---------------------------------------------------------------------------
let schemesCache = [];

function loadSchemesCache() {
  try {
    const fileContent = fs.readFileSync(path.join(__dirname, 'schemes.json'), 'utf8');
    schemesCache = JSON.parse(fileContent);
    console.log(`[Cache] Loaded ${schemesCache.length} schemes.`);
  } catch (error) {
    console.error('CRITICAL: Failed to load schemes.json:', error.message);
    process.exit(1);
  }
}
loadSchemesCache();

// ---------------------------------------------------------------------------
// API key check — logged at startup so you know immediately if it's missing
// ---------------------------------------------------------------------------
if (!process.env.GEMINI_API_KEY) {
  console.error('----------------------------------------------------------');
  console.error('[ERROR] GEMINI_API_KEY is missing from your .env file!');
  console.error('  1. Open the .env file in your backend folder');
  console.error('  2. Add:  GEMINI_API_KEY=your_actual_key_here');
  console.error('  3. Restart the server');
  console.error('----------------------------------------------------------');
} else {
  console.log('[Gemini] API key loaded ✓');
}

// ---------------------------------------------------------------------------
// Income mapping
// ---------------------------------------------------------------------------
const INCOME_MAPPING = {
  'under2.5': 250000,
  'under3.5': 350000,
  'under8'  : 800000,
  'above8'  : 99999999
};

// ---------------------------------------------------------------------------
// Gemini helper — URL built at call time so key is always fresh
// ---------------------------------------------------------------------------
async function callGemini(promptText) {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not set in .env — please add it and restart the server.');
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${apiKey}`;

  const response = await fetch(url, {
    method : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body   : JSON.stringify({
      contents: [{ parts: [{ text: promptText }] }]
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    // Surface the Gemini error clearly in the server console
    console.error('[Gemini API Error]', response.status, errText);
    if (response.status === 400) throw new Error('Bad request to Gemini — check your prompt format.');
    if (response.status === 403) throw new Error('Invalid or expired GEMINI_API_KEY — please check your .env file.');
    if (response.status === 429) throw new Error('Gemini rate limit hit — please wait a moment and try again.');
    throw new Error(`Gemini returned HTTP ${response.status}`);
  }

  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini returned an empty response.');
  return text;
}

// ---------------------------------------------------------------------------
// Sanitize user input against basic prompt injection
// ---------------------------------------------------------------------------
function sanitizeInput(text) {
  if (!text) return '';
  const blocklist = [
    /ignore (all|any|previous|prior) instructions/gi,
    /you are now/gi,
    /system\s*:/gi,
    /disregard (all|any|previous|prior)/gi,
  ];
  let cleaned = text;
  blocklist.forEach(p => { cleaned = cleaned.replace(p, ''); });
  return cleaned.trim().slice(0, 1000);
}

// ---------------------------------------------------------------------------
// Shared matching logic
// ---------------------------------------------------------------------------
function matchSchemes(payload) {
  const {
    age, income, schemeType, state, gender,
    demographicCategory, educationLevel, cgpa, bplStatus, medicalNeed
  } = payload;

  const numericalIncomeLimit = INCOME_MAPPING[income] || 0;
  const parsedAge   = Number(age);
  const parsedScore = cgpa ? Number(cgpa) : null;

  const matched = schemesCache.filter(scheme => {
    if (scheme.scheme_type !== schemeType) return false;
    if (scheme.max_income !== null && numericalIncomeLimit > scheme.max_income) return false;
    if (scheme.min_age   !== null && parsedAge < scheme.min_age) return false;
    if (scheme.max_age   !== null && parsedAge > scheme.max_age) return false;
    if (scheme.state !== 'All India' && state && scheme.state !== state) return false;
    if (scheme.gender !== 'None' && gender && scheme.gender !== gender) return false;
    if (
      Array.isArray(scheme.eligible_categories) &&
      !scheme.eligible_categories.includes('All') &&
      demographicCategory &&
      !scheme.eligible_categories.includes(demographicCategory)
    ) return false;
    if (
      scheme.education_level &&
      scheme.education_level !== 'Any' &&
      educationLevel &&
      scheme.education_level !== educationLevel
    ) return false;
    if (
      scheme.min_score !== null &&
      scheme.min_score !== undefined &&
      parsedScore !== null &&
      parsedScore < scheme.min_score
    ) return false;
    if (scheme.requires_bpl === true && (!bplStatus || bplStatus.toLowerCase() !== 'yes')) return false;
    if (medicalNeed && scheme.medical_need !== medicalNeed) return false;
    return true;
  });

  return matched.map(scheme => {
    const reasons = [];
    reasons.push(`Your family income falls within the scheme's limit`);
    reasons.push(`Your age (${parsedAge}) fits the eligible range`);
    if (scheme.state !== 'All India') reasons.push(`You're a resident of ${scheme.state}`);
    if (scheme.gender !== 'None') reasons.push(`This scheme is open to ${scheme.gender} applicants`);
    if (Array.isArray(scheme.eligible_categories) && !scheme.eligible_categories.includes('All')) {
      reasons.push(`Your category (${demographicCategory}) is eligible`);
    }
    if (scheme.education_level && scheme.education_level !== 'Any') {
      reasons.push(`Your education level matches (${scheme.education_level})`);
    }
    if (scheme.min_score) reasons.push(`Your score meets the minimum requirement of ${scheme.min_score}%`);
    if (scheme.requires_bpl) reasons.push(`You hold a BPL card, which this scheme requires`);
    if (scheme.medical_need && scheme.medical_need !== 'General') {
      reasons.push(`This scheme covers your selected need (${scheme.medical_need})`);
    }
    return { ...scheme, whyYouQualify: reasons.join('. ') + '.' };
  });
}

// ---------------------------------------------------------------------------
// Health check — call this from browser to diagnose issues
// GET http://localhost:5000/api/health
// ---------------------------------------------------------------------------
app.get('/api/health', async (req, res) => {
  const keySet = !!process.env.GEMINI_API_KEY;
  let geminiOk = false;
  let geminiError = null;

  if (keySet) {
    try {
      await callGemini('Reply with exactly the word: OK');
      geminiOk = true;
    } catch (e) {
      geminiError = e.message;
    }
  }

  res.json({
    server    : 'running',
    schemes   : schemesCache.length,
    apiKeySet : keySet,
    geminiOk,
    geminiError
  });
});

// ---------------------------------------------------------------------------
// POST /api/match
// ---------------------------------------------------------------------------
app.post('/api/match', (req, res) => {
  res.json(matchSchemes(req.body));
});

// ---------------------------------------------------------------------------
// POST /api/chat
// Two modes:
//   - With context (matched schemes) → answers only from those schemes
//   - Without context (empty array)  → general assistant using full scheme DB
// ---------------------------------------------------------------------------
app.post('/api/chat', async (req, res) => {
  try {
    const { message, context } = req.body;
    if (!message) return res.status(400).json({ error: 'message is required' });

    const safeMessage = sanitizeInput(message);
    const hasContext  = Array.isArray(context) && context.length > 0;

    let prompt;

    if (hasContext) {
      // User has run a search — answer strictly from matched schemes
      prompt = `You are a helpful assistant for Scheme Setu, an Indian government scheme awareness platform.
The user has already been matched to the following schemes based on their profile.
Answer their question using ONLY the data provided below — do not invent or add information not present here.
Explain in simple, plain language. Break down government jargon. Keep answers to 3–5 sentences unless asked for more.
If the answer is not in the data, say: "I don't have that information — please check the official link for that scheme."

MATCHED SCHEMES FOR THIS USER:
${JSON.stringify(context, null, 2)}

USER QUESTION: ${safeMessage}`;

    } else {
      // No search done yet — use full scheme database for general awareness questions
      // Send only scheme names, types, and descriptions to stay within token limits
      const schemesSummary = schemesCache.map(s => ({
        name       : s.scheme_name,
        type       : s.scheme_type,
        description: s.description,
        state      : s.state,
        gender     : s.gender,
        link       : s.official_link
      }));

      prompt = `You are a helpful assistant for Scheme Setu, an Indian government scheme awareness platform.
The user has not searched yet, but is asking a general question about government schemes.
Answer helpfully using the scheme database below. You may also use general knowledge about Indian government schemes.
Be concise, warm, and jargon-free. Suggest they use the quiz or Express Match for personalized results.

AVAILABLE SCHEMES DATABASE:
${JSON.stringify(schemesSummary, null, 2)}

USER QUESTION: ${safeMessage}`;
    }

    const reply = await callGemini(prompt);
    res.json({ reply });

  } catch (err) {
    console.error('[/api/chat error]', err.message);
    // Send the actual error reason back so the frontend can show something useful
    res.status(500).json({
      error: err.message.includes('GEMINI_API_KEY')
        ? 'AI is not configured yet — GEMINI_API_KEY is missing from the server .env file.'
        : err.message.includes('403')
        ? 'Invalid Gemini API key — please check your .env file.'
        : err.message.includes('429')
        ? 'Too many requests — please wait a moment and try again.'
        : 'Failed to get a response. Please try again.'
    });
  }
});

// ---------------------------------------------------------------------------
// POST /api/extract-profile  (Express Match)
// ---------------------------------------------------------------------------
app.post('/api/extract-profile', async (req, res) => {
  try {
    const { rawText } = req.body;
    if (!rawText) return res.status(400).json({ error: 'rawText is required' });

    const safeText = sanitizeInput(rawText);

    const prompt = `Extract a user profile from the text below and return ONLY a valid JSON object (no markdown, no code fences, no commentary) with exactly these keys:
schemeType          — "scholarship" | "healthcare" | null
age                 — number | null
income              — "under2.5" | "under3.5" | "under8" | "above8" | null
state               — full Indian state name | null
gender              — "Male" | "Female" | "Other" | null
demographicCategory — "General" | "SC" | "ST" | "OBC" | "OBC-NCL" | "EBC" | "DNT" | "Minority" | "Disability" | "Govt Employee" | "Worker" | null
educationLevel      — "School" | "Undergraduate" | "Postgraduate" | "Any" | null
bplStatus           — "yes" | "no" | null
medicalNeed         — "General" | "Maternity" | null
cgpa                — number | null

Rules:
- If a field cannot be determined from the text, set it to null. Do not guess.
- For income: "under 2 lakh" → "under2.5", "3 lakh" → "under3.5", "5 lakh" → "under8"
- Do not add extra keys.

TEXT: "${safeText}"`;

    const rawReply = await callGemini(prompt);
    const cleaned  = rawReply.replace(/```json|```/g, '').trim();

    let profile;
    try {
      profile = JSON.parse(cleaned);
    } catch (e) {
      console.error('[extract-profile] JSON parse failed. Raw reply was:', cleaned);
      return res.status(500).json({ error: 'Could not understand the response. Please try rephrasing.' });
    }

    const required      = ['schemeType', 'age', 'income', 'state', 'gender', 'demographicCategory'];
    const missingFields = required.filter(f => profile[f] === null || profile[f] === undefined);

    if (missingFields.length > 0) {
      return res.status(206).json({
        status      : 'partial',
        profile,
        missingFields,
        message: `Got some of your details! I still need: ${missingFields
          .map(f => f.replace(/([A-Z])/g, ' $1').toLowerCase())
          .join(', ')}.`
      });
    }

    const results = matchSchemes(profile);
    res.json({ status: 'complete', profile, results });

  } catch (err) {
    console.error('[/api/extract-profile error]', err.message);
    res.status(500).json({
      error: err.message.includes('GEMINI_API_KEY')
        ? 'AI is not configured — GEMINI_API_KEY is missing from .env.'
        : 'Failed to process your message. Please try again.'
    });
  }
});

app.listen(PORT, () => {
  console.log(`[Server] Running at http://localhost:${PORT}`);
  console.log(`[Server] Health check: http://localhost:${PORT}/api/health`);
});