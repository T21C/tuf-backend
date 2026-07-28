import { Op } from 'sequelize';
import User from '@/models/auth/User.js';
import StepUpCode from '@/models/auth/StepUpCode.js';
import ProfileActionLog, {
  type ProfileActionType,
} from '@/models/auth/ProfileActionLog.js';
import {
  OPAQUE_TOKEN_PURPOSE,
  opaqueTokenUtils,
  passwordUtils,
  refreshTokenService,
} from '@/misc/utils/auth/auth.js';
import { emailService, type EmailVerifyPurpose } from '@/misc/utils/auth/email.js';
import { permissionFlags } from '@/config/constants.js';
import {
  hasFlag,
  setUserPermission,
  setUserPermissionAndSave,
} from '@/misc/utils/auth/permissionUtils.js';
import { logger } from '@/server/services/core/LoggerService.js';
import { CacheInvalidation } from '@/server/middleware/cache.js';
import { STEP_UP_TTL_SEC } from '@/config/auth.config.js';
import type { StepUpCodeScope } from '@/models/auth/StepUpCode.js';

const EMAIL_REGEX = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
const EMAIL_VERIFY_TTL_MS = 60 * 60 * 1000; // 1 hour
const EMAIL_RESEND_COOLDOWN_MS = 60 * 1000; // 60s between codes
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;
const STEP_UP_CODE_TTL_MS = STEP_UP_TTL_SEC * 1000;
const STEP_UP_CODE_MAX_ATTEMPTS = 5;

const STEP_UP_ACTION_LABELS: Record<StepUpCodeScope, string> = {
  'email-change': 'change your email address',
  security: 'perform a sensitive security action',
};

export class CredentialError extends Error {
  constructor(
    message: string,
    public statusCode: number = 400,
    public code?: string,
    public details?: { retryAfter?: number },
  ) {
    super(message);
    this.name = 'CredentialError';
  }
}

export interface ActionContext {
  ip?: string | null;
  userAgent?: string | null;
}

function hasAccountEmail(email: string | null | undefined): email is string {
  return Boolean(email?.trim());
}

/** True when the account has a usable verified inbox (not merely a pending claim). */
export function hasVerifiedEmail(user: {
  email?: string | null;
  permissionFlags?: bigint | number | null;
} | null | undefined): boolean {
  if (!user || !hasAccountEmail(user.email)) return false;
  return hasFlag(user.permissionFlags ?? 0, permissionFlags.EMAIL_VERIFIED);
}

class AccountCredentialService {
  /** When the next verification email may be sent (ISO-friendly Date), or null if unrestricted. */
  getEmailResendAvailableAt(user: User): Date | null {
    if (!user.pendingEmail || !user.emailVerifyExpires) return null;
    const expiresMs = new Date(user.emailVerifyExpires).getTime();
    if (!Number.isFinite(expiresMs)) return null;
    // Codes set expires = sentAt + TTL; recover sentAt without an extra column.
    const sentAtMs = expiresMs - EMAIL_VERIFY_TTL_MS;
    return new Date(sentAtMs + EMAIL_RESEND_COOLDOWN_MS);
  }

  getEmailResendCooldownMs(user: User): number {
    const availableAt = this.getEmailResendAvailableAt(user);
    if (!availableAt) return 0;
    return Math.max(0, availableAt.getTime() - Date.now());
  }

  normalizeEmail(raw: unknown): string {
    if (typeof raw !== 'string') return '';
    return raw.trim().toLowerCase();
  }

  assertValidEmail(email: string): void {
    if (!email || !EMAIL_REGEX.test(email)) {
      throw new CredentialError('Invalid email format', 400, 'INVALID_EMAIL');
    }
  }

  async logAction(
    userId: string,
    action: ProfileActionType | string,
    metadata: Record<string, unknown> | null,
    ctx?: ActionContext,
  ): Promise<void> {
    try {
      const now = new Date();
      await ProfileActionLog.create({
        userId,
        action,
        metadata,
        ip: ctx?.ip ?? null,
        userAgent: ctx?.userAgent ?? null,
        createdAt: now,
        updatedAt: now,
      });
    } catch (error) {
      logger.error('Failed to write profile action log', error);
    }
  }

