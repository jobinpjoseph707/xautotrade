/**
 * The chat agents. Each is a role prompt plus a whitelist of the actions it may
 * PROPOSE. Nothing here changes anything: every proposal waits for the user's
 * approval in the app.
 */

export type AgentId = 'strategist' | 'optimizer' | 'doctor' | 'guard' | 'critic';
export type ActionType = 'create_strategy' | 'update_strategy' | 'delete_strategy' | 'start_bot' | 'stop_bot';

export interface AgentDef {
  id: AgentId;
  name: string;
  tagline: string;
  role: string;
  allowed: ActionType[];
  /** When true, updates may only tighten risk gates (enforced server-side). */
  tightenOnly?: boolean;
  /**
   * Model this agent runs on (backend-specific id, e.g. "sonnet"). Overridable
   * per agent with env AGENT_MODEL_<ID> or for all with CHAT_MODEL. Recorded on
   * every outcome so results can be compared per model later.
   */
  model?: string;
}

export const AGENTS: AgentDef[] = [
  {
    id: 'strategist',
    name: 'Strategist',
    tagline: 'Creates new strategies from a plain-language idea',
    role:
      'You design NEW trading strategies. Turn the user\'s idea into a complete, valid strategy using only the supported indicators and rule format. ' +
      'Prefer simple, testable rules with explicit numbers. If the idea is vague, make sensible concrete choices and say what you chose. ' +
      'Always include stop-loss and take-profit, keep lot size minimal (0.01) unless told otherwise, and remind the user it must be backtested and demo-tested first.',
    allowed: ['create_strategy'],
  },
  {
    id: 'optimizer',
    name: 'Optimizer',
    tagline: 'Tunes and modifies an existing strategy',
    role:
      'You IMPROVE existing strategies. Choose ONE deliberate, explainable change per proposal (an indicator period, a threshold, a stop/target distance, a session filter) and explain the reasoning. ' +
      'Do not shuffle parameters randomly. Base changes on the BACKTEST RESULTS when provided, and remind the user to ask for a re-backtest after approving, because you cannot test a change before it is applied. You may also propose a cloned variant as a new strategy if the user wants to keep the original.',
    allowed: ['update_strategy', 'create_strategy', 'start_bot'],
  },
  {
    id: 'doctor',
    name: 'Strategy Doctor',
    tagline: 'Diagnoses what is not working; can stop or remove strategies',
    role:
      'You REVIEW strategies and bots. Use the recent activity, bot status and BACKTEST RESULTS you are given to explain what is going wrong (errors, no trades, losing pattern). When asked which strategies to keep, rank them by the backtest evidence and propose deleting duplicates and clear losers, but say plainly when the trade count is too low to judge. ' +
      'Be honest when data is too thin to judge. You may propose a fix (update), stopping a bot, or deleting a strategy that is clearly broken or unwanted. Never propose deleting without saying why.',
    allowed: ['update_strategy', 'stop_bot', 'delete_strategy'],
  },
  {
    id: 'guard',
    name: 'Risk Guard',
    tagline: 'Audits risk settings; can only make things safer',
    role:
      'You are the RISK GUARD. Audit lot sizes, stop distances, daily loss cap, spread cap, trade limits and exposure across strategies and bots. ' +
      'You may only propose changes that make risk SAFER (smaller size, tighter stops, lower daily caps, fewer trades, stopping a bot). You must never loosen any limit.',
    allowed: ['update_strategy', 'stop_bot'],
    tightenOnly: true,
  },
  {
    id: 'critic',
    name: 'Critic',
    tagline: 'Argues against proposals before you approve them',
    role:
      'You are the CRITIC. You review proposals and strategies skeptically: too few trades to judge, too many changes at once, fitting recent noise, repeating past failures. ' +
      'When the user asks you directly, give an honest, specific critique of their strategies or of a change they are considering. You never propose actions.',
    allowed: [],
  },
];

/** The model an agent runs on right now (env overrides the definition). */
export function agentModel(a: AgentDef, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env[`AGENT_MODEL_${a.id.toUpperCase()}`] || a.model || env.CHAT_MODEL || undefined;
}

export function getAgent(id: string): AgentDef | undefined {
  return AGENTS.find((a) => a.id === id);
}

/** The four buttons on a strategy's chat. Each one is a fixed choice of agent, no guessing. */
export const CHAT_BUTTONS = {
  tune: 'optimizer',
  diagnose: 'doctor',
  tighten: 'guard',
  critique: 'critic',
} as const satisfies Record<string, AgentId>;
export type ChatButton = keyof typeof CHAT_BUTTONS;

export const isChatButton = (v: unknown): v is ChatButton => typeof v === 'string' && Object.prototype.hasOwnProperty.call(CHAT_BUTTONS, v);

/** What a button sends when the user taps it without typing anything. */
export const BUTTON_MESSAGE: Record<ChatButton, string> = {
  tune: 'Suggest one well-reasoned improvement to this strategy. If you want to test it first, ask for a what-if backtest.',
  diagnose: 'What is going on with this strategy? Is it working, and if not, why?',
  tighten: 'Audit the risk settings of this strategy and propose a safer setting if one is needed.',
  critique: 'Give me an honest critique of this strategy. What would make you distrust its results?',
};

/** Agents a free-text message may be sent to. The Strategist only when the chat is not about one strategy. */
const ROUTABLE_SCOPED: AgentId[] = ['optimizer', 'doctor', 'guard', 'critic'];
const ROUTABLE_GENERAL: AgentId[] = ['strategist', ...ROUTABLE_SCOPED];

/** The agent to use when the router cannot decide. It can only propose small fixes or stop things, never tighten-only bypass. */
export const FALLBACK_AGENT: AgentId = 'doctor';

export function routerPrompt(message: string, scoped: boolean): string {
  const options = (scoped ? ROUTABLE_SCOPED : ROUTABLE_GENERAL).map((id) => `- ${id}: ${getAgent(id)!.tagline}`).join('\n');
  return (
    'Choose which assistant should answer the user\'s message. Reply with JSON only, like {"agent":"doctor"}.\n' +
    `Options:\n${options}\n\nUser message:\n${message.slice(0, 1000)}`
  );
}

/** Read the router's answer. Anything that is not a listed agent returns null. */
export function parseRouterAnswer(text: string, scoped: boolean): AgentId | null {
  const m = text.match(/\{[^{}]*\}/);
  if (!m) return null;
  try {
    const id = (JSON.parse(m[0]) as { agent?: unknown }).agent;
    const allowed = scoped ? ROUTABLE_SCOPED : ROUTABLE_GENERAL;
    return typeof id === 'string' && (allowed as string[]).includes(id) ? (id as AgentId) : null;
  } catch {
    return null;
  }
}
