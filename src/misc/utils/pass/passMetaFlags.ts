// tuf-search: #passMetaFlags #passProcessing
/** Processing bits on passes / pass_submission_flags. Low bits first; not permissionFlags. */
export const passMetaFlags = {
  MIDSPIN_PERFECTS_REMOVED: 1n << 0n,
} as const;

export type PassMetaFlag = (typeof passMetaFlags)[keyof typeof passMetaFlags];

export function toPassMetaFlags(value: unknown): bigint {
  if (value == null || value === '') return 0n;
  try {
    return BigInt(value as string | number | bigint);
  } catch {
    return 0n;
  }
}

export function hasPassMetaFlag(flags: unknown, bit: bigint): boolean {
  const n = toPassMetaFlags(flags);
  return (n & bit) === bit;
}

export function addPassMetaFlag(flags: unknown, bit: bigint): bigint {
  return toPassMetaFlags(flags) | bit;
}

export function passMetaFlagsToDb(flags: unknown): string {
  return toPassMetaFlags(flags).toString();
}