  /**
   * True if any other user holds E as verified email or pending claim.
   */
  async assertEmailAvailable(email: string, excludeUserId?: string): Promise<void> {
    const where = excludeUserId
      ? {
          [Op.and]: [
            { id: { [Op.ne]: excludeUserId } },
            { [Op.or]: [{ email }, { pendingEmail: email }] },
          ],
        }
      : { [Op.or]: [{ email }, { pendingEmail: email }] };

    const existing = await User.findOne({ where });
    if (existing) {
      throw new CredentialError('Unable to update email', 400, 'EMAIL_UNAVAILABLE');
    }
  }

  /**
   * Login lookup: username, verified email, or pending email (if no verified owner).
   */
  async findUserByLoginIdentifier(identifier: string): Promise<User | null> {
    const raw = identifier.trim();
    if (!raw) return null;

    const byUsername = await User.findOne({ where: { username: raw } });
    if (byUsername) return byUsername;

    const normalized = this.normalizeEmail(raw);
    if (!normalized || !EMAIL_REGEX.test(normalized)) return null;

    const verified = await User.findOne({ where: { email: normalized } });
    if (verified) return verified;

    return User.findOne({ where: { pendingEmail: normalized } });
  }

  private async issueEmailVerifyCode(
    user: User,
    purpose: EmailVerifyPurpose,
    ctx?: ActionContext,
  ): Promise<{ code: string; pendingEmail: string }> {
    const pending = user.pendingEmail?.trim();
    if (!pending) {
      throw new CredentialError('No pending email to verify', 400, 'NO_PENDING');
    }

    const code = opaqueTokenUtils.generateOpaqueCode(8);
    const hash = opaqueTokenUtils.hashBoundCode(
      OPAQUE_TOKEN_PURPOSE.EMAIL_VERIFY,
      user.id,
      code,
    );

    await user.update({
      emailVerifyTokenHash: hash,
      emailVerifyExpires: new Date(Date.now() + EMAIL_VERIFY_TTL_MS),
    });

    const sent = await emailService.sendEmailVerificationCode({
      to: pending,
      code,
      purpose,
      fromEmail: user.email ?? null,
      toEmail: pending,
    });
    if (!sent) {
      throw new CredentialError('Failed to send verification email', 500, 'EMAIL_SEND_FAILED');
    }

    return { code, pendingEmail: pending };
  }

  /**
   * Register path: assign pending only (email stays null).
   */
  async claimEmailOnRegister(
    user: User,
    emailRaw: string,
    ctx?: ActionContext,
  ): Promise<void> {
    const email = this.normalizeEmail(emailRaw);
    this.assertValidEmail(email);
    await this.assertEmailAvailable(email, user.id);

    await user.update({
      email: null,
      pendingEmail: email,
    });
    await user.reload();
    await this.issueEmailVerifyCode(user, 'register', ctx);
    await this.logAction(
      user.id,
      'email_change_requested',
      { fromEmail: null, toEmail: email, purpose: 'register' },
      ctx,
    );
  }

  async requestEmailChange(
    userId: string,
    nextEmailRaw: string,
    ctx?: ActionContext,
  ): Promise<{ pendingEmail: string; emailResendAvailableAt: string | null }> {
    const user = await User.findByPk(userId);
    if (!user) throw new CredentialError('User not found', 404);

    const nextEmail = this.normalizeEmail(nextEmailRaw);
    this.assertValidEmail(nextEmail);
    await this.assertEmailAvailable(nextEmail, userId);

    if (hasAccountEmail(user.email) && user.email.toLowerCase() === nextEmail) {
      return {
        pendingEmail: user.pendingEmail || nextEmail,
        emailResendAvailableAt: this.getEmailResendAvailableAt(user)?.toISOString() ?? null,
      };
    }

    const oldEmail = hasAccountEmail(user.email) ? user.email : null;
    await user.update({ pendingEmail: nextEmail });
    await user.reload();

    const purpose: EmailVerifyPurpose = oldEmail ? 'change' : 'add';
    await this.issueEmailVerifyCode(user, purpose, ctx);

    if (oldEmail) {
      await emailService.sendEmailChangeNoticeToOld({
        to: oldEmail,
        fromEmail: oldEmail,
        toEmail: nextEmail,
      });
    }

    await this.logAction(
      user.id,
      'email_change_requested',
      { fromEmail: oldEmail, toEmail: nextEmail },
      ctx,
    );
    await CacheInvalidation.invalidateUser(userId);
    await user.reload();
    const availableAt = this.getEmailResendAvailableAt(user);
    return {
      pendingEmail: nextEmail,
      emailResendAvailableAt: (availableAt ?? new Date(Date.now() + EMAIL_RESEND_COOLDOWN_MS)).toISOString(),
    };
  }

