import { chat } from '../clients/llm';
import type { SidebarMarket } from './types';

const TONE: Record<number, string> = {
  1: 'Be skeptical and lead with risks.',
  2: 'Be cautious.',
  3: 'Be neutral and balanced.',
  4: 'Be constructive.',
  5: 'Be encouraging, but stay honest about risk.',
};

/** A single fast LLM call: comment on the markets already shown in the sidebar. */
export async function commentOnMarkets(prompt: string, markets: SidebarMarket[], dial: number): Promise<string> {
  const tone = TONE[dial] ?? TONE[3]!;

  if (markets.length === 0) {
    return chat([
      {
        role: 'system',
        content: `You are a prediction-market copilot. No markets matched the user's query. In 1-2 sentences ask them to broaden or rephrase and suggest a couple of angles. Reply in the user's language. ${tone}`,
      },
      { role: 'user', content: prompt },
    ]);
  }

  const list = markets.slice(0, 12).map((m) => ({ source: m.venue, title: m.title }));
  const sys =
    'You are a prediction-market copilot. Matching markets are ALREADY shown in the user\'s sidebar — do NOT list them all. ' +
    'In 2-4 short sentences: highlight 1-3 standouts by title, note the source (Polymarket/Limitless) when useful, and invite ' +
    'them to click one to discuss or bet. ' +
    'IMPORTANT: if the markets are only loosely or tangentially related to what the user asked (a different topic that merely ' +
    'shares a keyword), say so plainly — tell them there are no markets directly about their topic and that these are just the ' +
    'closest. Never invent a thesis to make an unrelated market sound relevant. ' +
    `Reply in the user's language. ${tone}`;
  const user = `User query: ${prompt}\n\nMarkets shown (JSON): ${JSON.stringify(list).slice(0, 2500)}`;
  return chat([
    { role: 'system', content: sys },
    { role: 'user', content: user },
  ]);
}
