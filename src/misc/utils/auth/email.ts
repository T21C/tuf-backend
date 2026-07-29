import axios from 'axios';
import dotenv from 'dotenv';
import { logger } from '@/server/services/core/LoggerService.js';
import {
  detailList,
  escapeHtml,
  forgotPasswordUrl,
  mutedParagraph,
  paragraph,
  renderButton,
  renderCode,
  renderEmail,
  renderText,
  settingsUrl,
} from './emailTemplates.js';

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
        ? 'Confirm your new email'
        : purpose === 'add'
          ? 'Verify your email address'
          : 'Confirm your email address';

    const intro =
      purpose === 'change'
        ? 'Enter this code to finish switching the email on your TUF account.'
        : purpose === 'add'
          ? 'Enter this code to add this email to your TUF account.'
          : 'Enter this code to verify your email and finish setting up your account.';

    const changeLine =
      purpose === 'change' && fromEmail && toEmail
        ? `${fromEmail} → ${toEmail}`
        : null;

    const bodyHtml = [
      changeLine
        ? mutedParagraph(`Changing from <strong>${escapeHtml(fromEmail!)}</strong> to <strong>${escapeHtml(toEmail!)}</strong>.`)
        : '',
      paragraph('Your confirmation code:'),
      renderCode(code),
      mutedParagraph('This code expires in 1 hour.'),
    ].join('');

    const html = renderEmail({
      title: subject,
      intro,
      bodyHtml,
      notYouKind: 'ignore',
    });

    const text = renderText({
      title: subject,
      intro,
      bodyLines: [
        ...(changeLine ? [`Changing: ${changeLine}`, ''] : []),
        `Your confirmation code: ${code}`,
        'This code expires in 1 hour.',
      ],
      notYouKind: 'ignore',
    });

    return this.sendEmail({ to, subject, text, html });
  },

  /**
   * Notify the previous verified inbox that a change was requested / confirmed.
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
    const settings = settingsUrl();
    const subject = 'Email change on your TUF account';
    const intro = 'Someone asked to change the email address on your account.';

    const bodyHtml = [
      mutedParagraph(
        `<strong>${escapeHtml(fromEmail)}</strong> → <strong>${escapeHtml(toEmail)}</strong>`,
      ),
      paragraph(
        'If this was you, enter the code sent to the new address to finish. You can cancel the pending change in Settings at any time.',
      ),
      renderButton('Open account settings', settings),
    ].join('');

    const html = renderEmail({
      title: 'Email change requested',
      intro,
      bodyHtml,
      notYouKind: 'security',
    });

    const text = renderText({
      title: 'Email change requested',
      intro,
      bodyLines: [
        `${fromEmail} → ${toEmail}`,
        '',
        'If this was you, enter the code sent to the new address to finish.',
        `You can cancel the pending change in Settings at any time: ${settings}`,
      ],
      notYouKind: 'security',
    });

    return this.sendEmail({ to, subject, text, html });
  },

  async sendPasswordResetCode({ to, code }: { to: string; code: string }): Promise<boolean> {
    const pageUrl = forgotPasswordUrl();
    const subject = 'Reset your password';
    const intro = 'Use this code to choose a new password for your TUF account.';

    const bodyHtml = [
      paragraph('Your reset code:'),
      renderCode(code),
      mutedParagraph('This code expires in 1 hour.'),
      renderButton('Open password reset', pageUrl),
    ].join('');

    const html = renderEmail({
      title: subject,
      intro,
      bodyHtml,
      notYouKind: 'ignore',
    });

    const text = renderText({
      title: subject,
      intro,
      bodyLines: [
        `Your reset code: ${code}`,
        'This code expires in 1 hour.',
        `Enter it here: ${pageUrl}`,
      ],
      notYouKind: 'ignore',
    });

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
    const subject = "Confirm it's you";
    const intro = `Enter this code to ${action} on your TUF account.`;

    const bodyHtml = [
      paragraph('Your confirmation code:'),
      renderCode(code),
      mutedParagraph('This code expires in 10 minutes.'),
    ].join('');

    const html = renderEmail({
      title: subject,
      intro,
      bodyHtml,
      notYouKind: 'security',
    });

    const text = renderText({
      title: subject,
      intro,
      bodyLines: [
        `Your confirmation code: ${code}`,
        'This code expires in 10 minutes.',
      ],
      notYouKind: 'security',
    });

    return this.sendEmail({ to, subject, text, html });
  },

  /**
   * One-time code for login-time MFA (second factor after password).
   * Doubles as a "someone tried to sign in" alert.
   */
  async sendLoginCode({
    to,
    code,
  }: {
    to: string;
    code: string;
  }): Promise<boolean> {
    const subject = 'Your sign-in code';
    const intro = "Here's your code to finish signing in to your TUF account.";

    const bodyHtml = [
      paragraph('Your sign-in code:'),
      renderCode(code),
      mutedParagraph('This code expires in 10 minutes.'),
    ].join('');

    const html = renderEmail({
      title: subject,
      intro,
      bodyHtml,
      notYouKind: 'security',
    });

    const text = renderText({
      title: subject,
      intro,
      bodyLines: [
        `Your sign-in code: ${code}`,
        'This code expires in 10 minutes.',
      ],
      notYouKind: 'security',
    });

    return this.sendEmail({ to, subject, text, html });
  },

  /** New sign-in from an unfamiliar / non-trusted device. */
  async sendNewSignInAlert({
    to,
    device,
    location,
    when,
    remembered,
    method,
  }: {
    to: string;
    device: string;
    location: string;
    when: string;
    remembered?: boolean;
    method?: 'password' | 'discord' | string;
  }): Promise<boolean> {
    const settings = settingsUrl();
    const subject = 'New sign-in to your TUF account';
    const intro = 'Someone just signed in to your account.';
    const methodLabel =
      method === 'discord'
        ? 'Discord'
        : method === 'passkey'
          ? 'Passkey'
          : method === 'password'
            ? 'Email and password'
            : method || 'Sign-in';

    const bodyHtml = [
      detailList([
        { label: 'When', value: when },
        { label: 'Device', value: device },
        { label: 'Location', value: location },
        { label: 'Method', value: methodLabel },
      ]),
      remembered
        ? mutedParagraph('This device was marked as trusted, so the next sign-in may skip the email code.')
        : '',
      paragraph('If this was you, no action is needed.'),
      renderButton('Review account settings', settings),
    ].join('');

    const html = renderEmail({
      title: subject,
      intro,
      bodyHtml,
      notYouKind: 'security',
    });

    const text = renderText({
      title: subject,
      intro,
      bodyLines: [
        `When: ${when}`,
        `Device: ${device}`,
        `Location: ${location}`,
        `Method: ${methodLabel}`,
        ...(remembered
          ? ['This device was marked as trusted, so the next sign-in may skip the email code.']
          : []),
        '',
        'If this was you, no action is needed.',
        `Review account settings: ${settings}`,
      ],
      notYouKind: 'security',
    });

    return this.sendEmail({ to, subject, text, html });
  },

  async sendPasswordChangedAlert({
    to,
    kind,
  }: {
    to: string;
    kind: 'changed' | 'set';
  }): Promise<boolean> {
    const settings = settingsUrl();
    const subject =
      kind === 'set' ? 'Password added to your TUF account' : 'Your TUF password was changed';
    const intro =
      kind === 'set'
        ? 'A password was added to your account so you can also sign in with email.'
        : 'The password on your TUF account was just changed.';

    const bodyHtml = [
      paragraph(
        kind === 'set'
          ? 'If this was you, no action is needed.'
          : 'Other devices were signed out for your safety.',
      ),
      renderButton('Open account settings', settings),
    ].join('');

    const html = renderEmail({
      title: subject,
      intro,
      bodyHtml,
      notYouKind: 'security-reset',
    });

    const text = renderText({
      title: subject,
      intro,
      bodyLines: [
        kind === 'set'
          ? 'If this was you, no action is needed.'
          : 'Other devices were signed out for your safety.',
        `Open account settings: ${settings}`,
      ],
      notYouKind: 'security-reset',
    });

    return this.sendEmail({ to, subject, text, html });
  },

  async sendPasswordResetAlert({ to }: { to: string }): Promise<boolean> {
    const settings = settingsUrl();
    const subject = 'Your TUF password was reset';
    const intro = 'Your password was just reset using an email code.';

    const bodyHtml = [
      paragraph('All signed-in devices were signed out. Use your new password the next time you sign in.'),
      renderButton('Open account settings', settings),
    ].join('');

    const html = renderEmail({
      title: subject,
      intro,
      bodyHtml,
      notYouKind: 'security-reset',
    });

    const text = renderText({
      title: subject,
      intro,
      bodyLines: [
        'All signed-in devices were signed out. Use your new password the next time you sign in.',
        `Open account settings: ${settings}`,
      ],
      notYouKind: 'security-reset',
    });

    return this.sendEmail({ to, subject, text, html });
  },

  async sendDeletionScheduledAlert({
    to,
    executeAt,
  }: {
    to: string;
    executeAt: Date;
  }): Promise<boolean> {
    const settings = settingsUrl();
    const when = formatEmailDate(executeAt);
    const subject = 'Account deletion scheduled';
    const intro =
      'Your TUF account is scheduled for deletion. You have a few days to change your mind.';

    const bodyHtml = [
      detailList([{ label: 'Scheduled for', value: when }]),
      paragraph('Signing in before then cancels the deletion automatically.'),
      renderButton('Open account settings', settings),
    ].join('');

    const html = renderEmail({
      title: subject,
      intro,
      bodyHtml,
      notYouKind: 'security',
    });

    const text = renderText({
      title: subject,
      intro,
      bodyLines: [
        `Scheduled for: ${when}`,
        'Signing in before then cancels the deletion automatically.',
        `Open account settings: ${settings}`,
      ],
      notYouKind: 'security',
    });

    return this.sendEmail({ to, subject, text, html });
  },

  async sendOAuthUnlinkedAlert({
    to,
    provider,
  }: {
    to: string;
    provider: string;
  }): Promise<boolean> {
    const settings = settingsUrl();
    const label = provider.charAt(0).toUpperCase() + provider.slice(1);
    const subject = `${label} disconnected from your TUF account`;
    const intro = `${label} is no longer linked to your account.`;

    const bodyHtml = [
      paragraph('You can still sign in with your email and password if you have one set.'),
      renderButton('Open account settings', settings),
    ].join('');

    const html = renderEmail({
      title: subject,
      intro,
      bodyHtml,
      notYouKind: 'security',
    });

    const text = renderText({
      title: subject,
      intro,
      bodyLines: [
        'You can still sign in with your email and password if you have one set.',
        `Open account settings: ${settings}`,
      ],
      notYouKind: 'security',
    });

    return this.sendEmail({ to, subject, text, html });
  },

  async sendPasskeyAddedAlert({
    to,
    name,
  }: {
    to: string;
    name: string;
  }): Promise<boolean> {
    const settings = settingsUrl();
    const label = name.trim() || 'Passkey';
    const subject = 'Passkey added to your TUF account';
    const intro = `A passkey named "${label}" was added to your account.`;

    const bodyHtml = [
      paragraph('You can use it to sign in without a password on supported devices.'),
      renderButton('Open account settings', settings),
    ].join('');

    const html = renderEmail({
      title: subject,
      intro,
      bodyHtml,
      notYouKind: 'security',
    });

    const text = renderText({
      title: subject,
      intro,
      bodyLines: [
        'You can use it to sign in without a password on supported devices.',
        `Open account settings: ${settings}`,
      ],
      notYouKind: 'security',
    });

    return this.sendEmail({ to, subject, text, html });
  },

  async sendPasskeyRemovedAlert({
    to,
    name,
  }: {
    to: string;
    name: string;
  }): Promise<boolean> {
    const settings = settingsUrl();
    const label = name.trim() || 'Passkey';
    const subject = 'Passkey removed from your TUF account';
    const intro = `A passkey named "${label}" was removed from your account.`;

    const bodyHtml = [
      paragraph('If you still have other passkeys or a password, you can keep signing in as usual.'),
      renderButton('Open account settings', settings),
    ].join('');

    const html = renderEmail({
      title: subject,
      intro,
      bodyHtml,
      notYouKind: 'security',
    });

    const text = renderText({
      title: subject,
      intro,
      bodyLines: [
        'If you still have other passkeys or a password, you can keep signing in as usual.',
        `Open account settings: ${settings}`,
      ],
      notYouKind: 'security',
    });

    return this.sendEmail({ to, subject, text, html });
  },
};

export function formatEmailDate(date: Date): string {
  try {
    return new Intl.DateTimeFormat('en', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'UTC',
    }).format(date) + ' UTC';
  } catch {
    return date.toISOString();
  }
}
