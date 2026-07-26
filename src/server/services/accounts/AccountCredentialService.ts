import { Op } from 'sequelize';
import User from '@/models/auth/User.js';
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

const EMAIL_REGEX = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
const EMAIL_VERIFY_TTL_MS = 60 * 60 * 1000; // 1 hour
const EMAIL_RESEND_COOLDOWN_MS = 60 * 1000; // 60s between codes
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;

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
