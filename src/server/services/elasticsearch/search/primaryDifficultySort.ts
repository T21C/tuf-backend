/** Doc field holding the level's difficulty id: level documents use `diffId`, pass documents nest under `level`. */
export type LevelDifficultyDocField = 'diffId' | 'level.diffId';

/**
 * Painless: map level.diffId to DB canonical sort order (params.difficultySortOrderById).
 */
export function getPrimaryDifficultySortScriptSource(levelDifficultyDocField: LevelDifficultyDocField): string {
  return `
  if (doc['${levelDifficultyDocField}'].size() == 0) {
    return params.missingPrimaryDifficultySortKey;
  }
  int levelDifficultyId = (int) doc['${levelDifficultyDocField}'].value;
  String levelDifficultyIdKey = Integer.toString(levelDifficultyId);
  if (params.difficultySortOrderById.containsKey(levelDifficultyIdKey)) {
    return params.difficultySortOrderById.get(levelDifficultyIdKey);
  }
  return params.missingPrimaryDifficultySortKey;
`.trim();
}

export function buildPrimaryDifficultySortScript(
  levelDifficultyDocField: LevelDifficultyDocField,
  direction: 'asc' | 'desc',
  difficultySortOrderById: Record<string, number>
): Record<string, unknown> {
  const missingPrimaryDifficultySortKey = direction === 'asc' ? 2147483647 : -2147483648;
  return {
    _script: {
      type: 'number',
      order: direction,
      script: {
        source: getPrimaryDifficultySortScriptSource(levelDifficultyDocField),
        params: {
          difficultySortOrderById,
          missingPrimaryDifficultySortKey,
        },
      },
    },
  };
}
