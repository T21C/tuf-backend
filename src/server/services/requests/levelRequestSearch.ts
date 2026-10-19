import {Op, type WhereOptions} from 'sequelize';
import Level from '@/models/levels/Level.js';
import User from '@/models/auth/User.js';
import {
  matchRequestStatuses,
  matchRequestTypes,
  parseLevelRequestSearchQuery,
  parsePositiveSearchInt,
  requestSearchHasStatusField,
} from '@/misc/utils/data/levelRequestSearch.js';
import type {FieldSearch, SearchGroup} from '@/misc/utils/data/queryParser.js';

const MATCH_NONE: WhereOptions = {id: -1};

function likeNeedle(value: string): string {
  return value.replace(/[%_\\]/g, '').slice(0, 80);
}

function textCompare(value: string, exact: boolean, isNot: boolean) {
  const trimmed = value.slice(0, 80);
  if (exact) {
    return isNot ? {[Op.ne]: trimmed} : trimmed;
  }
  const like = `%${likeNeedle(trimmed)}%`;
  return isNot ? {[Op.notLike]: like} : {[Op.like]: like};
}

function idsConstraint(column: 'id' | 'levelId' | 'requesterUserId', ids: Array<number | string>, isNot: boolean): WhereOptions | null {
  if (!ids.length) return isNot ? null : MATCH_NONE;
  return {[column]: isNot ? {[Op.notIn]: ids} : {[Op.in]: ids}};
}

async function matchingLevelIds(field: 'song' | 'artist' | 'any', value: string, exact: boolean): Promise<number[]> {
  const cond = textCompare(value, exact, false);
  const where = field === 'any'
    ? {[Op.or]: [{song: cond}, {artist: cond}]}
    : {[field]: cond};
  const levels = await Level.findAll({where, attributes: ['id']});
  return levels.map((level) => level.id);
}

async function matchingUserIds(value: string, exact: boolean): Promise<string[]> {
  const cond = textCompare(value, exact, false);
  const users = await User.findAll({
    where: {[Op.or]: [{username: cond}, {nickname: cond}]},
    attributes: ['id'],
  });
  return users.map((user) => user.id);
}

async function whereForTerm(term: FieldSearch, mine: boolean): Promise<WhereOptions | null> {
  if (term.field === 'id') {
    const id = parsePositiveSearchInt(term.value);
    if (id == null) return term.isNot ? null : MATCH_NONE;
    return {id: term.isNot ? {[Op.ne]: id} : id};
  }
  if (term.field === 'level') {
    const id = parsePositiveSearchInt(term.value);
    if (id == null) return term.isNot ? null : MATCH_NONE;
    return {levelId: term.isNot ? {[Op.ne]: id} : id};
  }
  if (term.field === 'song' || term.field === 'artist') {
    const ids = await matchingLevelIds(term.field, term.value, term.exact);
    return idsConstraint('levelId', ids, term.isNot);
  }
  if (term.field === 'requester') {
    const ids = await matchingUserIds(term.value, term.exact);
    return idsConstraint('requesterUserId', ids, term.isNot);
  }
  if (term.field === 'status') {
    const statuses = matchRequestStatuses(term.value, term.exact);
    if (!statuses.length) return term.isNot ? null : MATCH_NONE;
    return {status: term.isNot ? {[Op.notIn]: statuses} : {[Op.in]: statuses}};
  }
  if (term.field === 'type') {
    const types = matchRequestTypes(term.value, term.exact);
    if (!types.length) return term.isNot ? null : MATCH_NONE;
    return {type: term.isNot ? {[Op.notIn]: types} : {[Op.in]: types}};
  }
  if (term.field === 'reason') {
    return {reason: textCompare(term.value, term.exact, term.isNot)};
  }

  const parts: WhereOptions[] = [];
  const numericId = parsePositiveSearchInt(term.value);
  if (numericId != null) {
    parts.push({id: numericId});
    parts.push({levelId: numericId});
  }
  const levelIds = await matchingLevelIds('any', term.value, term.exact);
  if (levelIds.length) parts.push({levelId: {[Op.in]: levelIds}});
  if (!mine) {
    const userIds = await matchingUserIds(term.value, term.exact);
    if (userIds.length) parts.push({requesterUserId: {[Op.in]: userIds}});
  }
  const statuses = matchRequestStatuses(term.value, term.exact);
  if (statuses.length) parts.push({status: {[Op.in]: statuses}});
  if (mine) {
    const types = matchRequestTypes(term.value, term.exact);
    if (types.length) parts.push({type: {[Op.in]: types}});
  }
  parts.push({reason: textCompare(term.value, term.exact, false)});
  const positive = parts.length === 1 ? parts[0] : {[Op.or]: parts};
  return term.isNot ? {[Op.not]: positive} : positive;
}

async function whereForGroup(terms: FieldSearch[], mine: boolean): Promise<WhereOptions | null> {
  const parts: WhereOptions[] = [];
  for (const term of terms) {
    const part = await whereForTerm(term, mine);
    if (part === MATCH_NONE) return MATCH_NONE;
    if (part) parts.push(part);
  }
  if (!parts.length) return null;
  return parts.length === 1 ? parts[0] : {[Op.and]: parts};
}

export async function buildLevelRequestSearchWhere(
  groups: SearchGroup[],
  mine: boolean,
): Promise<WhereOptions | null> {
  if (!groups.length) return null;
  const groupWheres: WhereOptions[] = [];
  for (const group of groups) {
    const part = await whereForGroup(group.terms, mine);
    if (part == null) return null;
    groupWheres.push(part);
  }
  const useful = groupWheres.filter((part) => part !== MATCH_NONE);
  if (!useful.length) return MATCH_NONE;
  if (useful.length === 1) return useful[0];
  return {[Op.or]: useful};
}

export async function levelRequestSearchFromQuery(
  query: string,
  mine: boolean,
): Promise<{groups: SearchGroup[]; where: WhereOptions | null}> {
  const groups = parseLevelRequestSearchQuery(query);
  return {
    groups,
    where: await buildLevelRequestSearchWhere(groups, mine),
  };
}

export {parseLevelRequestSearchQuery, requestSearchHasStatusField};
