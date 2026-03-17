const axios = require('axios');

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const MODEL = process.env.OPENROUTER_MODEL || 'openrouter/auto';

async function improveText(text, mode) {
  if (!OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY not configured');

  const prompts = {
    grammar: `You are a grammar corrector. Fix ONLY spelling, grammar, and punctuation errors in the text below. Do NOT rephrase, restructure, or change the meaning. Do NOT use markdown formatting like ** or *. Return ONLY the corrected plain text, nothing else.

Text: ${text}`,

    professional: `You are a customer support writing assistant for an Indian e-commerce brand. Rewrite the text below into clear, polite, professional customer support language. Keep it warm but concise. Use simple English suitable for Indian customers. Do NOT add new information or promises. Do NOT use markdown formatting like ** or * or #. Return ONLY the rewritten plain text, nothing else.

Text: ${text}`,
  };

  const prompt = prompts[mode];
  if (!prompt) throw new Error('Invalid mode');

  const response = await axios.post(
    'https://openrouter.ai/api/v1/chat/completions',
    {
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 1000,
      temperature: mode === 'grammar' ? 0.1 : 0.4, // low temp for grammar, higher for rephrasing
    },
    {
      headers: {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': process.env.FRONTEND_URL || 'https://www.branddesk.in',
        'X-Title': 'BrandDesk',
      },
      timeout: 15000,
    }
  );

  const result = response.data?.choices?.[0]?.message?.content?.trim();
  if (!result) throw new Error('No response from AI');
  return result;
}

module.exports = { improveText };