import { setTimeout as delay } from 'node:timers/promises';

import { getOpenAIClient } from '../openaiClient.js';

const DEFAULT_MODEL = process.env.LLM_MODEL || 'gpt-5';
const DEFAULT_MAX_USD = Number.parseFloat(process.env.LLM_MAX_USD || '10');
const DEFAULT_COST_PER_1K_TOKENS = Number.parseFloat(process.env.LLM_COST_PER_1K || '0.015');

function estimateTokensFromPrompt(prompt) {
  const base = `${prompt?.system || ''}\n${prompt?.user || ''}`;
  const charLength = base.length || 1;
  return Math.ceil(charLength / 4); // crude heuristic
}

function computeEstimatedCostUsd(tokens, costPer1k = DEFAULT_COST_PER_1K_TOKENS) {
  return (tokens / 1000) * costPer1k;
}

function extractJsonPayload(rawContent = '') {
  const trimmed = String(rawContent || '').trim();
  if (!trimmed) {
    throw new Error('empty_response');
  }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('non_json_response');
  }
  const candidate = trimmed.slice(start, end + 1);
  return JSON.parse(candidate);
}

async function executeCall(client, prompt, { model = DEFAULT_MODEL, signal } = {}) {
  const payload = {
    model,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: prompt.system },
      { role: 'user', content: prompt.user },
    ],
  };
  const response = await client.chat.completions.create(payload, { signal });
  const content = response?.choices?.[0]?.message?.content || '';
  const parsed = extractJsonPayload(content);
  const usage = response?.usage || null;
  return { raw: response, parsed, usage };
}

export class ChunkerBudgetTracker {
  constructor(maxUsd = DEFAULT_MAX_USD) {
    this.maxUsd = Number.isFinite(maxUsd) ? Math.max(0, maxUsd) : DEFAULT_MAX_USD;
    this.spentUsd = 0;
    this.estimatedUsd = 0;
  }

  ensureAvailable(cost) {
    if (this.maxUsd <= 0) return;
    if (this.spentUsd + this.estimatedUsd + cost > this.maxUsd) {
      const remaining = Math.max(0, this.maxUsd - (this.spentUsd + this.estimatedUsd));
      const error = new Error(
        `llm_budget_exceeded: remaining=${remaining.toFixed(4)} usd, requested=${cost.toFixed(4)} usd`,
      );
      error.code = 'LLM_BUDGET_EXCEEDED';
      throw error;
    }
  }

  reserve(cost) {
    this.estimatedUsd += cost;
  }

  settle(actual) {
    if (!Number.isFinite(actual)) return;
    this.spentUsd += actual;
    if (this.estimatedUsd >= actual) {
      this.estimatedUsd -= actual;
    }
  }
}

export async function callLLMForChunk({
  prompt,
  budget,
  model = DEFAULT_MODEL,
  maxRetries = 3,
  retryDelayMs = 500,
  signal,
  client = null,
  mockResponse = null,
}) {
  if (!prompt || !prompt.system || !prompt.user) {
    throw new Error('invalid_prompt');
  }
  const effectiveClient = client || getOpenAIClient();
  if (!effectiveClient && !mockResponse) {
    const error = new Error('llm_client_unavailable');
    error.code = 'LLM_UNAVAILABLE';
    throw error;
  }
  const tracker = budget || new ChunkerBudgetTracker();
  const estimatedTokens = estimateTokensFromPrompt(prompt);
  const estimatedCost = computeEstimatedCostUsd(estimatedTokens);
  tracker.ensureAvailable(estimatedCost);
  tracker.reserve(estimatedCost);

  if (mockResponse) {
    tracker.settle(0);
    return {
      response: mockResponse,
      usage: { prompt_tokens: estimatedTokens, completion_tokens: 0, total_tokens: estimatedTokens },
      costUsd: 0,
      estimatedCostUsd: estimatedCost,
      retries: 0,
      fromCache: false,
    };
  }

  let attempt = 0;
  let lastError = null;
  let jitter = retryDelayMs;
  while (attempt < Math.max(1, maxRetries)) {
    attempt += 1;
    try {
      const { parsed, usage } = await executeCall(effectiveClient, prompt, { model, signal });
      const totalTokens = usage?.total_tokens || estimatedTokens;
      const actualCost = computeEstimatedCostUsd(totalTokens);
      tracker.settle(actualCost);
      return {
        response: parsed,
        usage,
        costUsd: actualCost,
        estimatedCostUsd: estimatedCost,
        retries: attempt - 1,
        fromCache: false,
      };
    } catch (error) {
      lastError = error;
      const status = error?.status || error?.code;
      const retriable =
        status === 429 ||
        status === 503 ||
        status === 500 ||
        (typeof status === 'string' && /^5/.test(status));
      if (!retriable || attempt >= maxRetries) {
        throw error;
      }
      await delay(jitter + Math.floor(Math.random() * 200));
      jitter *= 1.6;
    }
  }
  throw lastError || new Error('llm_call_failed');
}

