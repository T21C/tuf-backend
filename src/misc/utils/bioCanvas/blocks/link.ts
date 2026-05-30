import { z } from 'zod';
import { zSafeUrl } from '../urls.js';

export const LINK_BLOCK_TYPE = 'link' as const;
export const MAX_LINK_LABEL_LENGTH = 80;

const DANGEROUS_LABEL = /url\s*\(|var\s*\(|expression\s*\(|@import|javascript:|\/\*|\*\/|<\/|<>/i;

export const linkBlockDataSchema = z.object({
  label: z
    .string()
    .max(MAX_LINK_LABEL_LENGTH)
    .transform((s) => s.trim())
    .refine((s) => s.length > 0 && !DANGEROUS_LABEL.test(s), { message: 'Invalid label' }),
  url: zSafeUrl,
});

export type LinkBlockData = z.infer<typeof linkBlockDataSchema>;

export const linkBlockDescriptor = {
  type: LINK_BLOCK_TYPE,
  maxPerCanvas: 50,
  defaultSize: { w: 320, h: 56 },
  resizeBehavior: 'widthOnly' as const,
  dataSchema: linkBlockDataSchema,
  createDefault: (): LinkBlockData => ({ label: '', url: '' }),
  toPlainText: (data: LinkBlockData): string => `${data.label} (${data.url})`,
};
