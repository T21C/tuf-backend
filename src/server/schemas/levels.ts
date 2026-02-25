import type { JsonSchema } from '@/server/middleware/apiDoc.js';

/** Single level alias item (song/artist alias) */
export const levelAliasItemSchema: JsonSchema = {
  type: 'object',
  properties: {
    id: { type: 'integer' },
    levelId: { type: 'integer' },
    field: { type: 'string', enum: ['song', 'artist'] },
    originalValue: { type: 'string' },
    alias: { type: 'string' },
    matchType: { type: 'string' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
};

/** Array of level aliases (GET :id/aliases response) */
export const levelAliasesResponseSchema: JsonSchema = {
  type: 'array',
  items: levelAliasItemSchema,
  description: 'List of aliases for the level',
};
