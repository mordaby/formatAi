// "Change the rule" opens the conversion's rules editor and comes back (SPEC 21 v5 item 5). The dropped file can't survive a
// page load, so it waits here, in memory only, while the user is in the editor; `/convert?resume=1` picks it up and
// converts again with the edited rules. Nothing is stored anywhere: a reload forgets it.
import type { Job } from './useConvertFlow';

export interface ConvertSession {
  file: File;
  /** The conversion under review when the user left for the editor: it is run again, with the rules as edited. */
  conversionId: string;
  formatId: string;
  /**
   * The rest of the run (SPEC 8.15): when the file feeds several formats, the queue, the results already made and the
   * renames confirmed for this run, so coming back continues where it stopped. Absent: just the one conversion is run again.
   */
  job?: Job;
  /**
   * The user left from a format that needs attention before anything had run (SPEC 21 v11 items 4-7): the file is checked again from the start,
   * against the format as edited, with every format still to be chosen.
   */
  again?: boolean;
}

let current: ConvertSession | null = null;

export const convertSession = {
  save(session: ConvertSession): void {
    current = session;
  },
  peek(): ConvertSession | null {
    return current;
  },
  clear(): void {
    current = null;
  },
};

/** The address of the conversion's rules editor (the other half of "Change the rule"; the route is /formats/:id/sources/:conversionId), with the way back. */
export function editSourceUrl(formatId: string, conversionId: string, returnTo: string): string {
  return `/formats/${encodeURIComponent(formatId)}/sources/${encodeURIComponent(conversionId)}?returnTo=${encodeURIComponent(returnTo)}`;
}
