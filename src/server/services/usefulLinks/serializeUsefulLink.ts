import type UsefulLink from '@/models/misc/UsefulLink.js';
import type UsefulLinkGroup from '@/models/misc/UsefulLinkGroup.js';

export type UsefulLinkJson = {
  id: number;
  title: string;
  url: string;
  description: string | null;
  groupId: number | null;
  group: string | null;
  groupSortOrder: number | null;
  sortWeight: number;
  isPublished: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type UsefulLinkGroupJson = {
  id: number;
  name: string;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
};

type LinkWithGroup = UsefulLink & {linkGroup?: UsefulLinkGroup | null};

export function serializeUsefulLink(row: UsefulLink): UsefulLinkJson {
  const nested = (row as LinkWithGroup).linkGroup ?? null;
  return {
    id: row.id,
    title: row.title,
    url: row.url,
    description: row.description ?? null,
    groupId: row.groupId ?? null,
    group: nested?.name ?? null,
    groupSortOrder: nested?.sortOrder ?? null,
    sortWeight: row.sortWeight,
    isPublished: Boolean(row.isPublished),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function serializeUsefulLinkGroup(group: UsefulLinkGroup): UsefulLinkGroupJson {
  return {
    id: group.id,
    name: group.name,
    sortOrder: group.sortOrder,
    createdAt: group.createdAt,
    updatedAt: group.updatedAt,
  };
}

export function compareSerializedLinkOrder(a: UsefulLinkJson, b: UsefulLinkJson): number {
  const groupedA = a.group && String(a.group).trim() !== '';
  const groupedB = b.group && String(b.group).trim() !== '';
  const groupA = groupedA ? (a.groupSortOrder ?? 0) : Number.MAX_SAFE_INTEGER;
  const groupB = groupedB ? (b.groupSortOrder ?? 0) : Number.MAX_SAFE_INTEGER;
  if (groupA !== groupB) return groupA - groupB;
  const sortA = a.sortWeight ?? 0;
  const sortB = b.sortWeight ?? 0;
  if (sortA !== sortB) return sortA - sortB;
  return (a.id ?? 0) - (b.id ?? 0);
}
