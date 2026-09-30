/** The one place the app leaves for another address (a sign-in provider). Kept apart so tests can watch it instead of navigating. */
export function redirectTo(url: string): void {
  window.location.assign(url);
}
