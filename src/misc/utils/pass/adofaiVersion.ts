// tuf-search: #adofaiVersion #passEra
/** Frozen era ids stored on passes. Do not store "Alpha" — UI 3.4.0 maps to V3_4_0. */
export const ADOFAI_VERSION = {
  V2: 1,
  PRE_3_4_0: 2,
  V3_4_0: 3,
} as const;

export type AdofaiVersion = (typeof ADOFAI_VERSION)[keyof typeof ADOFAI_VERSION];

/** ADOFAI v3 release; uploads before this are v2 (last v2 day: 2026-04-30). */
export const ADOFAI_V3_RELEASE_UTC = Date.UTC(2026, 4, 1);

/** ADOFAI 3.4.0 release: 2026-09-11 08:00 GMT. */
export const ADOFAI_V3_4_0_RELEASE_UTC = Date.UTC(2026, 8, 11, 8, 0, 0);

export const ADOFAI_VERSION_SELECT_VALUES: AdofaiVersion[] = [
  ADOFAI_VERSION.V3_4_0,
  ADOFAI_VERSION.PRE_3_4_0,
  ADOFAI_VERSION.V2,
];

export function isAdofaiVersion(value: unknown): value is AdofaiVersion {
  return (
    value === ADOFAI_VERSION.V2 ||
    value === ADOFAI_VERSION.PRE_3_4_0 ||
    value === ADOFAI_VERSION.V3_4_0
  );
}

export function parseAdofaiVersion(raw: unknown, fallback: AdofaiVersion = ADOFAI_VERSION.V3_4_0): AdofaiVersion {
  const n = typeof raw === 'number' ? raw : Number(raw);
  return isAdofaiVersion(n) ? n : fallback;
}

/** Each stored era is shown as itself, so ≤3.3.1 stays distinct from 3.4.0. */
export function visualAdofaiVersion(version: number): number {
  return isAdofaiVersion(version) ? version : parseAdofaiVersion(version);
}

/** Store the era the picker selected. The same era keeps its stored id. */
export function keepStoredAdofaiVersion(selected: unknown, stored: unknown): AdofaiVersion {
  const next = parseAdofaiVersion(selected, ADOFAI_VERSION.V3_4_0);
  const current = parseAdofaiVersion(stored, next);
  if (visualAdofaiVersion(next) === visualAdofaiVersion(current)) {
    return current;
  }
  return next;
}

export function isLegacyAdofaiVersion(version: number): boolean {
  return version === ADOFAI_VERSION.V2 || version === ADOFAI_VERSION.PRE_3_4_0;
}

export function canUseXPerfectMode(version: number): boolean {
  return version === ADOFAI_VERSION.V3_4_0;
}

export function isAdofaiV2FromVersion(version: number): boolean {
  return version === ADOFAI_VERSION.V2;
}

export function resolveAdofaiVersionFromTimestamp(timestamp: unknown): AdofaiVersion {
  if (timestamp == null || timestamp === '') {
    return ADOFAI_VERSION.V3_4_0;
  }
  const ms =
    timestamp instanceof Date ? timestamp.getTime() : new Date(timestamp as string | number).getTime();
  if (!Number.isFinite(ms)) {
    return ADOFAI_VERSION.V3_4_0;
  }
  if (ms < ADOFAI_V3_RELEASE_UTC) {
    return ADOFAI_VERSION.V2;
  }
  return ADOFAI_VERSION.V3_4_0;
}

export function adofaiVersionFromLegacyFlag(isAdofaiV2: boolean | null | undefined): AdofaiVersion {
  return isAdofaiV2 ? ADOFAI_VERSION.V2 : ADOFAI_VERSION.PRE_3_4_0;
}

export function filterValueToAdofaiVersion(filter: string | null | undefined): AdofaiVersion | null {
  const versions = filterValueToAdofaiVersions(filter);
  return versions?.[0] ?? null;
}

export function filterValueToAdofaiVersions(filter: string | null | undefined): AdofaiVersion[] | null {
  switch (filter) {
    case 'v2':
      return [ADOFAI_VERSION.V2];
    case 'pre340':
    case 'latest':
      return [ADOFAI_VERSION.PRE_3_4_0, ADOFAI_VERSION.V3_4_0];
    default:
      return null;
  }
}
