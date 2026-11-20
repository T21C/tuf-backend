/**
 * Server copy of the profile accuracy renderer. Badge confirm text is built
 * here so the client never learns a secret digit pattern.
 */
export function formatAccuracyRatio(ratio: number | null | undefined, withPercent = true): string {
  const suffix = withPercent ? '%' : '';
  const value = Number(ratio);
  if (!Number.isFinite(value)) return `0${suffix}`;
  if (value >= 1) return `100${suffix}`;
  if (value <= 0) return `${(0).toFixed(2)}${suffix}`;

  const minDecimals = 2;
  const inspect = 12;
  const fixed = (value * 100).toFixed(inspect);
  const [intPart, decRaw = ''] = fixed.split('.');
  if (Number(intPart) >= 100) return `100${suffix}`;

  let leadingNines = 0;
  if (intPart === '99') {
    while (leadingNines < decRaw.length && decRaw[leadingNines] === '9') leadingNines += 1;
  }
  const rounded = Number(fixed).toFixed(minDecimals);
  const needsNearPerfect =
    Number(rounded) >= 100 || (intPart === '99' && leadingNines >= minDecimals);
  if (needsNearPerfect) {
    const keep = Math.min(inspect, Math.max(minDecimals, leadingNines + 1));
    const decPart = decRaw.slice(0, keep).padEnd(keep, '0');
    return `${intPart}.${decPart}${suffix}`;
  }
  return `${rounded}${suffix}`;
}

export function formatJudgementLine(counts: number[]): string {
  return counts.join(' ');
}
