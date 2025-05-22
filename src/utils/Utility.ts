export function validateFeelingRating(value: string) {
  const exprPattern1 = '[PGUpgu][1-9]'; // Handles single letters followed by 1-9
  const exprPattern2 = '[PGUpgu]1[0-9]'; // Handles single letters followed by 10-19
  const exprPattern3 = '[PGUpgu]20'; // Handles single letters followed by 20

  const pguRegex = `(${exprPattern1}|${exprPattern2}|${exprPattern3})`;

  const rangeRegex = `^${pguRegex}(~|-)${pguRegex}$`;

  const legacyRegex =
    '^([1-9]|1[0-7])$|^(1[8-9]\\+?)$|^(20(\\.[0-9])?\\+?)$|^(21(\\.[0-4])?\\+?)$';

  const legacyRange =
    '^(([1-9]|1[0-7])|(1[8-9]\\+?)|(20(\\.[0-9])?\\+?)|(21(\\.[0-4])?\\+?))(~|-)(([1-9]|1[0-7])|(1[8-9]\\+?)|(20(\\.[0-9])?\\+?)|(21(\\.[0-4])?\\+?))$';

  const regex = new RegExp(
    `^$|^${pguRegex}$|^-2$|^${rangeRegex}$|^${legacyRegex}$|^${legacyRange}$`,
  );

  return regex.test(value);
}

export function validateSpeed(value: string) {
  const regex = new RegExp('^$|^1(.[0-9]+)?$');
  return regex.test(value);
}

export function validateNumber(value: string) {
  const regex = new RegExp('^\\d+$');
  return regex.test(value);
}
export function formatSpeed(speed: number) {
  const speedTwoDecimals = speed.toFixed(2);
  if (speedTwoDecimals[speedTwoDecimals.length - 1] !== '0') {
    return speedTwoDecimals;
  }
  const speedOneDecimal = speed.toFixed(1);
  if (speedOneDecimal[speedOneDecimal.length - 1] !== '0') {
    return speedOneDecimal;
  }
  return Math.round(speed);
}

export function formatScore(score: number) {
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(score);
}

export function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const ensureString = (value: any): string | undefined => {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value[0]?.toString();
  if (value?.toString) return value.toString();
  return undefined;
};

export const sanitizeTextInput = (input: string | null | undefined): string => {
  if (input === null || input === undefined) return '';
  return input.trim();
};