import OpenAI from 'openai';

let client = null;

function isServer() {
  return typeof window === 'undefined';
}

export function isOpenAIConfigured() {
  return Boolean(isServer() && process.env.OPENAI_API_KEY);
}

export function getOpenAIClient() {
  if (!isOpenAIConfigured()) return null;
  if (!client) {
    client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return client;
}

export function resetOpenAIClient() {
  client = null;
}
