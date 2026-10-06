// What a save sends of the rules - the browser's own guarantee at the boundary, applied by the API clients to the rules of EVERY save (a new
// format, a new source, a new version from the editor or from the Run screen's "Do this every time?"), so that no screen can miss it:
//   - never the AI's explanation or function request (SPEC 15, learn-v7: `stripAiNotes`; the API strips them as well);
//   - never a lookup table or a value map nothing in the rules reads any more (owner rule, 2026-10-06: `withoutUnreadLists`) - a list copied
//     from the example whose column was left empty by hand goes with it, so its copied values are never stored.
// The file the rules make is the same either way; rules with nothing to take out are sent as they are.
import { stripAiNotes, withoutUnreadLists, type LearnResult, type Rules } from '@formatai/shared';

export function savedRules<R extends Rules | LearnResult>(rules: R): R {
  return withoutUnreadLists(stripAiNotes(rules));
}
