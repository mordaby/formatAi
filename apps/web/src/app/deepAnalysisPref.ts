// "Deep analysis with AI if needed" (Home's checkbox): off until a signed-in user turns it on, and remembered in this browser only.
// Storage can be missing or blocked (private windows, blocked site data): reading then says "off", writing is skipped.
const KEY = 'formatai.deepAnalysis';

export function readDeepAnalysis(): boolean {
  try {
    return window.localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export function writeDeepAnalysis(on: boolean): void {
  try {
    window.localStorage.setItem(KEY, on ? '1' : '0');
  } catch {
    // not remembered: it still holds for this visit
  }
}
