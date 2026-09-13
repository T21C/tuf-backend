// tuf-search: #adofaiVersion #passEra
/** Frozen era ids stored on passes. Do not store "Latest" — UI Latest maps to V3_4_0. */
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

export function parseAdofaiVersion(raw: unknown, fallback: AdofaiVersion = ADOFAI_VERSION.PRE_3_4_0): AdofaiVersion {
  const n = typeof raw === 'number' ? raw : Number(raw);
  return isAdofaiVersion(n) ? n : fallback;
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
  if (ms < ADOFAI_V3_4_0_RELEASE_UTC) {
    return ADOFAI_VERSION.PRE_3_4_0;
  }
  return ADOFAI_VERSION.V3_4_0;
}

export function adofaiVersionFromLegacyFlag(isAdofaiV2: boolean | null | undefined): AdofaiVersion {
  return isAdofaiV2 ? ADOFAI_VERSION.V2 : ADOFAI_VERSION.PRE_3_4_0;
}

export function filterValueToAdofaiVersion(filter: string | null | undefined): AdofaiVersion | null {
  switch (filter) {
    case 'v2':
      return ADOFAI_VERSION.V2;
    case 'pre340':
      return ADOFAI_VERSION.PRE_3_4_0;
    case 'latest':
      return ADOFAI_VERSION.V3_4_0;
    default:
      return null;
  }
}
