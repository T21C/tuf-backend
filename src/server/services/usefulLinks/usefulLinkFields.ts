export const TITLE_MAX = 255;
export const URL_MAX = 2048;
export const DESCRIPTION_MAX = 2000;
export const GROUP_NAME_MAX = 64;

export type UsefulLinkFields = {
  title: string;
  url: string;
  description: string | null;
  isPublished: boolean;
  group?: string | null;
  groupId?: number | null;
};

export type ParseResult<T> = {ok: true; value: T} | {ok: false; error: string};

function optionalText(raw: unknown, max: number): ParseResult<string | null> {
  if (raw == null) return {ok: true, value: null};
  if (typeof raw !== 'string') return {ok: false, error: 'Invalid text field'};
  const trimmed = raw.trim();
  if (!trimmed) return {ok: true, value: null};
  if (trimmed.length > max) {
    return {ok: false, error: `Must be at most ${max} characters`};
  }
  return {ok: true, value: trimmed};
}

export function parseHttpUrl(raw: unknown): ParseResult<string> {
  if (typeof raw !== 'string') return {ok: false, error: 'url is required'};
  const trimmed = raw.trim();
  if (!trimmed) return {ok: false, error: 'url is required'};
  if (trimmed.length > URL_MAX) return {ok: false, error: 'url is too long'};
  if (/^(javascript|data|vbscript):/i.test(trimmed)) {
    return {ok: false, error: 'url must be http or https'};
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return {ok: false, error: 'url must be http or https'};
    }
    if (parsed.username || parsed.password) {
      return {ok: false, error: 'url must not include credentials'};
    }
    return {ok: true, value: parsed.href};
  } catch {
    return {ok: false, error: 'url is invalid'};
  }
}

export function parseGroupName(raw: unknown): ParseResult<string> {
  if (typeof raw !== 'string') return {ok: false, error: 'Group name is required'};
  const name = raw.trim();
  if (!name) return {ok: false, error: 'Group name is required'};
  if (name.length > GROUP_NAME_MAX) {
    return {ok: false, error: 'Group name is too long'};
  }
  return {ok: true, value: name};
}

function parseOptionalGroupName(raw: unknown): ParseResult<string | null | undefined> {
  if (raw === undefined) return {ok: true, value: undefined};
  if (raw === null || raw === 'null') return {ok: true, value: null};
  return optionalText(raw, GROUP_NAME_MAX);
}

function parseOptionalGroupId(raw: unknown): ParseResult<number | null | undefined> {
  if (raw === undefined) return {ok: true, value: undefined};
  if (raw === null || raw === '' || raw === 'null') return {ok: true, value: null};
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isInteger(n) || n <= 0) return {ok: false, error: 'Invalid groupId'};
  return {ok: true, value: n};
}

export function parseUsefulLinkCreate(body: unknown): ParseResult<UsefulLinkFields> {
  const src = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const titleRaw = typeof src.title === 'string' ? src.title.trim() : '';
  if (!titleRaw) return {ok: false, error: 'title is required'};
  if (titleRaw.length > TITLE_MAX) return {ok: false, error: 'title is too long'};

  const url = parseHttpUrl(src.url);
  if (!url.ok) return url;

  const description = optionalText(src.description, DESCRIPTION_MAX);
  if (!description.ok) return description;

  const group = parseOptionalGroupName(src.group);
  if (!group.ok) return group;

  const groupId = parseOptionalGroupId(src.groupId);
  if (!groupId.ok) return groupId;

  const isPublished =
    typeof src.isPublished === 'boolean' ? src.isPublished : true;

  return {
    ok: true,
    value: {
      title: titleRaw,
      url: url.value,
      description: description.value,
      isPublished,
      group: group.value === undefined ? null : group.value,
      groupId: groupId.value === undefined ? null : groupId.value,
    },
  };
}

export function parseUsefulLinkPatch(
  body: unknown,
): ParseResult<Partial<UsefulLinkFields>> {
  if (!body || typeof body !== 'object') {
    return {ok: false, error: 'Request body is required'};
  }
  const src = body as Record<string, unknown>;
  const updates: Partial<UsefulLinkFields> = {};

  if (src.title !== undefined) {
    if (typeof src.title !== 'string') return {ok: false, error: 'title is invalid'};
    const title = src.title.trim();
    if (!title) return {ok: false, error: 'title is required'};
    if (title.length > TITLE_MAX) return {ok: false, error: 'title is too long'};
    updates.title = title;
  }

  if (src.url !== undefined) {
    const url = parseHttpUrl(src.url);
    if (!url.ok) return url;
    updates.url = url.value;
  }

  if (src.description !== undefined) {
    const description = optionalText(src.description, DESCRIPTION_MAX);
    if (!description.ok) return description;
    updates.description = description.value;
  }

  if (src.group !== undefined) {
    const group = parseOptionalGroupName(src.group);
    if (!group.ok) return group;
    updates.group = group.value ?? null;
  }

  if (src.groupId !== undefined) {
    const groupId = parseOptionalGroupId(src.groupId);
    if (!groupId.ok) return groupId;
    updates.groupId = groupId.value ?? null;
  }

  if (src.isPublished !== undefined) {
    if (typeof src.isPublished !== 'boolean') {
      return {ok: false, error: 'isPublished must be a boolean'};
    }
    updates.isPublished = src.isPublished;
  }

  if (!Object.keys(updates).length) {
    return {ok: false, error: 'No fields to update'};
  }

  return {ok: true, value: updates};
}

export type SortOrderItem = {id: number; sortOrder: number};

export function parseSortOrders(value: unknown): SortOrderItem[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<number>();
  const items: SortOrderItem[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const src = raw as Record<string, unknown>;
    const id = Number(src.id);
    const sortOrder = Number(src.sortOrder);
    if (!Number.isInteger(id) || id <= 0 || seen.has(id)) continue;
    if (!Number.isInteger(sortOrder)) continue;
    seen.add(id);
    items.push({id, sortOrder});
  }
  return items;
}

export function parseOrderedIds(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<number>();
  const ids: number[] = [];
  for (const item of value) {
    const n = Number(item);
    if (!Number.isInteger(n) || n <= 0 || seen.has(n)) continue;
    seen.add(n);
    ids.push(n);
  }
  return ids;
}

export function mergeOrderedIds(requested: number[], existingIds: number[]): number[] {
  const existing = new Set(existingIds);
  const seen = new Set<number>();
  const ordered: number[] = [];
  for (const id of requested) {
    if (!existing.has(id) || seen.has(id)) continue;
    seen.add(id);
    ordered.push(id);
  }
  for (const id of existingIds) {
    if (!seen.has(id)) ordered.push(id);
  }
  return ordered;
}
