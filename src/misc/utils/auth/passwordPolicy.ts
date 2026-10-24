/** Password composition + common-password rules — keep in sync with client/src/utils/passwordPolicy.js */

export const PASSWORD_REQUIREMENT_IDS = [
  'missingLength',
  'missingLower',
  'missingUpper',
  'missingDigit',
  'missingSymbol',
] as const;

export type PasswordRequirementId = (typeof PASSWORD_REQUIREMENT_IDS)[number];
export type PasswordRating = 'weak' | 'fair' | 'strong' | 'common';

export type PasswordEvaluation = {
  requirements: Record<PasswordRequirementId, {met: boolean}>;
  missing: PasswordRequirementId[];
  common: boolean;
  compositionValid: boolean;
  acceptable: boolean;
  rating: PasswordRating;
  metCount: number;
};

/**
 * Each clause is a lookahead when the rule is met, or an empty named group when
 * it is missing. A group value of "" means missing; undefined means met.
 */
export const PASSWORD_REQUIREMENT_REGEX =
  /^(?:(?=[\s\S]{8,})|(?<missingLength>))(?:(?=[\s\S]*[a-z])|(?<missingLower>))(?:(?=[\s\S]*[A-Z])|(?<missingUpper>))(?:(?=[\s\S]*[0-9])|(?<missingDigit>))(?:(?=[\s\S]*[^A-Za-z0-9\s])|(?<missingSymbol>))/;

/**
 * NCSC 100k entries that already satisfy every composition rule. Exact match only.
 */
export const COMMON_PASSWORDS: readonly string[] = Object.freeze([
  'N0=Acc3ss',
  'N8ZGT5P0sHw=',
  'P@ssw0rd',
  'ka_dJKHJsy6',
  '1qaz!QAZ',
  'Doomsayer.2.7mords.V',
  'Doomsayer.2.7mords.VV',
  '!QAZ2wsx',
  '1qaz@WSX',
  '!QAZ1qaz',
  'fxzZ75$yer',
  'Pa$$w0rd',
  'Aug!272010',
  'L58jkdjP!m',
  'ZV_!80lo',
  'S9QxA9Yn9Cc=',
  'P@$$w0rd',
  'ZAQ!2wsx',
  'zaq1@WSX',
  '6D2-24E5r',
  'g00dPa$$w0rD',
  'Password1!',
  '!QAZxsw2',
  '1qazZAQ!',
  'Feder_1941',
  'P@ssword1',
  'P@55w0rd',
  '1qazXSW@',
  '$HEX[687474703a2f2f616473]',
  'India@123',
  'friendofEarning$1',
  '$HEX[687474703a2f2f777777]',
  'Sym_cskill1',
  'Abc123456!',
  'friendofYOUCANMAKE$200-',
  'P@55word',
  'Password@123',
]);

const COMMON_PASSWORD_SET = new Set(COMMON_PASSWORDS);

const REQUIREMENT_LABELS: Record<PasswordRequirementId, string> = {
  missingLength: 'at least 8 characters',
  missingLower: 'a lowercase letter',
  missingUpper: 'an uppercase letter',
  missingDigit: 'a number',
  missingSymbol: 'a symbol',
};

export function missingPasswordRequirements(password: unknown): PasswordRequirementId[] {
  const value = typeof password === 'string' ? password : '';
  const match = PASSWORD_REQUIREMENT_REGEX.exec(value);
  if (!match?.groups) {
    return [...PASSWORD_REQUIREMENT_IDS];
  }
  return PASSWORD_REQUIREMENT_IDS.filter((id) => match.groups?.[id] !== undefined);
}

export function evaluatePassword(password: unknown): PasswordEvaluation {
  const value = typeof password === 'string' ? password : '';
  const missing = missingPasswordRequirements(value);
  const requirements = Object.fromEntries(
    PASSWORD_REQUIREMENT_IDS.map((id) => [id, {met: !missing.includes(id)}]),
  ) as PasswordEvaluation['requirements'];
  const metCount = PASSWORD_REQUIREMENT_IDS.length - missing.length;
  const compositionValid = missing.length === 0;
  const common = compositionValid && COMMON_PASSWORD_SET.has(value);
  let rating: PasswordRating = 'weak';
  if (common) {
    rating = 'common';
  } else if (metCount >= 5) {
    rating = 'strong';
  } else if (metCount >= 3) {
    rating = 'fair';
  }
  return {
    requirements,
    missing,
    common,
    compositionValid,
    acceptable: compositionValid && !common,
    rating,
    metCount,
  };
}

export function passwordRejection(
  password: unknown,
): {message: string; code: 'PASSWORD_REQUIREMENTS' | 'PASSWORD_COMMON'} | null {
  const evaluation = evaluatePassword(password);
  if (evaluation.acceptable) return null;
  if (evaluation.common) {
    return {message: 'This password is too common', code: 'PASSWORD_COMMON'};
  }
  const list = evaluation.missing.map((id) => REQUIREMENT_LABELS[id]).join(', ');
  return {message: `Password is missing: ${list}`, code: 'PASSWORD_REQUIREMENTS'};
}
