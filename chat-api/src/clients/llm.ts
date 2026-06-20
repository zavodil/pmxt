import { config } from '../config';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** One OpenAI-compatible chat completion (local-claude proxy / OpenAI / any). */
export async function chat(messages: ChatMessage[], temperature = config.AGENT_TEMPERATURE): Promise<string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (config.AI_API_KEY) headers.authorization = `Bearer ${config.AI_API_KEY}`;

  const res = await fetch(`${config.AI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: config.AI_MODEL,
      temperature,
      // Headroom for a full markdown reply embedded in the JSON `say` field —
      // 2048 truncated long answers, producing unparseable JSON shown raw.
      max_tokens: 4096,
      messages,
    }),
  });
  if (!res.ok) throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return json.choices?.[0]?.message?.content ?? '';
}

/** Extract the first balanced top-level JSON object from an LLM reply (tolerates fences/prose). */
export function extractJson(text: string): unknown {
  let s = text.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) s = fence[1].trim();

  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  // Rebuild the object, escaping raw control chars inside strings — LLMs often emit
  // literal newlines/tabs in a JSON string value, which is invalid and breaks JSON.parse.
  let out = '';
  for (let i = start; i < s.length; i++) {
    const ch = s[i]!;
    if (inStr) {
      if (esc) {
        out += ch;
        esc = false;
        continue;
      }
      if (ch === '\\') {
        out += ch;
        esc = true;
        continue;
      }
      if (ch === '"') {
        out += ch;
        inStr = false;
        continue;
      }
      if (ch === '\n') out += '\\n';
      else if (ch === '\r') out += '\\r';
      else if (ch === '\t') out += '\\t';
      else out += ch;
      continue;
    }
    out += ch;
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(out);
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** Remove fenced ```json blocks so raw JSON is never shown to the user as prose. */
export function stripJsonBlocks(text: string): string {
  return text.replace(/```(?:json)?\s*[\s\S]*?```/gi, '').trim();
}
