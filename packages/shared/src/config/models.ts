// SPEC 9.4: the model registry. These are starting candidates to benchmark with
// the eval harness (M1), not settled decisions - the harness picks the final
// slot fillers (SPEC 10 "Initial decision rule").

export interface ModelRegistry {
  firstTry: string;
  escalation: string;
}

export const models: ModelRegistry = {
  firstTry: 'claude-haiku-4-5-20251001',
  // DECISION: SPEC 9.4/20 lists the escalation candidate as "claude-sonnet-5-5",
  // which is not a real model id. The current released model in that slot is
  // "claude-sonnet-5" - using that here. Revisit once the eval harness (M1)
  // picks the actual escalation model per SPEC 10's decision rule.
  escalation: 'claude-sonnet-5',
};
