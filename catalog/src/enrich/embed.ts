import { config } from '../config';

/** Embed a batch of documents. Throws if EMBEDDINGS_PROVIDER=none. */
export async function embed(texts: string[]): Promise<number[][]> {
  if (config.EMBEDDINGS_PROVIDER === 'none') {
    throw new Error('embeddings disabled (EMBEDDINGS_PROVIDER=none)');
  }
  if (config.EMBEDDINGS_PROVIDER === 'voyage') return voyage(texts, 'document');
  return openai(texts);
}

/** Embed a single query string (provider-aware input_type for Voyage). */
export async function embedQuery(text: string): Promise<number[]> {
  if (config.EMBEDDINGS_PROVIDER === 'voyage') {
    const [v] = await voyage([text], 'query');
    return v!;
  }
  const [v] = await embed([text]);
  return v!;
}

export function toVectorLiteral(v: number[]): string {
  return `[${v.join(',')}]`;
}

async function voyage(input: string[], inputType: 'document' | 'query'): Promise<number[][]> {
  if (!config.VOYAGE_API_KEY) throw new Error('VOYAGE_API_KEY is not set');
  const res = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.VOYAGE_API_KEY}`,
    },
    body: JSON.stringify({ model: config.EMBED_MODEL, input, input_type: inputType }),
  });
  if (!res.ok) throw new Error(`voyage ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = (await res.json()) as { data: { embedding: number[] }[] };
  return json.data.map((d) => d.embedding);
}

async function openai(input: string[]): Promise<number[][]> {
  if (!config.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not set');
  // text-embedding-3-* accept `dimensions` to match our pgvector column width
  // (3-large is 3072 native → reduced to EMBED_DIM, e.g. 1024). Base URL is
  // configurable so the same path works for OpenAI, OpenRouter, or a local model.
  const body: Record<string, unknown> = { model: config.EMBED_MODEL, input };
  if (config.EMBED_DIM) body.dimensions = config.EMBED_DIM;
  const res = await fetch(`${config.EMBED_BASE_URL}/embeddings`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.OPENAI_API_KEY}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`openai ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = (await res.json()) as { data: { embedding: number[] }[] };
  return json.data.map((d) => d.embedding);
}
