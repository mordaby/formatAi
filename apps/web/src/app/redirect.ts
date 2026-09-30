import { suspendLeaveGuard } from './unloadPrompt';

/** The one place the app leaves for another address (a sign-in provider). Kept apart so tests can watch it instead of navigating. */
export function redirectTo(url: string): void {
  // Going to the provider keeps what has been learned (SPEC 5 E), so it is not "leaving with unsaved changes".
  suspendLeaveGuard();
  window.location.assign(url);
}
