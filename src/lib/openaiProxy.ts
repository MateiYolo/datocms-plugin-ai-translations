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
    model: opts.model || 'gpt-5',
    messages,
    ...(opts.maxTokens != null ? { max_completion_tokens: opts.maxTokens } : {}),
    ...(opts.extra || {}),
  };

  // Retry on transient errors
  const transientStatus = new Set([408, 429, 500, 502, 503, 504]);
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const resp = await fetch(OPENAI_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!resp.ok) {
        if (transientStatus.has(resp.status) && attempt < 3) {
          await new Promise((r) => setTimeout(r, 300 * attempt));
          continue;
        }
        const text = await resp.text().catch(() => '');
        throw new Error(`Proxy error ${resp.status}: ${text}`);
      }
      const data = await resp.json();
      const cc = data?.choices?.[0];
      const fromChat = cc?.message?.content || cc?.text;
      const fromResponses = data?.output_text || data?.output?.[0]?.content?.[0]?.text;
      return fromChat ?? fromResponses ?? '';
    } catch (err) {
      lastError = err;
      // Retry TypeError network failures
      if (err instanceof TypeError && attempt < 3) {
        await new Promise((r) => setTimeout(r, 300 * attempt));
        continue;
      }
      throw err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Proxy request failed');
}


