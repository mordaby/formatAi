// "Change the rule" opens the source's rules editor and comes back (SPEC 21 v5 item 5). The dropped file can't survive a
// page load, so it waits here, in memory only, while the user is in the editor; `/convert?resume=1` picks it up and
// converts again with the edited rules. Nothing is stored anywhere: a reload forgets it.
export interface ConvertSession {
  file: File;
  conversionId: string;
  formatId: string;
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

/** The address of the source's rules editor (the other half of "Change the rule"; the route is /formats/:id/sources/:conversionId), with the way back. */
export function editSourceUrl(formatId: string, conversionId: string, returnTo: string): string {
  return `/formats/${encodeURIComponent(formatId)}/sources/${encodeURIComponent(conversionId)}?returnTo=${encodeURIComponent(returnTo)}`;
}