  async cancelPendingEmail(userId: string, ctx?: ActionContext): Promise<void> {
    const user = await User.findByPk(userId);
    if (!user) throw new CredentialError('User not found', 404);
    if (!user.pendingEmail) {
      throw new CredentialError('No pending email to cancel', 400, 'NO_PENDING');
    }

    const cleared = user.pendingEmail;
    await user.update({
      pendingEmail: null,
      emailVerifyTokenHash: null,
      emailVerifyExpires: null,
    });
    await this.logAction(
      userId,
      'email_change_cancelled',
      { cancelledEmail: cleared, currentEmail: user.email ?? null },
      ctx,
    );
    await CacheInvalidation.invalidateUser(userId);
  }

  async resendEmailCode(
    userId: string,
    ctx?: ActionContext,
  ): Promise<{ pendingEmail: string; emailResendAvailableAt: string }> {
    const user = await User.findByPk(userId);
    if (!user) throw new CredentialError('User not found', 404);
    if (!user.pendingEmail) {
      throw new CredentialError('No email on file. Add an email in account settings first.', 400);
    }
    if (hasFlag(user, permissionFlags.EMAIL_VERIFIED) && !user.pendingEmail) {
      throw new CredentialError('Email already verified', 400);
    }

    const remainingMs = this.getEmailResendCooldownMs(user);
    if (remainingMs > 0) {
      throw new CredentialError(
        'Please wait before requesting another code',
        429,
        'RESEND_COOLDOWN',
        { retryAfter: remainingMs },
      );
    }

    const purpose: EmailVerifyPurpose = hasAccountEmail(user.email) ? 'change' : 'register';
    const { pendingEmail } = await this.issueEmailVerifyCode(user, purpose, ctx);
    await user.reload();
    const availableAt = this.getEmailResendAvailableAt(user);
    return {
      pendingEmail,
      emailResendAvailableAt: (availableAt ?? new Date(Date.now() + EMAIL_RESEND_COOLDOWN_MS)).toISOString(),
    };
  }

  /**
   * Confirm inbox code: pending → verified email; revoke all sessions.
   */
  async confirmEmailCode(
    userId: string,
    codeRaw: string,
    ctx?: ActionContext,
  ): Promise<{ email: string }> {
    const user = await User.findByPk(userId);
    if (!user) throw new CredentialError('User not found', 404);
    if (!user.pendingEmail) {
      throw new CredentialError('No pending email to verify', 400, 'NO_PENDING');
    }
    if (!user.emailVerifyTokenHash || !user.emailVerifyExpires) {
      throw new CredentialError('Invalid or expired verification code', 400, 'INVALID_CODE');
    }
    if (user.emailVerifyExpires.getTime() <= Date.now()) {
      throw new CredentialError('Invalid or expired verification code', 400, 'INVALID_CODE');
    }

    const expected = opaqueTokenUtils.hashBoundCode(
      OPAQUE_TOKEN_PURPOSE.EMAIL_VERIFY,
      user.id,
      codeRaw,
    );
    if (!opaqueTokenUtils.timingSafeEqualHash(expected, user.emailVerifyTokenHash)) {
      throw new CredentialError('Invalid or expired verification code', 400, 'INVALID_CODE');
    }

    const newEmail = user.pendingEmail;
    const oldEmail = user.email ?? null;
    const wasChange = Boolean(oldEmail);
    const nextFlags = setUserPermission(user, permissionFlags.EMAIL_VERIFIED, true);

    await user.update({
      email: newEmail,
      pendingEmail: null,
      emailVerifyTokenHash: null,
      emailVerifyExpires: null,
      passwordResetToken: null,
      permissionFlags: nextFlags,
      permissionVersion: (user.permissionVersion || 0) + 1,
    });

    await refreshTokenService.revokeAllRefreshTokensForUser(userId);
    await CacheInvalidation.invalidateUser(userId);

    await this.logAction(
      userId,
      wasChange ? 'email_change_confirmed' : 'email_verify_confirmed',
      { fromEmail: oldEmail, toEmail: newEmail },
      ctx,
    );

    if (wasChange && oldEmail) {
      await emailService.sendEmailChangeNoticeToOld({
        to: oldEmail,
        fromEmail: oldEmail,
        toEmail: newEmail,
      });
    }

    return { email: newEmail };
  }

