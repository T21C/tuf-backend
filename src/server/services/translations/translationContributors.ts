import {isConfiguredSiteLanguage} from '@/config/siteLanguages.js';
import TranslationContributor from '@/models/misc/TranslationContributor.js';

const MAX_CONTRIBUTORS = 40;
const MAX_NAME_LENGTH = 80;

export class TranslationContributorInputError extends Error {
  readonly status = 400;
}

export async function listTranslationContributorsByLanguage(): Promise<Record<string, string[]>> {
  const rows = await TranslationContributor.findAll({
    attributes: ['languageCode', 'name', 'sortOrder'],
    order: [
      ['languageCode', 'ASC'],
      ['sortOrder', 'ASC'],
      ['id', 'ASC'],
    ],
  });

  const byLanguage: Record<string, string[]> = {};
  for (const row of rows) {
    const names = byLanguage[row.languageCode] ?? [];
    names.push(row.name);
    byLanguage[row.languageCode] = names;
  }
  return byLanguage;
}

export function parseContributorNameList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new TranslationContributorInputError('names must be an array of strings');
  }

  const names: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') {
      throw new TranslationContributorInputError('names must be an array of strings');
    }
    const trimmed = item.trim();
    if (!trimmed) continue;
    if (trimmed.length > MAX_NAME_LENGTH) {
      throw new TranslationContributorInputError(
        `Each name must be at most ${MAX_NAME_LENGTH} characters`,
      );
    }
    names.push(trimmed);
  }

  if (names.length > MAX_CONTRIBUTORS) {
    throw new TranslationContributorInputError(
      `A language can have at most ${MAX_CONTRIBUTORS} contributors`,
    );
  }

  return names;
}

export function parseTranslationLanguageCode(value: unknown): string {
  if (typeof value !== 'string') {
    throw new TranslationContributorInputError('Unknown language');
  }
  const code = value.trim().toLowerCase();
  if (!code || !isConfiguredSiteLanguage(code)) {
    throw new TranslationContributorInputError('Unknown language');
  }
  return code;
}

export async function replaceTranslationContributors(
  languageCode: string,
  names: string[],
): Promise<string[]> {
  const sequelize = TranslationContributor.sequelize;
  if (!sequelize) {
    throw new Error('Translation contributor store is unavailable');
  }

  await sequelize.transaction(async transaction => {
    await TranslationContributor.destroy({where: {languageCode}, transaction});
    if (names.length === 0) return;
    await TranslationContributor.bulkCreate(
      names.map((name, sortOrder) => ({languageCode, name, sortOrder})),
      {transaction},
    );
  });

  return names;
}
