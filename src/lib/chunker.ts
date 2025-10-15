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
  const parts = chunkText(text);
  const outputs: string[] = [];
  for (const [i, part] of parts.entries()) {
    const msgs = [
      ...messagesBase,
      { role: 'user', content: `Part ${i + 1}/${parts.length}:\n${part}` },
    ];
    const out = await chat(msgs, opts);
    outputs.push(out);
  }
  return outputs.join('\n');
}