  async requestPasswordReset(emailRaw: string, ctx?: ActionContext): Promise<void> {
    const email = this.normalizeEmail(emailRaw);
    this.assertValidEmail(email);

    const user = await User.findOne({ where: { email } });
    // Generic success path even if missing / no password
    if (!user?.password) return;

    const code = opaqueTokenUtils.generateOpaqueCode(8);
    const hash = opaqueTokenUtils.hashBoundCode(
      OPAQUE_TOKEN_PURPOSE.PASSWORD_RESET,
      user.id,
      code,
    );

    await user.update({
      passwordResetTokenHash: hash,
      passwordResetExpires: new Date(Date.now() + PASSWORD_RESET_TTL_MS),
      passwordResetToken: null,
    });

    const sent = await emailService.sendPasswordResetCode({ to: email, code });
    if (!sent) {
      throw new CredentialError('Failed to send password reset email', 500);
    }

    await this.logAction(user.id, 'password_reset_requested', { email }, ctx);
  }

  async confirmPasswordReset(
    emailRaw: string,
    codeRaw: string,
    newPassword: string,
    ctx?: ActionContext,
  ): Promise<void> {
    if (!newPassword || newPassword.length < 8) {
      throw new CredentialError('Password must be at least 8 characters long', 400);
    }

    const email = this.normalizeEmail(emailRaw);
    this.assertValidEmail(email);

    const user = await User.findOne({ where: { email } });
    if (
      !user ||
      !user.passwordResetTokenHash ||
      !user.passwordResetExpires ||
      user.passwordResetExpires.getTime() <= Date.now()
    ) {
      throw new CredentialError('Invalid or expired reset code', 400, 'INVALID_CODE');
    }

    const expected = opaqueTokenUtils.hashBoundCode(
      OPAQUE_TOKEN_PURPOSE.PASSWORD_RESET,
      user.id,
      codeRaw,
    );
    if (!opaqueTokenUtils.timingSafeEqualHash(expected, user.passwordResetTokenHash)) {
      throw new CredentialError('Invalid or expired reset code', 400, 'INVALID_CODE');
    }

    const hashedPassword = await passwordUtils.hashPassword(newPassword);
    await user.update({
      password: hashedPassword,
      passwordResetTokenHash: null,
      passwordResetExpires: null,
      passwordResetToken: null,
      permissionVersion: (user.permissionVersion || 0) + 1,
    });

    await refreshTokenService.revokeAllRefreshTokensForUser(user.id);
    await CacheInvalidation.invalidateUser(user.id);
    await this.logAction(user.id, 'password_reset_confirmed', { email }, ctx);
  }

