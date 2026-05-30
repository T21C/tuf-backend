import { z } from 'zod';

const DANGEROUS_TEXT = /url\s*\(|var\s*\(|expression\s*\(|@import|javascript:|\/\*|\*\/|<\/|<>/i;

export const TEXT_BLOCK_TYPE = 'text' as const;
export const MAX_TEXT_HEADING_LENGTH = 120;
export const MAX_TEXT_BODY_LENGTH = 4000;
export const MIN_TEXT_FONT_SIZE = 12;
export const MAX_TEXT_FONT_SIZE = 72;
export const DEFAULT_TEXT_FONT_SIZE = 16;
export const DEFAULT_TEXT_HEADING_FONT_SIZE = 20;
export const TEXT_ALIGNMENTS = ['left', 'center', 'right'] as const;

const zPlainText = (max: number) =>
  z
    .string()
    .max(max)
    .transform((s) => s.trim())
    .refine((s) => !DANGEROUS_TEXT.test(s), { message: 'Invalid text content' });

export function clampTextFontSize(value: unknown, fallback = DEFAULT_TEXT_FONT_SIZE): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_TEXT_FONT_SIZE, Math.max(MIN_TEXT_FONT_SIZE, n));
}

const zFontSize = () => z.number().optional();

const zBodyText = (max: number) =>
  z
    .string()
    .max(max)
    .refine((s) => !DANGEROUS_TEXT.test(s), { message: 'Invalid text content' });

export const textBlockDataSchema = z.object({
  heading: zPlainText(MAX_TEXT_HEADING_LENGTH).nullable().optional(),
  body: zBodyText(MAX_TEXT_BODY_LENGTH),
  fontSize: zFontSize(),
  headingFontSize: zFontSize(),
  align: z.enum(TEXT_ALIGNMENTS).optional().default('left'),
});

export type TextBlockData = z.infer<typeof textBlockDataSchema>;

export const textBlockDescriptor = {
  type: TEXT_BLOCK_TYPE,
  maxPerCanvas: 20,
  defaultSize: { w: 600, h: 120 },
  resizeBehavior: 'text' as const,
  dataSchema: textBlockDataSchema,
  createDefault: (): TextBlockData => ({
    heading: null,
    body: 'Sample text',
    fontSize: DEFAULT_TEXT_FONT_SIZE,
    headingFontSize: DEFAULT_TEXT_HEADING_FONT_SIZE,
    align: 'left',
  }),
  toPlainText: (data: TextBlockData): string => {
    const parts: string[] = [];
    if (data.heading?.trim()) parts.push(data.heading.trim());
    if (data.body?.trim()) parts.push(data.body.trim());
    return parts.join('\n');
  },
};
