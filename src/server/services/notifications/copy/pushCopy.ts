import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';

export interface PushCopyFile {
  untitledLevel?: string;
  unknownArtist?: string;
  unknown?: {title?: string; body?: string};
  visibility?: {public?: string; hidden?: string};
  types?: unknown;
}

const cache = new Map<string, PushCopyFile>();

function localeDir(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'locales');
}

export function normalizePushLocale(locale: string | null | undefined): string {
  const raw = (locale ?? 'en').trim().toLowerCase().replace('_', '-');
  if (raw.startsWith('ko') || raw === 'kr') return 'kr';
  if (raw.startsWith('zh') || raw === 'cn') return 'cn';
  if (raw.startsWith('fr')) return 'fr';
  if (raw.startsWith('pl')) return 'pl';
  if (raw.startsWith('en')) return 'en';
  const short = raw.split('-')[0] ?? 'en';
  return ['en', 'kr', 'cn', 'fr', 'pl'].includes(short) ? short : 'en';
}

export function interpolateTemplate(
  template: string,
  vars: Record<string, string | number | null | undefined>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const value = vars[key];
    if (value == null) return '';
    return String(value);
  });
}

function lookupPath(root: unknown, dotted: string): unknown {
  let current: unknown = root;
  for (const part of dotted.split('.')) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function loadPushCopy(locale: string): PushCopyFile {
  const normalized = normalizePushLocale(locale);
  const cached = cache.get(normalized);
  if (cached) return cached;
  const filePath = path.join(localeDir(), `${normalized}.json`);
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as PushCopyFile;
    cache.set(normalized, parsed);
    return parsed;
  } catch {
    if (normalized !== 'en') return loadPushCopy('en');
    cache.set('en', {});
    return {};
  }
}

export function renderPushCopy(
  locale: string,
  type: string,
  payload: Record<string, unknown>,
): {title: string; body: string} {
  const copy = loadPushCopy(locale);
  const fallback = locale === 'en' ? copy : loadPushCopy('en');
  const song =
    (typeof payload.song === 'string' && payload.song) ||
    interpolateTemplate(copy.untitledLevel || fallback.untitledLevel || 'Level #{{levelId}}', {
      levelId: typeof payload.levelId === 'number' ? payload.levelId : '',
    });
  const artist =
    (typeof payload.artist === 'string' && payload.artist) ||
    copy.unknownArtist ||
    fallback.unknownArtist ||
    'Unknown artist';
  const visibility = payload.isHidden
    ? copy.visibility?.hidden || fallback.visibility?.hidden || 'hidden'
    : copy.visibility?.public || fallback.visibility?.public || 'public';
  const vars: Record<string, string | number | null | undefined> = {
    ...payload,
    song,
    artist,
    visibility,
    reason: undefined,
  };
  const typeNode = lookupPath(copy.types, type) as {title?: string; body?: string} | undefined;
  const fallbackType = lookupPath(fallback.types, type) as {title?: string; body?: string} | undefined;
  const titleTemplate = typeNode?.title || fallbackType?.title || copy.unknown?.title || fallback.unknown?.title || 'New notification';
  const bodyTemplate = typeNode?.body || fallbackType?.body || copy.unknown?.body || fallback.unknown?.body || '';
  return {
    title: interpolateTemplate(titleTemplate, vars).trim(),
    body: interpolateTemplate(bodyTemplate, vars).trim(),
  };
}
