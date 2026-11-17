export const PASS_DIFFICULTY_SUBTYPES = ['P', 'G', 'U', 'GQ', 'UQ', 'QQ', 'Etc.'] as const;
export type PassDifficultySubtype = (typeof PASS_DIFFICULTY_SUBTYPES)[number];

const SUBTYPE_SET = new Set<string>(PASS_DIFFICULTY_SUBTYPES);

function leadingToken(name: string): string {
  const raw = String(name || '').trim();
  if (!raw) return '';
  const cut = raw.search(/[\s(]/);
  return (cut === -1 ? raw : raw.slice(0, cut)).toUpperCase();
}

/** P, G, U, GQ, UQ, QQ, or Etc. from a level difficulty name. */
export function passDifficultySubtype(name: string | null | undefined): PassDifficultySubtype {
  const token = leadingToken(String(name || ''));
  if (!token) return 'Etc.';
  if (token.startsWith('GQ')) return 'GQ';
  if (token.startsWith('UQ')) return 'UQ';
  if (token === 'QQ' || /^Q[0-4]$/.test(token)) return 'QQ';
  if (/^P\d+$/.test(token)) return 'P';
  if (/^G\d+$/.test(token)) return 'G';
  if (/^U\d+$/.test(token)) return 'U';
  return 'Etc.';
}

export function isPassDifficultySubtype(value: string): value is PassDifficultySubtype {
  return SUBTYPE_SET.has(value);
}

export function parseHiddenPassDifficultySubtypes(raw: unknown): PassDifficultySubtype[] | { error: string } {
  const text = Array.isArray(raw) ? raw.map(String).join(',') : typeof raw === 'string' ? raw : '';
  const parts = text.split(',').map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return [];
  const unique: PassDifficultySubtype[] = [];
  for (const part of parts) {
    if (!isPassDifficultySubtype(part)) return { error: 'Invalid hide' };
    if (!unique.includes(part)) unique.push(part);
  }
  unique.sort(
    (a, b) => PASS_DIFFICULTY_SUBTYPES.indexOf(a) - PASS_DIFFICULTY_SUBTYPES.indexOf(b),
  );
  return unique;
}
