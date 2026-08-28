import {Includeable, Order, Transaction} from 'sequelize';
import UsefulLink from '@/models/misc/UsefulLink.js';
import UsefulLinkLocale from '@/models/misc/UsefulLinkLocale.js';
import {
  serializeUsefulLink,
  compareSerializedLinkOrder,
  type UsefulLinkJson,
} from './serializeUsefulLink.js';
import {LINK_TAGS_INCLUDE} from './usefulLinkTagService.js';
import {DEFAULT_SITE_LANGUAGE} from '@/config/siteLanguages.js';

export {serializeUsefulLink, compareSerializedLinkOrder, type UsefulLinkJson};

export const LINK_LOCALES_INCLUDE: Includeable = {
  model: UsefulLinkLocale,
  as: 'locales',
  required: false,
};

export const LINK_LIST_ORDER: Order = [
  ['sortWeight', 'ASC'],
  ['id', 'ASC'],
];

export function serializeUsefulLinks(links: UsefulLink[]): UsefulLinkJson[] {
  return links.map(serializeUsefulLink);
}

export async function listSerializedLinks(opts?: {
  publishedOnly?: boolean;
  catalogOnly?: boolean;
  transaction?: Transaction;
}): Promise<UsefulLinkJson[]> {
  const where: Record<string, unknown> = {};
  if (opts?.publishedOnly) where.isPublished = true;
  if (opts?.catalogOnly) where.isCatalog = true;
  const links = await UsefulLink.findAll({
    where: Object.keys(where).length ? where : undefined,
    include: [LINK_TAGS_INCLUDE, LINK_LOCALES_INCLUDE],
    order: LINK_LIST_ORDER,
    transaction: opts?.transaction,
  });
  return serializeUsefulLinks(links).sort(compareSerializedLinkOrder);
}

export async function loadSerializedLink(
  linkId: number,
  transaction?: Transaction,
): Promise<UsefulLinkJson | null> {
  const link = await UsefulLink.findByPk(linkId, {
    include: [LINK_TAGS_INCLUDE, LINK_LOCALES_INCLUDE],
    transaction,
  });
  return link ? serializeUsefulLink(link) : null;
}

export async function upsertEnglishLocale(
  link: {id: number; title: string; url: string; description?: string | null},
  transaction?: Transaction,
): Promise<void> {
  const existing = await UsefulLinkLocale.findOne({
    where: {linkId: link.id, languageCode: DEFAULT_SITE_LANGUAGE},
    transaction,
  });
  const fields = {
    title: link.title,
    url: link.url,
    description: link.description ?? null,
    updatedAt: new Date(),
  };
  if (existing) {
    await existing.update(fields, {transaction});
    return;
  }
  await UsefulLinkLocale.create(
    {
      linkId: link.id,
      languageCode: DEFAULT_SITE_LANGUAGE,
      ...fields,
      createdAt: new Date(),
    },
    {transaction},
  );
}
