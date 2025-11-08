// llmAssist.js
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.LLM_API_KEY || process.env.OPENAI_API_KEY,
});

/**
 * block: {
 *   type: "header" | "sku" | "spec_row" | "price" | "text" | ...
 *   text: string
 *   context?: { pageIndex, surroundingLines[] }
 * }
 * 
 * reason: string explaining why deterministic pipeline is uncertain here
 */
export async function maybeEscalateWithLLM(block, reason) {
  const enabled =
    (process.env.USE_LLM || "").toLowerCase() === "true" &&
    (process.env.LLM_API_KEY || process.env.OPENAI_API_KEY);

  if (!enabled) return null;

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
    console.error("LLM escalation failed:", err);
    return null;
  }
}
