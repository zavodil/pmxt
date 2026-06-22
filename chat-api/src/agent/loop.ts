import { config } from '../config';
import { chat, extractJson, stripJsonBlocks, type ChatMessage } from '../clients/llm';
import { systemPrompt } from './prompt';
import { executeTool } from './tools';
import { tierFor, toolsForTier, lockedToolsForTier, TOOL_CAPABILITY } from './tiers';
import type { Emit } from './types';

export interface RunTurnOpts {
  conversationId: string;
  userId: string;
  dial: number;
  history: ChatMessage[];
  userText: string;
  venue: string;
  emit: Emit;
  /** Pre-formatted note about markets already shown this conversation, so the
   *  agent can resolve "the second one" / "hide those" without re-searching. */
  recentMarkets?: string;
}

interface Action {
  action?: string;
  args?: Record<string, unknown>;
  say?: string;
}

/** ReAct loop: the model emits one JSON action per turn; we execute tools and feed results back. */
export async function runAgentTurn(opts: RunTurnOpts): Promise<string> {
  const { conversationId, userId, dial, history, userText, venue, emit } = opts;
  const tier = tierFor(userId);
  const allowedTools = toolsForTier(tier);
  const lockedCaps = lockedToolsForTier(tier)
    .map((t) => TOOL_CAPABILITY[t])
    .filter((c): c is string => Boolean(c));

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt(dial, allowedTools, tier, lockedCaps) },
    ...(opts.recentMarkets ? [{ role: 'system' as const, content: opts.recentMarkets }] : []),
    ...history,
    { role: 'user', content: userText },
  ];

  for (let step = 0; step < config.AGENT_MAX_STEPS; step++) {
    let content: string;
    try {
      content = await chat(messages);
    } catch (err) {
      emit({ type: 'error', message: `LLM error: ${(err as Error).message}` });
      return '';
    }

    const obj = extractJson(content) as Action | null;

    // No action / explicit final → reply to the user.
    if (!obj || !obj.action || obj.action === 'final') {
      const say =
        obj && typeof obj.say === 'string' && obj.say.trim() ? obj.say : salvageSay(content);
      emit({ type: 'message', text: say });
      return say;
    }

    emit({ type: 'step', tool: obj.action, args: obj.args ?? {} });

    let result: unknown;
    try {
      result = await executeTool(obj.action, obj.args ?? {}, { conversationId, userId, venue, allowedTools }, emit);
    } catch (err) {
      result = { error: (err as Error).message };
    }

    messages.push({ role: 'assistant', content });
    messages.push({
      role: 'user',
      content: `TOOL_RESULT(${obj.action}): ${JSON.stringify(result).slice(0, 16000)}`,
    });
  }

  // Steps exhausted — force a final answer from what we've gathered rather than
  // discarding it with a generic redirect.
  try {
    messages.push({
      role: 'user',
      content:
        'Stop calling tools. Using everything above, give your final answer to the user now as plain markdown — no JSON, no tool calls.',
    });
    const say = salvageSay(await chat(messages));
    emit({ type: 'message', text: say });
    return say;
  } catch {
    const fallback = 'Let me narrow it down — which market or topic are you interested in?';
    emit({ type: 'message', text: fallback });
    return fallback;
  }
}

// Never surface raw/broken JSON to the user. Pull a human reply out of model
// output that failed the JSON protocol (e.g. truncated), else a safe prompt.
function salvageSay(content: string): string {
  const m = content.match(/"say"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (m) {
    try {
      return JSON.parse(`"${m[1]}"`);
    } catch {
      return m[1]!;
    }
  }
  const stripped = stripJsonBlocks(content).trim();
  if (!stripped || stripped.startsWith('{') || stripped.startsWith('[')) {
    return 'I hit a snag forming that reply — could you rephrase or narrow it down?';
  }
  return stripped;
}
