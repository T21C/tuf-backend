import { z } from 'zod';

export const AUTO_SUBMISSION_DENIAL_REASONS = {
  DISABLED: 'auto_submission_disabled',
  TESTER_REQUIRED: 'auto_submission_tester_required',
} as const;

export type AutoSubmissionDenialReason =
  (typeof AUTO_SUBMISSION_DENIAL_REASONS)[keyof typeof AUTO_SUBMISSION_DENIAL_REASONS];

type AutoSubmissionPolicyEnvironment = Partial<Pick<
  NodeJS.ProcessEnv,
  'AUTO_SUBMISSION_ENABLED' | 'AUTO_SUBMISSION_TRUSTED_USER_IDS'
>>;

const uuidSchema = z.uuid();

function parseEnabled(raw: string | undefined): boolean {
  switch ((raw ?? '').trim().toLowerCase()) {
    case '1':
    case 'true':
    case 'yes':
    case 'on':
      return true;
    default:
      // The absent flag, explicit false values, and malformed values all fail closed.
      return false;
  }
}

export function parseTrustedUserIds(raw: string | undefined): {
  valid: boolean;
  ids: ReadonlySet<string>;
} {
  const value = (raw ?? '').trim();
  if (!value) return { valid: true, ids: new Set() };

  const entries = value.split(',').map(entry => entry.trim());
  if (entries.some(entry => !entry || !uuidSchema.safeParse(entry).success)) {
    return { valid: false, ids: new Set() };
  }

  return { valid: true, ids: new Set(entries.map(entry => entry.toLowerCase())) };
}

export function readAutoSubmissionPolicy(
  env: AutoSubmissionPolicyEnvironment = process.env,
): { enabled: boolean; trustedUserIds: ReadonlySet<string> } {
  const trusted = parseTrustedUserIds(env.AUTO_SUBMISSION_TRUSTED_USER_IDS);
  return {
    enabled: parseEnabled(env.AUTO_SUBMISSION_ENABLED) && trusted.valid,
    trustedUserIds: trusted.ids,
  };
}

export function getAutoSubmissionEligibility(
  userId: string,
  env: AutoSubmissionPolicyEnvironment = process.env,
): { can_submit: true; denial_reason: null } | {
  can_submit: false;
  denial_reason: AutoSubmissionDenialReason;
} {
  const policy = readAutoSubmissionPolicy(env);
  if (!policy.enabled) {
    return {
      can_submit: false,
      denial_reason: AUTO_SUBMISSION_DENIAL_REASONS.DISABLED,
    };
  }
  if (!policy.trustedUserIds.has(userId.toLowerCase())) {
    return {
      can_submit: false,
      denial_reason: AUTO_SUBMISSION_DENIAL_REASONS.TESTER_REQUIRED,
    };
  }
  return { can_submit: true, denial_reason: null };
}
