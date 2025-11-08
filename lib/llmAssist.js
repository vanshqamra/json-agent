// llmAssist.js
let clientPromise = null;

function isServer() {
  return typeof window === 'undefined';
}

function isLLMEnabled() {
  return (
    isServer() &&
    process.env.USE_LLM === 'true' &&
    !!process.env.OPENAI_API_KEY
  );
}

async function getClient() {
  if (!isLLMEnabled()) return null;

  if (!clientPromise) {
    const loadModule = Function('m', 'return import(m);');
    clientPromise = loadModule('openai')
      .then(mod => {
        const OpenAI = mod && (mod.default || mod.OpenAI || mod.OpenAi);
        return OpenAI ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
      })
      .catch(err => {
        console.error('LLM client init failed:', err);
        clientPromise = null;
        return null;
      });
  }

  return clientPromise;
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

  const client = await getClient();
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
      model: "gpt-4.1-mini",
      temperature: 0,
      messages: [
        { role: "system", content: "You return only valid JSON." },
        { role: "user", content: prompt }
      ]
    });

    const raw = completion.choices?.[0]?.message?.content || "{}";
    return JSON.parse(raw);
  } catch (err) {
    console.error('LLM escalation failed:', err);
    return { hint: 'llm_error', error: err?.message }; // keep harmless stub
  }
}