  /**
   * Issue an emailed step-up code to the current verified inbox.
   * Invalidates any previous unused code for the same (user, scope).
   */
  async issueStepUpCode(
    userId: string,
    scope: StepUpCodeScope,
    ctx?: ActionContext,
  ): Promise<{ emailResendAvailableAt: string; maskedEmail: string }> {
    const user = await User.findByPk(userId);
    if (!user) throw new CredentialError('User not found', 404);
    if (!hasVerifiedEmail(user)) {
      throw new CredentialError(
        'A verified email is required for this action. Add and verify an email first.',
        403,
        'EMAIL_REQUIRED',
      );
    }

    const latest = await StepUpCode.findOne({
      where: { userId, scope, consumedAt: null },
      order: [['createdAt', 'DESC']],
    });
    if (latest) {
      const sentAtMs = new Date(latest.expiresAt).getTime() - STEP_UP_CODE_TTL_MS;
      const availableAtMs = sentAtMs + EMAIL_RESEND_COOLDOWN_MS;
      const remainingMs = availableAtMs - Date.now();
      if (remainingMs > 0) {
        throw new CredentialError(
          'Please wait before requesting another code',
          429,
          'RESEND_COOLDOWN',
          { retryAfter: remainingMs },
        );
      }
    }

    // Invalidate outstanding codes for this scope so only the newest is valid.
    await StepUpCode.update(
      { consumedAt: new Date() },
      { where: { userId, scope, consumedAt: null } },
    );

    const code = opaqueTokenUtils.generateOpaqueCode(8);
    const codeHash = opaqueTokenUtils.hashBoundCode(
      OPAQUE_TOKEN_PURPOSE.STEP_UP,
      userId,
      code,
      scope,
    );
    const now = new Date();
    const expiresAt = new Date(now.getTime() + STEP_UP_CODE_TTL_MS);

    await StepUpCode.create({
      userId,
      scope,
      codeHash,
      expiresAt,
      attempts: 0,
      consumedAt: null,
      createdAt: now,
      updatedAt: now,
    });

    const action = STEP_UP_ACTION_LABELS[scope];
    const sent = await emailService.sendStepUpCode({
      to: user.email!,
      code,
      action,
    });
    if (!sent) {
      throw new CredentialError('Failed to send confirmation email', 500, 'EMAIL_SEND_FAILED');
    }

    await this.logAction(userId, 'step_up_code_issued', { scope }, ctx);

    const emailResendAvailableAt = new Date(
      now.getTime() + EMAIL_RESEND_COOLDOWN_MS,
    ).toISOString();
    return {
      emailResendAvailableAt,
      maskedEmail: this.maskEmail(user.email!),
    };
  }

  /**
   * Verify an emailed step-up code. Single-use, attempt-capped, scope-bound.
   */
  async confirmStepUpCode(
    userId: string,
    scope: StepUpCodeScope,
    codeRaw: string,
    ctx?: ActionContext,
  ): Promise<void> {
    const user = await User.findByPk(userId);
    if (!user) throw new CredentialError('User not found', 404);
    if (!hasVerifiedEmail(user)) {
      throw new CredentialError(
        'A verified email is required for this action. Add and verify an email first.',
        403,
        'EMAIL_REQUIRED',
      );
    }

    const record = await StepUpCode.findOne({
      where: { userId, scope, consumedAt: null },
      order: [['createdAt', 'DESC']],
    });
    if (!record || record.expiresAt.getTime() <= Date.now()) {
      throw new CredentialError('Invalid or expired confirmation code', 400, 'INVALID_CODE');
    }
    if (record.attempts >= STEP_UP_CODE_MAX_ATTEMPTS) {
      await record.update({ consumedAt: new Date() });
      throw new CredentialError(
        'Too many incorrect attempts. Request a new code.',
        400,
        'CODE_LOCKED',
      );
    }

    const expected = opaqueTokenUtils.hashBoundCode(
      OPAQUE_TOKEN_PURPOSE.STEP_UP,
      userId,
      codeRaw,
      scope,
    );
    if (!opaqueTokenUtils.timingSafeEqualHash(expected, record.codeHash)) {
      await record.update({ attempts: record.attempts + 1 });
      if (record.attempts + 1 >= STEP_UP_CODE_MAX_ATTEMPTS) {
        await record.update({ consumedAt: new Date() });
        throw new CredentialError(
          'Too many incorrect attempts. Request a new code.',
          400,
          'CODE_LOCKED',
        );
      }
      throw new CredentialError('Invalid or expired confirmation code', 400, 'INVALID_CODE');
    }

    await record.update({ consumedAt: new Date() });
    await this.logAction(userId, 'step_up_code_confirmed', { scope }, ctx);
  }

  maskEmail(email: string): string {
    const [local, domain] = email.split('@');
    if (!local || !domain) return '***';
    const visible = local.slice(0, Math.min(2, local.length));
    return `${visible}***@${domain}`;
  }

