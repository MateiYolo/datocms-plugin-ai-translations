export function chunkText(s: string, size = 6000) {
  const chunks: string[] = [];
  for (let i = 0; i < s.length; i += size) chunks.push(s.slice(i, i + size));
  return chunks;
}

export async function translateLarge(
  messagesBase: any[],
  text: string,
  chat: (msgs: any[], opts: any) => Promise<string>,
  opts: any
) {
  // Use smaller chunks for safety
  const parts = chunkText(text, 3000);
  const out: string[] = new Array(parts.length);
  let i = 0;

  async function worker() {
    while (i < parts.length) {
      const idx = i++;
      const msgs = [
        ...messagesBase,
        { role: 'user', content: `Part ${idx + 1}/${parts.length}:\n${parts[idx]}` },
      ];
      out[idx] =
        (await chat(msgs, { ...opts, maxTokens: opts?.maxTokens ?? 800 })) || '';
      // tiny pacing to avoid bursts
      await new Promise((r) => setTimeout(r, 80));
    }
  }

  // Per-field concurrency = 2
  await Promise.all([worker(), worker()]);
  return out.join('\n');
}


