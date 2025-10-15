export type ChatMsg = { role: 'user' | 'assistant' | 'system'; content: string };

// Keep as constant or read from plugin params if available
const OPENAI_URL = 'https://nextjs-boilerplate-eta-one-g2a7iag23k.vercel.app/api/openai-proxy';

export async function chatComplete(
  messages: ChatMsg[],
  opts: {
    model?: string;
    temperature?: number;
    maxTokens?: number;
    extra?: Record<string, any>;
  } = {}
) {
  const payload: any = {
    model: opts.model || 'gpt-4o-mini-2024-07-18',
    messages,
    temperature: opts.temperature ?? 0.2,
    ...(opts.maxTokens != null ? { max_completion_tokens: opts.maxTokens } : {}),
    ...(opts.extra || {}),
  };

  const resp = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Proxy error ${resp.status}: ${text}`);
  }
  const data = await resp.json();
  const cc = data?.choices?.[0];
  const fromChat = cc?.message?.content || cc?.text;
  const fromResponses = data?.output_text || data?.output?.[0]?.content?.[0]?.text;
  return fromChat ?? fromResponses ?? '';
}


