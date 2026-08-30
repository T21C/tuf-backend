import {parseHttpUrl, VERSION_MAX, type ParseResult} from './modFields.js';

export const REPORT_NOTE_MAX = 4000;
export const REPORT_REASONS = ['deprecated', 'abuse', 'duplicate'] as const;

export type ModReportReason = (typeof REPORT_REASONS)[number];

export type ModReportBody =
  | {reason: 'deprecated'; version: string; brokenEffect: string}
  | {reason: 'abuse'; note: string}
  | {reason: 'duplicate'; targetUrl: string; mergeWhy: string};

function requiredText(raw: unknown, label: string, max: number): ParseResult<string> {
  if (typeof raw !== 'string') return {ok: false, error: `${label} is required`};
  const trimmed = raw.trim();
  if (!trimmed) return {ok: false, error: `${label} is required`};
  if (trimmed.length > max) return {ok: false, error: `${label} is too long`};
  return {ok: true, value: trimmed};
}

export function parseModReportBody(body: unknown): ParseResult<ModReportBody> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return {ok: false, error: 'Invalid body'};
  }
  const src = body as Record<string, unknown>;
  const reason = typeof src.reason === 'string' ? src.reason.trim() : '';
  if (!REPORT_REASONS.includes(reason as ModReportReason)) {
    return {ok: false, error: 'reason must be deprecated, abuse, or duplicate'};
  }

  if (reason === 'deprecated') {
    const version = requiredText(src.version, 'version', VERSION_MAX);
    if (!version.ok) return version;
    const brokenEffect = requiredText(src.brokenEffect, 'brokenEffect', REPORT_NOTE_MAX);
    if (!brokenEffect.ok) return brokenEffect;
    return {ok: true, value: {reason, version: version.value, brokenEffect: brokenEffect.value}};
  }

  if (reason === 'abuse') {
    const note = requiredText(src.note, 'note', REPORT_NOTE_MAX);
    if (!note.ok) return note;
    return {ok: true, value: {reason, note: note.value}};
  }

  const targetUrl = parseHttpUrl(src.targetUrl, 'targetUrl');
  if (!targetUrl.ok) return targetUrl;
  const mergeWhy = requiredText(src.mergeWhy, 'mergeWhy', REPORT_NOTE_MAX);
  if (!mergeWhy.ok) return mergeWhy;
  return {ok: true, value: {reason: 'duplicate', targetUrl: targetUrl.value, mergeWhy: mergeWhy.value}};
}
