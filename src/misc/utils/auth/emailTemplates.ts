import { clientUrlEnv } from '@/config/app.config.js';
import { escapeHtml } from '@/misc/utils/Utility.js';

export { escapeHtml };

const BRAND = 'The Universal Forums';
const PRIMARY = '#4a90e2';
const TEXT = '#1a1a1a';
const MUTED = '#666666';
const BG = '#f4f5f7';
const CARD = '#ffffff';
const BORDER = '#e5e7eb';

/**
 * Footer variants:
 * - 'ignore': plain one-time codes where no action is needed if unrequested.
 * - 'security': the standard security footer ("Wasn't this you? Change your password immediately.").
 * - 'security-reset': same wording, but links to the password reset page — used
 *   when the password itself may have been taken over and no longer works.
 */
export type NotYouKind = 'ignore' | 'security' | 'security-reset';

function siteUrl(): string {
  return String(clientUrlEnv || 'https://tuforums.com').replace(/\/$/, '');
}

export function settingsUrl(): string {
  return `${siteUrl()}/settings/account`;
}

export function forgotPasswordUrl(): string {
  return `${siteUrl()}/forgot-password`;
}

export function renderCode(code: string): string {
  const safe = escapeHtml(code);
  return `
    <div style="margin: 24px 0; text-align: center;">
      <div style="display: inline-block; padding: 14px 22px; background: ${BG}; border: 1px solid ${BORDER}; border-radius: 8px; font-size: 28px; letter-spacing: 6px; font-weight: 700; color: ${TEXT}; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;">
        ${safe}
      </div>
    </div>
  `;
}

export function renderButton(label: string, url: string): string {
  const safeLabel = escapeHtml(label);
  const safeUrl = escapeHtml(url);
  return `
    <div style="margin: 28px 0; text-align: center;">
      <a href="${safeUrl}" style="display: inline-block; padding: 12px 22px; background: ${PRIMARY}; color: #ffffff; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 15px;">
        ${safeLabel}
      </a>
    </div>
  `;
}

function notYouCopy(kind: NotYouKind): { html: string; text: string } {
  switch (kind) {
    case 'ignore':
      return {
        html: `<p style="margin: 0; color: ${MUTED}; font-size: 13px; line-height: 1.5;">Didn't request this? You can safely ignore this email.</p>`,
        text: "Didn't request this? You can safely ignore this email.",
      };
    case 'security': {
      const url = settingsUrl();
      return {
        html: `<p style="margin: 0; color: ${MUTED}; font-size: 13px; line-height: 1.5;">Wasn't this you? <a href="${escapeHtml(url)}" style="color: ${PRIMARY}; font-weight: 700;">Change your password immediately.</a></p>`,
        text: `Wasn't this you? Change your password immediately: ${url}`,
      };
    }
    case 'security-reset': {
      const url = forgotPasswordUrl();
      return {
        html: `<p style="margin: 0; color: ${MUTED}; font-size: 13px; line-height: 1.5;">Wasn't this you? <a href="${escapeHtml(url)}" style="color: ${PRIMARY}; font-weight: 700;">Change your password immediately.</a></p>`,
        text: `Wasn't this you? Change your password immediately: ${url}`,
      };
    }
    default:
      return notYouCopy('security');
  }
}

export function renderNotYouBlock(kind: NotYouKind): string {
  return `
    <div style="margin-top: 28px; padding-top: 20px; border-top: 1px solid ${BORDER};">
      ${notYouCopy(kind).html}
    </div>
  `;
}

export function notYouText(kind: NotYouKind): string {
  return notYouCopy(kind).text;
}

export interface RenderEmailOptions {
  title: string;
  intro?: string;
  bodyHtml: string;
  footerNote?: string;
  notYouKind?: NotYouKind;
}

/**
 * Shared HTML shell for all account emails.
 * Inline styles only — email clients strip external CSS.
 */
export function renderEmail({
  title,
  intro,
  bodyHtml,
  footerNote,
  notYouKind,
}: RenderEmailOptions): string {
  const home = siteUrl();
  const settings = settingsUrl();
  const safeTitle = escapeHtml(title);
  const safeIntro = intro ? escapeHtml(intro) : '';
  const notYou = notYouKind ? renderNotYouBlock(notYouKind) : '';
  const why =
    footerNote ||
    `Why did I get this? This message relates to your ${BRAND} account. Manage your account at Settings.`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${safeTitle}</title>
</head>
<body style="margin: 0; padding: 0; background: ${BG}; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: ${TEXT};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background: ${BG}; padding: 32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width: 560px;">
          <tr>
            <td style="padding: 0 0 20px; text-align: center;">
              <a href="${escapeHtml(home)}" style="color: ${PRIMARY}; text-decoration: none; font-size: 20px; font-weight: 700; letter-spacing: 0.02em;">
                ${escapeHtml(BRAND)}
              </a>
            </td>
          </tr>
          <tr>
            <td style="background: ${CARD}; border: 1px solid ${BORDER}; border-radius: 12px; padding: 32px 28px;">
              <h1 style="margin: 0 0 12px; font-size: 22px; line-height: 1.3; color: ${TEXT};">${safeTitle}</h1>
              ${safeIntro ? `<p style="margin: 0 0 20px; font-size: 15px; line-height: 1.55; color: ${MUTED};">${safeIntro}</p>` : ''}
              <div style="font-size: 15px; line-height: 1.55; color: ${TEXT};">
                ${bodyHtml}
              </div>
              ${notYou}
            </td>
          </tr>
          <tr>
            <td style="padding: 20px 8px 0; text-align: center;">
              <p style="margin: 0 0 8px; font-size: 12px; line-height: 1.5; color: ${MUTED};">${escapeHtml(why)}</p>
              <p style="margin: 0; font-size: 12px; line-height: 1.5;">
                <a href="${escapeHtml(settings)}" style="color: ${PRIMARY}; text-decoration: none;">Manage your account</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export interface RenderTextOptions {
  title: string;
  intro?: string;
  bodyLines: string[];
  notYouKind?: NotYouKind;
}

/** Matching plain-text body so text and html never drift. */
export function renderText({
  title,
  intro,
  bodyLines,
  notYouKind,
}: RenderTextOptions): string {
  const settings = settingsUrl();
  const parts = [
    title,
    '',
    ...(intro ? [intro, ''] : []),
    ...bodyLines,
  ];
  if (notYouKind) {
    parts.push('', notYouText(notYouKind));
  }
  parts.push(
    '',
    `Why did I get this? This message relates to your ${BRAND} account.`,
    `Manage your account: ${settings}`,
  );
  return parts.join('\n');
}

export function paragraph(html: string): string {
  return `<p style="margin: 0 0 14px; font-size: 15px; line-height: 1.55; color: ${TEXT};">${html}</p>`;
}

export function mutedParagraph(html: string): string {
  return `<p style="margin: 0 0 14px; font-size: 14px; line-height: 1.55; color: ${MUTED};">${html}</p>`;
}

export function detailList(items: Array<{ label: string; value: string }>): string {
  const rows = items
    .filter((i) => i.value)
    .map(
      (i) =>
        `<tr>
          <td style="padding: 6px 12px 6px 0; color: ${MUTED}; font-size: 13px; vertical-align: top; white-space: nowrap;">${escapeHtml(i.label)}</td>
          <td style="padding: 6px 0; color: ${TEXT}; font-size: 14px; vertical-align: top;">${escapeHtml(i.value)}</td>
        </tr>`,
    )
    .join('');
  if (!rows) return '';
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin: 8px 0 16px; width: 100%;">${rows}</table>`;
}
