import { z } from 'zod';

export const FEATURED_LEVELS_BLOCK_TYPE = 'featuredLevels' as const;
export const MAX_FEATURED_LEVELS = 6;
export const FEATURED_MODES = ['levels', 'passes'] as const;

const zIdList = z
  .array(z.number().int().positive())
  .max(MAX_FEATURED_LEVELS)
  .transform((ids) => [...new Set(ids)]);

export const featuredLevelsBlockDataSchema = z.object({
  mode: z.enum(FEATURED_MODES).optional().default('levels'),
  levelIds: zIdList.optional().default([]),
  passIds: zIdList.optional().default([]),
});

export type FeaturedLevelsBlockData = z.infer<typeof featuredLevelsBlockDataSchema>;

export const featuredLevelsBlockDescriptor = {
  type: FEATURED_LEVELS_BLOCK_TYPE,
  maxPerCanvas: 3,
  defaultSize: { w: 700, h: 260 },
  resizeBehavior: 'free' as const,
  dataSchema: featuredLevelsBlockDataSchema,
  createDefault: (): FeaturedLevelsBlockData => ({
    mode: 'levels',
    levelIds: [],
    passIds: [],
  }),
  toPlainText: (data: FeaturedLevelsBlockData): string => {
    if (data.mode === 'passes') {
      return data.passIds?.length ? `[passes: ${data.passIds.join(', ')}]` : '';
    }
    return data.levelIds?.length ? `[levels: ${data.levelIds.join(', ')}]` : '';
  },
};
