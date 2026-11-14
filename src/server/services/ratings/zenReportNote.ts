export const ZEN_REPORT_NOTE_MAX = 500;

export function parseZenReportNote(value: unknown): string {
  const note = typeof value === 'string' ? value.trim().slice(0, ZEN_REPORT_NOTE_MAX) : '';
  if (!note) {
    const error = new Error('A note is required') as Error & {status?: number};
    error.status = 400;
    throw error;
  }
  return note;
}
