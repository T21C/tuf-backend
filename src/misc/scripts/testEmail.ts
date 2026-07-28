import { emailService } from '@/misc/utils/auth/email.js';
import { Command } from 'commander';

const TEMPLATES = [
  'verify-register',
  'verify-change',
  'verify-add',
  'email-change-notice',
  'password-reset-code',
  'step-up',
  'login-code',
  'new-signin',
  'password-changed',
  'password-set',
  'password-reset-alert',
  'deletion-scheduled',
  'oauth-unlinked',
] as const;

type TemplateName = (typeof TEMPLATES)[number];

async function sendTemplate(email: string, template: TemplateName) {
  const code = 'ABCD2345';
  switch (template) {
    case 'verify-register':
      return emailService.sendEmailVerificationCode({
        to: email,
        code,
        purpose: 'register',
        toEmail: email,
      });
    case 'verify-change':
      return emailService.sendEmailVerificationCode({
        to: email,
        code,
        purpose: 'change',
        fromEmail: 'old@example.com',
        toEmail: email,
      });
    case 'verify-add':
      return emailService.sendEmailVerificationCode({
        to: email,
        code,
        purpose: 'add',
        toEmail: email,
      });
    case 'email-change-notice':
      return emailService.sendEmailChangeNoticeToOld({
        to: email,
        fromEmail: email,
        toEmail: 'new@example.com',
      });
    case 'password-reset-code':
      return emailService.sendPasswordResetCode({ to: email, code });
    case 'step-up':
      return emailService.sendStepUpCode({
        to: email,
        code,
        action: 'change your password',
      });
    case 'login-code':
      return emailService.sendLoginCode({ to: email, code });
    case 'new-signin':
      return emailService.sendNewSignInAlert({
        to: email,
        device: 'Chrome on Windows',
        location: 'Warsaw, Poland',
        when: 'Jul 28, 2026, 4:00 PM UTC',
        remembered: true,
        method: 'password',
      });
    case 'password-changed':
      return emailService.sendPasswordChangedAlert({ to: email, kind: 'changed' });
    case 'password-set':
      return emailService.sendPasswordChangedAlert({ to: email, kind: 'set' });
    case 'password-reset-alert':
      return emailService.sendPasswordResetAlert({ to: email });
    case 'deletion-scheduled':
      return emailService.sendDeletionScheduledAlert({
        to: email,
        executeAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
      });
    case 'oauth-unlinked':
      return emailService.sendOAuthUnlinkedAlert({ to: email, provider: 'discord' });
    default:
      throw new Error(`Unknown template: ${template}`);
  }
}

const program = new Command();

program
  .name('test-email')
  .description('Preview account email templates via MailerSend');

program
  .command('test')
  .description('Send one or all email templates to a test inbox')
  .option('-e, --email <email>', 'Email to send to', 'test@test.com')
  .option(
    '-t, --template <name>',
    `Template name (${TEMPLATES.join(', ')}) or "all"`,
    'login-code',
  )
  .action(async (options) => {
    const list: TemplateName[] =
      options.template === 'all'
        ? [...TEMPLATES]
        : [options.template as TemplateName];

    for (const name of list) {
      if (!TEMPLATES.includes(name)) {
        console.error(`Unknown template "${name}". Choose: ${TEMPLATES.join(', ')}, all`);
        process.exitCode = 1;
        return;
      }
      const ok = await sendTemplate(options.email, name);
      console.log(`${name}: ${ok ? 'sent' : 'failed'}`);
    }
  });

program.parse(process.argv);
