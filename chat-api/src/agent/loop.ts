import { config } from '../config';
import { chat, extractJson, stripJsonBlocks, type ChatMessage } from '../clients/llm';
import { systemPrompt } from './prompt';
import { executeTool } from './tools';
import type { Emit } from './types';

export interface RunTurnOpts {
  conversationId: string;
  userId: string;
  dial: number;
  history: ChatMessage[];
  userText: string;
  venue: string;
  emit: Emit;
}

interface Action {
  action?: string;
  args?: Record<string, unknown>;
  say?: string;
}

/** ReAct loop: the model emits one JSON action per turn; we execute tools and feed results back. */
export async function runAgentTurn(opts: RunTurnOpts): Promise<string> {
  const { conversationId, userId, dial, history, userText, venue, emit } = opts;

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt(dial) },
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
        obj && typeof obj.say === 'string' && obj.say.trim()
          ? obj.say
          : stripJsonBlocks(content) || content;
      emit({ type: 'message', text: say });
      return say;
    }

    emit({ type: 'step', tool: obj.action, args: obj.args ?? {} });

    let result: unknown;
    try {
      result = await executeTool(obj.action, obj.args ?? {}, { conversationId, userId, venue }, emit);
    } catch (err) {
      result = { error: (err as Error).message };
    }

    messages.push({ role: 'assistant', content });
    messages.push({
      role: 'user',
      content: `TOOL_RESULT(${obj.action}): ${JSON.stringify(result).slice(0, 4000)}`,
    });
  }

  const fallback = "Let me narrow it down — which market or topic are you interested in?";
  emit({ type: 'message', text: fallback });
  return fallback;
}
