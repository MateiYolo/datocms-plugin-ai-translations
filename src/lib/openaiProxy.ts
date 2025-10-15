export type ChatMsg = { role: 'user' | 'assistant' | 'system'; content: string };

const OPENAI_URL = 'https://nextjs-boilerplate-eta-one-g2a7iag23k.vercel.app/api/openai-proxy';

export async function chatComplete(
  messages: ChatMsg[],
  model = 'gpt-4o-mini',
  temperature = 0.2,
  maxTokens = 800
) {
  const resp = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens })
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Proxy error ${resp.status}: ${text}`);
  }
  const data = await resp.json();
  return data.choices?.[0]?.message?.content ?? '';
}


