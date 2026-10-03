// "Unsaved changes" and leaving the page: the browser's own "Leave site?" prompt for closing the tab or reloading (see LeaveGuard.tsx
// for the in-app routes). The app's own full-page trips - the sign-in redirect, which keeps what has been learned first - are not
// something to warn about, so they switch the prompt off just before they go.

let suspended = false;
let timer: ReturnType<typeof setTimeout> | undefined;

/** The prompt is on again (the trip never happened, or a test is starting over). */
export function resumeLeaveGuard(): void {
  suspended = false;
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
}

/** The page is about to leave on purpose (and has kept what it needs): no prompt. Comes back on by itself in case the trip never happens. */
export function suspendLeaveGuard(): void {
  resumeLeaveGuard();
  suspended = true;
  timer = setTimeout(resumeLeaveGuard, 3000);
}

/** The `beforeunload` handler: asks the browser to confirm, unless a deliberate trip is under way. */
export function confirmUnload(e: BeforeUnloadEvent): void {
  if (suspended) return;
  e.preventDefault();
  // Older browsers need a value; none shows this text (they use their own).
  e.returnValue = '';
}
