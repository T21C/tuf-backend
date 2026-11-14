export type CurationTypeFamilyRef = {
  id: number;
  name: string;
};

export type CurationFamilyTier = {
  letter: string;
  tier: number;
};

const FAMILY_LETTERS = 'CVOH';

/** C / V / O / H followed only by digits (e.g. `C0`, `V3`). Anything else is misc. */
export function parseCurationFamilyTier(name: string | null | undefined): CurationFamilyTier | null {
  const s = String(name ?? '').trim();
  if (!s.length) return null;
  const letter = s[0].toUpperCase();
  if (!FAMILY_LETTERS.includes(letter)) return null;
  const rest = s.slice(1);
  if (rest !== '' && !/^\d+$/.test(rest)) return null;
  const tier = rest === '' ? 0 : parseInt(rest, 10);
  if (!Number.isFinite(tier) || tier < 0) return null;
  return { letter, tier };
}

function sameIdSet(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  return a.every((id) => setB.has(id));
}

/**
 * Merge type lists so each C/V/O/H family keeps only the highest numeric tier.
 * Existing order is preserved (in-family winners replace in place); new families
 * and misc types from incoming are appended. Non-matching names stay additive.
 */
export function mergeCurationTypesByFamilyTier(
  existing: readonly CurationTypeFamilyRef[],
  incoming: readonly CurationTypeFamilyRef[],
): number[] {
  const bestByFamily = new Map<string, { id: number; tier: number }>();

  const consider = (ref: CurationTypeFamilyRef) => {
    const parsed = parseCurationFamilyTier(ref.name);
    if (!parsed) return;
    const current = bestByFamily.get(parsed.letter);
    if (!current || parsed.tier > current.tier) {
      bestByFamily.set(parsed.letter, { id: ref.id, tier: parsed.tier });
    }
  };

  for (const ref of existing) consider(ref);
  for (const ref of incoming) consider(ref);

  const out: number[] = [];
  const seen = new Set<number>();
  const emittedFamily = new Set<string>();

  const emit = (id: number) => {
    if (seen.has(id)) return;
    seen.add(id);
    out.push(id);
  };

  const emitRef = (ref: CurationTypeFamilyRef) => {
    const parsed = parseCurationFamilyTier(ref.name);
    if (!parsed) {
      emit(ref.id);
      return;
    }
    if (emittedFamily.has(parsed.letter)) return;
    emittedFamily.add(parsed.letter);
    const winner = bestByFamily.get(parsed.letter);
    emit(winner?.id ?? ref.id);
  };

  for (const ref of existing) emitRef(ref);
  for (const ref of incoming) emitRef(ref);

  return out;
}

export function curationTypeIdSetsEqual(a: number[], b: number[]): boolean {
  return sameIdSet(a, b);
}

/** C0/V0 are internal placeholders — never posted in curation announcements. */
export const SILENT_CURATION_ANNOUNCEMENT_NAMES = new Set(['C0', 'V0']);

export function isSilentCurationAnnouncementName(name: string | null | undefined): boolean {
  return SILENT_CURATION_ANNOUNCEMENT_NAMES.has(String(name ?? '').trim().toUpperCase());
}

export function announcedCurationTypeIds(
  ids: readonly number[],
  typesById: Map<number, {name?: string | null}>,
): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  for (const raw of ids) {
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0 || seen.has(id)) continue;
    seen.add(id);
    if (isSilentCurationAnnouncementName(typesById.get(id)?.name)) continue;
    out.push(id);
  }
  return out;
}

/** After dropping C0/V0, announce only when a visible type set actually changed. */
export function shouldAnnounceCurationTypeChange(
  beforeTypeIds: readonly number[],
  afterTypeIds: readonly number[],
): boolean {
  return afterTypeIds.length > 0 && !sameIdSet([...beforeTypeIds], [...afterTypeIds]);
}

export type CurationRatingBucket = 'chart' | 'vfx' | 'misc';

/** Chart = C/O, VFX = V, everything else (including H and Epic) is misc. */
export function curationTypeRatingBucket(name: string | null | undefined): CurationRatingBucket {
  const parsed = parseCurationFamilyTier(name);
  if (!parsed) return 'misc';
  if (parsed.letter === 'C' || parsed.letter === 'O') return 'chart';
  if (parsed.letter === 'V') return 'vfx';
  return 'misc';
}
