// SPEC 9.4/9.6: the model registry, per LLM provider. These are starting candidates
// to benchmark with the eval harness (M1), not settled decisions - the harness picks
// the final slot fillers (SPEC 10 "Initial decision rule").
//
// SPEC 9.6: providers are pluggable, selected from env `LLM_PROVIDER`. 'fake' is not
// a real provider - it returns canned responses for tests and the eval dry run.

export const LLM_PROVIDERS = ['anthropic', 'openai', 'claude-cli', 'fake'] as const;
export type LlmProviderName = (typeof LLM_PROVIDERS)[number];

export interface ModelSlots {
  firstTry: string;
  escalation: string;
}

export const models: Record<LlmProviderName, ModelSlots> = {
  anthropic: {
    firstTry: 'claude-haiku-4-5-20251001',
    // DECISION: SPEC 9.4/20 lists the escalation candidate as "claude-sonnet-5-5",
    // which is not a real model id. The current released model in that slot is
    // "claude-sonnet-5" - using that here. Revisit once the eval harness (M1)
    // picks the actual escalation model per SPEC 10's decision rule.
    escalation: 'claude-sonnet-5',
  },
  // TODO(M1): placeholders - verify these are the current small/large OpenAI models
  // (against the installed `openai` SDK's model types, or the OpenAI models page)
  // before benchmarking. Not decisions yet, same as the Anthropic slots above.
  openai: {
    firstTry: 'gpt-5-mini',
    escalation: 'gpt-5',
  },
  // Model aliases the Claude Code CLI understands via `--model` (SPEC 9.6 dev-only
  // "claude-cli" provider, runs on the developer's own subscription).
  'claude-cli': {
    firstTry: 'haiku',
    escalation: 'sonnet',
  },
  // Never used for real pricing/behavior lookups - only default model ids a test can
  // read when it doesn't care what string is used.
  fake: {
    firstTry: 'fake-first-try',
    escalation: 'fake-escalation',
  },
};
