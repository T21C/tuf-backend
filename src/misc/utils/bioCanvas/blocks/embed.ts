import { z } from 'zod';
import { parseSafeUrl, zSafeUrl } from '../urls.js';

export const EMBED_BLOCK_TYPE = 'embed' as const;
export const MAX_EMBED_TITLE_LENGTH = 120;

const DANGEROUS_TITLE = /url\s*\(|var\s*\(|expression\s*\(|@import|javascript:|\/\*|\*\/|<\/|<>/i;

/** Allowed video hosts: YouTube and Bilibili only. */
const EMBED_HOST_PATTERNS: Array<{ host: RegExp; label: string }> = [
  { host: /(^|\.)youtube\.com$|(^|\.)youtu\.be$/i, label: 'youtube' },
  { host: /(^|\.)bilibili\.com$|(^|\.)b23\.tv$/i, label: 'bilibili' },
];

export function getEmbedProvider(url: string): string | null {
  try {
    const host = new URL(url).hostname.replace(/^www\./i, '');
    for (const row of EMBED_HOST_PATTERNS) {
      if (row.host.test(host)) return row.label;
    }
    return null;
  } catch {
    return null;
  }
}

const zEmbedUrl = zSafeUrl.refine((url) => getEmbedProvider(url) !== null, {
  message: 'Only YouTube and Bilibili video links are supported',
});

export const embedBlockDataSchema = z.object({
  url: zEmbedUrl,
  title: z
    .string()
    .max(MAX_EMBED_TITLE_LENGTH)
    .transform((s) => s.trim())
    .refine((s) => !DANGEROUS_TITLE.test(s), { message: 'Invalid title' })
    .optional(),
});

export type EmbedBlockData = z.infer<typeof embedBlockDataSchema>;

export const embedBlockDescriptor = {
  type: EMBED_BLOCK_TYPE,
  maxPerCanvas: 10,
  defaultSize: { w: 640, h: 360 },
  resizeBehavior: 'aspect' as const,
  dataSchema: embedBlockDataSchema,
  createDefault: (): EmbedBlockData => ({ url: '', title: '' }),
  toPlainText: (data: EmbedBlockData): string => {
    const title = data.title?.trim();
    return title ? `[video: ${title}] ${data.url}` : `[video] ${data.url}`;
  },
};

/** Client-side preview helper (does not enforce provider allowlist). */
export function isLikelyEmbedUrl(raw: unknown): boolean {
  const parsed = parseSafeUrl(raw);
  return parsed !== null && getEmbedProvider(parsed) !== null;
}