  /**
   * Self-service password change for a signed-in user.
   *
   * Deliberately mirrors confirmPasswordReset — same strength floor, same
   * permissionVersion bump, same audit entry — because the two paths set the
   * same credential and previously diverged: this one validated nothing and
   * left every other session alive, so changing your password after a
   * suspected compromise did not evict the attacker.
   *
   * Pass keepSessionId to spare the caller's own device; omit it (bearer
   * clients, where the current session cannot be identified) to revoke
   * everything and force a fresh login.
   */
  async changePassword(
    userId: string,
    args: {
      currentPassword?: unknown;
      newPassword: unknown;
      keepSessionId?: string | null;
    },
    ctx?: ActionContext,
  ): Promise<{ revokedSessions: number; keptCurrentSession: boolean }> {
    const { currentPassword, newPassword, keepSessionId } = args;

    if (typeof newPassword !== 'string' || newPassword.length < 8) {
      throw new CredentialError('Password must be at least 8 characters long', 400);
    }

    const user = await User.findByPk(userId);
    if (!user) {
      throw new CredentialError('User not found', 404);
    }

    const existingHash = user.password ?? null;

    // OAuth-only accounts have no password to confirm; anything else must prove
    // the current one so a hijacked session cannot silently take the account.
    if (existingHash) {
      if (typeof currentPassword !== 'string' || !currentPassword.length) {
        throw new CredentialError(
          'Current password is required',
          400,
          'CURRENT_PASSWORD_REQUIRED',
        );
      }
      const check = await passwordUtils.verifyAndMaybeRehash(currentPassword, existingHash);
      if (!check.ok) {
        throw new CredentialError(
          'Current password is incorrect',
          400,
          'CURRENT_PASSWORD_INVALID',
        );
      }
    }

    const hashedPassword = await passwordUtils.hashPassword(newPassword);
    await user.update({
      password: hashedPassword,
      passwordResetTokenHash: null,
      passwordResetExpires: null,
      passwordResetToken: null,
      permissionVersion: (user.permissionVersion || 0) + 1,
    });

    let revokedSessions = 0;
    if (keepSessionId) {
      revokedSessions = await refreshTokenService.revokeOtherSessionsForUser(
        userId,
        keepSessionId,
      );
    } else {
      await refreshTokenService.revokeAllRefreshTokensForUser(userId);
    }

    await CacheInvalidation.invalidateUser(userId);
    await this.logAction(
      userId,
      existingHash ? 'password_changed' : 'password_set',
      { keptCurrentSession: Boolean(keepSessionId), revokedSessions },
      ctx,
    );

    return { revokedSessions, keptCurrentSession: Boolean(keepSessionId) };
  }

  /**
   * OAuth: clear pending claims of E from other users when E becomes verified elsewhere.
   */
  async clearForeignPendingEmail(email: string, exceptUserId?: string): Promise<void> {
    const normalized = this.normalizeEmail(email);
    if (!normalized) return;

    const where: Record<string, unknown> = { pendingEmail: normalized };
    if (exceptUserId) {
      Object.assign(where, { id: { [Op.ne]: exceptUserId } });
    }

    await User.update(
      {
        pendingEmail: null,
        emailVerifyTokenHash: null,
        emailVerifyExpires: null,
      },
      { where },
    );
  }

  /**
   * Assign verified email from OAuth provider (trusted).
   */
  async assignVerifiedEmailFromOAuth(user: User, emailRaw: string): Promise<void> {
    const email = this.normalizeEmail(emailRaw);
    if (!email) return;
    this.assertValidEmail(email);

    await this.clearForeignPendingEmail(email, user.id);

    const conflict = await User.findOne({
      where: {
        email,
        id: { [Op.ne]: user.id },
      },
    });
    if (conflict) {
      // Leave existing verified owner; caller should have linked that user instead
      return;
    }

    const nextFlags = setUserPermission(user, permissionFlags.EMAIL_VERIFIED, true);
    await user.update({
      email,
      pendingEmail: null,
      emailVerifyTokenHash: null,
      emailVerifyExpires: null,
      permissionFlags: nextFlags,
      permissionVersion: (user.permissionVersion || 0) + 1,
    });
  }

  /** Ensure EMAIL_VERIFIED flag is set when email is already verified on row. */
  async ensureEmailVerifiedFlag(user: User): Promise<void> {
    if (!hasAccountEmail(user.email)) return;
    if (hasFlag(user, permissionFlags.EMAIL_VERIFIED)) return;
    await setUserPermissionAndSave(user, permissionFlags.EMAIL_VERIFIED, true);
  }
}

export const accountCredentialService = new AccountCredentialService();
