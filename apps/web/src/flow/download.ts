import type { LearnResult, Rules } from '@formatai/shared';

const MIME: Record<string, string> = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
  txt: 'text/plain',
};

/** `xlsx` when the rules don't say otherwise (SPEC 8.13). */
export function outputFileType(rules: LearnResult | Rules): 'xlsx' | 'csv' | 'txt' {
  return rules.output.file?.type ?? 'xlsx';
}

export function outputMimeType(type: string | undefined): string {
  return MIME[type ?? 'xlsx'] ?? 'application/octet-stream';
}

/** "Payments.xlsx" + csv rules -> "Payments (converted).csv". */
export function outputFileName(sourceName: string, rules: LearnResult | Rules): string {
  const base = sourceName.split(/[/\\]/).pop() ?? sourceName;
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return `${stem || 'output'} (converted).${outputFileType(rules)}`;
}

/** Saves bytes as a file through the browser. Nothing is uploaded: the Blob stays on this computer. */
export function downloadBytes(fileName: string, bytes: ArrayBuffer, mimeType: string): void {
  const url = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke after the click has been handled.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
