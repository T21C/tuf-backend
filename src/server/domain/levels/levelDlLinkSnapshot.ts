export function normalizeLevelDlLinkSnapshot(value: string | null | undefined): string | null {
  if (value == null) return null;
  const s = String(value).trim();
  return s.length ? s : null;
}
