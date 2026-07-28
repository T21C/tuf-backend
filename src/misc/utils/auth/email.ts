import axios from 'axios';
import dotenv from 'dotenv';
import { logger } from '@/server/services/core/LoggerService.js';
import { clientUrlEnv } from '@/config/app.config.js';

dotenv.config();

const MAILERSEND_API_URL = 'https://api.mailersend.com/v1/email';
const MAILERSEND_API_TOKEN = process.env.MAILERSEND_API_TOKEN;

interface EmailOptions {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export type EmailVerifyPurpose = 'register' | 'change' | 'add';

interface VerificationCodeOptions {
  to: string;
  code: string;
  purpose: EmailVerifyPurpose;
  fromEmail?: string | null;
  toEmail?: string | null;
}

export const emailService = {
  async sendEmail({ to, subject, text, html }: EmailOptions): Promise<boolean> {
    try {
      if (!MAILERSEND_API_TOKEN) {
        logger.error('MailerSend API token is not configured');
        return false;
      }
      let response;
      try {
        response = await axios.post(
          MAILERSEND_API_URL,
          {
            from: {
              email: process.env.MAILERSEND_FROM_EMAIL || 'noreply@tuforums.com',
              name: 'The Universal Forums',
            },
            to: [{ email: to }],
            subject,
            text,
            html,
          },
          {
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${MAILERSEND_API_TOKEN}`,
            },
          },
        );
      } catch (error) {
        logger.error('Axios request failed sending email', error);
        return false;
      }

      if (response?.status === 202) {
        return true;
      }

      logger.error('Email sending failed with status:', response?.status);
      return false;
    } catch (error) {
      logger.error('Email sending failed:', error);
      return false;
    }
  },

  /**
   * Send verification code (no secret in URL).
   */
  async sendEmailVerificationCode({
    to,
    code,
    purpose,
    fromEmail,
    toEmail,
  }: VerificationCodeOptions): Promise<boolean> {
    const subject =
      purpose === 'change'
        ? 'Confirm your email change'
        : purpose === 'add'
          ? 'Verify your new email address'
          : 'Verify your email address';

    const changeLine =
      purpose === 'change' && fromEmail && toEmail
        ? `Email change: ${fromEmail} → ${toEmail}`
        : null;

    const text = `
      ${changeLine ? `${changeLine}\n\n` : ''}Your verification code is: ${code}

      This code will expire in 1 hour.

      If you did not request this, you can ignore this email.
    `;

    const html = `
      <h2>${subject}</h2>
      ${changeLine ? `<p>${changeLine}</p>` : ''}
      <p>Your verification code is:</p>
      <p style="font-size: 28px; letter-spacing: 4px; font-weight: bold;">${code}</p>
      <p>This code will expire in 1 hour.</p>
      <p><small>If you did not request this, you can ignore this email.</small></p>
    `;

    return this.sendEmail({ to, subject, text, html });
  },

  /**
   * Notify the previous verified inbox that a change was requested.
   */
  async sendEmailChangeNoticeToOld({
    to,
    fromEmail,
    toEmail,
  }: {
    to: string;
    fromEmail: string;
    toEmail: string;
  }): Promise<boolean> {
    const settingsUrl = `${clientUrlEnv}/settings/account`;
    const subject = 'Email change requested on your TUF account';
    const text = `
      An email change was requested on your account:
      ${fromEmail} → ${toEmail}

      If this was you, enter the code sent to the new address to finish.

      If this was not you, sign in and cancel the pending change, then change your password:
      ${settingsUrl}
    `;
    const html = `
      <h2>Email change requested</h2>
      <p><strong>${fromEmail}</strong> → <strong>${toEmail}</strong></p>
      <p>If this was you, enter the code sent to the new address to finish.</p>
      <p>If this was <em>not</em> you, <a href="${settingsUrl}">cancel the pending change</a> and change your password.</p>
    `;
    return this.sendEmail({ to, subject, text, html });
  },

  async sendPasswordResetCode({ to, code }: { to: string; code: string }): Promise<boolean> {
    const pageUrl = `${clientUrlEnv}/forgot-password`;
    const subject = 'Reset your password';
    const text = `
      You requested a password reset.

      Your reset code is: ${code}

      Enter this code at: ${pageUrl}

      This code will expire in 1 hour.

      If you did not request a password reset, you can safely ignore this email.
    `;
    const html = `
      <h2>Reset Your Password</h2>
      <p>Your reset code is:</p>
      <p style="font-size: 28px; letter-spacing: 4px; font-weight: bold;">${code}</p>
      <p>Enter this code at <a href="${pageUrl}">${pageUrl}</a></p>
      <p>This code will expire in 1 hour.</p>
      <p><small>If you did not request a password reset, you can safely ignore this email.</small></p>
    `;
    return this.sendEmail({ to, subject, text, html });
  },

  /**
   * One-time code proving control of the current verified inbox before a
   * sensitive account action (password change, unlink, etc.).
   */
  async sendStepUpCode({
    to,
    code,
    action,
  }: {
    to: string;
    code: string;
    action: string;
  }): Promise<boolean> {
    const subject = `Confirm: ${action}`;
    const text = `
      You requested to ${action} on your TUF account.

      Your confirmation code is: ${code}

      This code will expire in 10 minutes. Enter it in the confirmation dialog to continue.

      If you did not request this, change your password and revoke other sessions immediately.
    `;
    const html = `
      <h2>Confirm: ${action}</h2>
      <p>You requested to <strong>${action}</strong> on your TUF account.</p>
      <p>Your confirmation code is:</p>
      <p style="font-size: 28px; letter-spacing: 4px; font-weight: bold;">${code}</p>
      <p>This code will expire in 10 minutes. Enter it in the confirmation dialog to continue.</p>
      <p><small>If you did not request this, change your password and revoke other sessions immediately.</small></p>
    `;
    return this.sendEmail({ to, subject, text, html });
  },

  /** @deprecated Prefer sendEmailVerificationCode */
  async sendVerificationEmail(to: string, token: string): Promise<boolean> {
    return this.sendEmailVerificationCode({
      to,
      code: token.slice(0, 8).toUpperCase(),
      purpose: 'register',
      toEmail: to,
    });
  },

  /** @deprecated Prefer sendPasswordResetCode */
  async sendPasswordResetEmail(to: string, token: string): Promise<boolean> {
    return this.sendPasswordResetCode({ to, code: token.slice(0, 8).toUpperCase() });
  },
};
