import { suspendLeaveGuard } from './unloadPrompt';

/** The one place the app leaves for another address (a sign-in provider). Kept apart so tests can watch it instead of navigating. */
export function redirectTo(url: string): void {
  // Going to the provider keeps what has been learned (SPEC 5 E), so it is not "leaving with unsaved changes".
  suspendLeaveGuard();
  window.location.assign(url);
}

/** A sign-in that must not leave this page (its work is only in memory): the provider opens in a new tab, and this one stays as it is. */
export function openInNewTab(url: string): void {
  window.open(url, '_blank', 'noopener');
}
