import { getOpenAIClient, isOpenAIConfigured } from './openaiClient.js';

// llmAssist.js

function isServer() {
  return typeof window === 'undefined';
}

function isLLMEnabled() {
  return isServer() && process.env.USE_LLM === 'true' && isOpenAIConfigured();
}

/**
 * block: {
 *   type: "header" | "sku" | "spec_row" | "price" | "text" | ...
 *   text: string
 *   context?: { pageIndex, surroundingLines[] }
 * }
 * 
 * reason: string explaining why deterministic pipeline is uncertain here
 */
export async function maybeEscalateWithLLM(block = {}, reason = '') {
  if (!isServer()) return { hint: 'llm_disabled_client' };
  if (!isLLMEnabled()) return { hint: 'llm_disabled' };

  const client = getOpenAIClient();
  if (!client) return { hint: 'llm_client_unavailable' };

  const prompt = `
You are part of a structured chemical catalog extraction system.

Your job:
- DO NOT hallucinate new data.
- If uncertain, return "uncertain": true.
- Return only structured JSON, no explanation text.

Given:
BLOCK TEXT:
${block.text}

REASON:
${reason}

GOAL:
Infer the most likely classification and normalized fields.

Return JSON object with at most:
{
  "suggestedType": "header" | "sku" | "spec_row" | "price" | "text",
  "normalized": {
     "name"?: string,
     "sku"?: string,
     "spec"?: string,
     "value"?: string,
     "unit"?: string
  },
  "uncertain": boolean
}
`;

  try {
    const completion = await client.chat.completions.create({
      model: 'gpt-4.1-mini',
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'You return only valid JSON.' },
        { role: 'user', content: prompt }
      ]
    });

    const raw = (completion.choices?.[0]?.message?.content || '{}').trim();
    if (/^\s*</.test(raw)) {
      throw new Error(`Non-JSON payload from OpenAI: ${raw.slice(0, 120)}`);
    }
    return JSON.parse(raw);
  } catch (err) {
    console.error('LLM escalation failed:', err);
    return { hint: 'llm_error', error: err?.message }; // keep harmless stub
  }
}
