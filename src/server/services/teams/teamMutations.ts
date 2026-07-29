import {literal, Op, Transaction} from 'sequelize';
import type {Sequelize} from 'sequelize';
import Team from '@/models/credits/Team.js';
import {TeamAlias} from '@/models/credits/TeamAlias.js';
import TeamMember from '@/models/credits/TeamMember.js';
import Creator from '@/models/credits/Creator.js';
import Level from '@/models/levels/Level.js';
import LevelCredit from '@/models/levels/LevelCredit.js';
import {escapeForMySQL} from '@/misc/utils/data/searchHelpers.js';
import {mapMysqlClientError} from '@/misc/utils/db/mysqlClientError.js';
import {logger} from '@/server/services/core/LoggerService.js';
import {
  replaceTeamAliases,
  validateTeamAliasList,
  validateTeamName,
} from '@/server/services/teams/teamAliases.js';

export class TeamMutationError extends Error {
  constructor(
    public status: number,
    message: string,
    public extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'TeamMutationError';
  }
}

export type TeamMemberFlat = {id: number; name: string};

export type TeamFlat = {
  id: number;
  name: string;
  description: string | null;
  members: TeamMemberFlat[];
  aliases: string[];
  levels?: unknown[];
  type?: 'team';
};

function getSequelize(): Sequelize {
  const seq = Team.sequelize;
  if (!seq) {
    throw new Error('Team model sequelize is not initialized');
  }
  return seq;
}

/** Flat team shape shared by v3 and legacy v2 adapters. */
export function formatTeamFlat(
  team: Team,
  options?: {includeLevels?: boolean; type?: boolean},
): TeamFlat {
  const flat: TeamFlat = {
    id: team.id,
    name: team.name,
    description: team.description ?? null,
    members:
      team.teamCreators?.map(member => ({
        id: member.id,
        name: member.name,
      })) ?? [],
    aliases: (team.teamAliases?.map(alias => alias.name) ?? []).filter(Boolean),
  };
  if (options?.includeLevels) {
    flat.levels = team.levels ?? [];
  }
  if (options?.type) {
    flat.type = 'team';
  }
  return flat;
}

const teamListIncludes = [
  {
    model: Creator,
    as: 'teamCreators',
    through: {attributes: [] as string[]},
  },
  {
    model: TeamAlias,
    as: 'teamAliases',
    attributes: ['id', 'name'],
  },
];

export async function loadTeamFlat(
  teamId: number,
  options?: {includeLevels?: boolean; transaction?: Transaction},
): Promise<TeamFlat | null> {
  const include: object[] = [...teamListIncludes];
  if (options?.includeLevels) {
    include.push({
      model: Level,
      as: 'levels',
      include: [
        {
          model: LevelCredit,
          as: 'levelCredits',
          include: [{model: Creator, as: 'creator'}],
        },
      ],
    });
  }
  const team = await Team.findByPk(teamId, {
    include,
    transaction: options?.transaction,
  });
  if (!team) return null;
  return formatTeamFlat(team, {
    includeLevels: options?.includeLevels,
  });
}

async function resolveMatchingTeamIds(search: string): Promise<number[]> {
  const escaped = escapeForMySQL(search.trim());
  const teamIds = new Set<number>();

  const byName = await Team.findAll({
    where: {name: {[Op.like]: `%${escaped}%`}},
    attributes: ['id'],
  });
  for (const team of byName) {
    teamIds.add(team.id);
  }

  const byAlias = await TeamAlias.findAll({
    where: {name: {[Op.like]: `%${escaped}%`}},
    attributes: ['teamId'],
  });
  for (const alias of byAlias) {
    teamIds.add(alias.teamId);
  }

  return Array.from(teamIds);
}

export async function searchTeams(options: {
  query?: string;
  limit?: number;
  offset?: number;
}): Promise<{total: number; results: TeamFlat[]}> {
  const limit = options.limit ?? 30;
  const offset = options.offset ?? 0;
  const query = options.query?.trim() ?? '';

  let where: Record<string | symbol, unknown> | undefined;
  if (query.length > 0) {
    const ids = await resolveMatchingTeamIds(query);
    if (ids.length === 0) {
      return {total: 0, results: []};
    }
    where = {id: {[Op.in]: ids}};
  }

  const {rows, count} = await Team.findAndCountAll({
    where,
    include: teamListIncludes,
    order: [['name', 'ASC']],
    limit,
    offset,
    distinct: true,
  });

  return {
    total: count,
    results: rows.map(team => formatTeamFlat(team)),
  };
}

/** Legacy list without pagination (v2 GET /teams). */
export async function listTeams(search?: string): Promise<TeamFlat[]> {
  let where: Record<string | symbol, unknown> | undefined;
  if (search && search.trim().length > 0) {
    const ids = await resolveMatchingTeamIds(search);
    if (ids.length === 0) return [];
    where = {id: {[Op.in]: ids}};
  }

  const teams = await Team.findAll({
    where,
    include: teamListIncludes,
    order: [['name', 'ASC']],
  });
  return teams.map(team => formatTeamFlat(team));
}

export async function createTeam(
  input: {name: unknown; description?: unknown; aliases?: unknown},
  transaction: Transaction,
): Promise<TeamFlat> {
  const sequelize = getSequelize();
  const nameResult = await validateTeamName(sequelize, null, input.name, transaction);
  if (!nameResult.ok) {
    throw new TeamMutationError(400, nameResult.error);
  }

  let aliasNames: string[] = [];
  if (input.aliases !== undefined) {
    const aliasResult = await validateTeamAliasList(
      sequelize,
      null,
      nameResult.name,
      input.aliases,
      transaction,
    );
    if (!aliasResult.ok) {
      throw new TeamMutationError(400, aliasResult.error);
    }
    aliasNames = aliasResult.names;
  }

  const description =
    input.description === undefined || input.description === null || input.description === ''
      ? null
      : String(input.description).trim();

  let team: Team;
  try {
    team = await Team.create(
      {
        name: nameResult.name,
        description: description ?? undefined,
      },
      {transaction},
    );
  } catch (error) {
    if (mapMysqlClientError(error)?.code === 'ER_DUP_ENTRY') {
      throw new TeamMutationError(400, `A team with the name "${nameResult.name}" already exists`);
    }
    throw error;
  }

  await replaceTeamAliases(team.id, aliasNames, transaction);

  const flat = await loadTeamFlat(team.id, {transaction});
  if (!flat) {
    throw new TeamMutationError(500, 'Failed to fetch created team');
  }
  return flat;
}

export async function updateTeam(
  teamId: number,
  input: {name?: unknown; description?: unknown; aliases?: unknown},
  transaction: Transaction,
): Promise<TeamFlat> {
  const sequelize = getSequelize();
  const team = await Team.findByPk(teamId, {transaction});
  if (!team) {
    throw new TeamMutationError(404, 'Team not found');
  }

  if (input.name !== undefined) {
    const nameResult = await validateTeamName(sequelize, teamId, input.name, transaction);
    if (!nameResult.ok) {
      throw new TeamMutationError(400, nameResult.error);
    }
    team.name = nameResult.name;
  }

  if (input.description !== undefined) {
    team.description =
      input.description === null || input.description === ''
        ? undefined
        : String(input.description).trim();
  }

  await team.save({transaction});

  if (input.aliases !== undefined) {
    const aliasResult = await validateTeamAliasList(
      sequelize,
      teamId,
      team.name,
      input.aliases,
      transaction,
    );
    if (!aliasResult.ok) {
      throw new TeamMutationError(400, aliasResult.error);
    }
    await replaceTeamAliases(teamId, aliasResult.names, transaction);
  }

  const flat = await loadTeamFlat(teamId, {transaction});
  if (!flat) {
    throw new TeamMutationError(500, 'Failed to fetch updated team');
  }
  return flat;
}

export async function deleteTeam(teamId: number, transaction: Transaction): Promise<void> {
  const team = await Team.findByPk(teamId, {transaction});
  if (!team) {
    throw new TeamMutationError(404, 'Team not found');
  }

  const levelCount = await Level.count({where: {teamId}, transaction});
  if (levelCount > 0) {
    throw new TeamMutationError(400, `Cannot delete team: assigned to ${levelCount} level(s)`, {
      levelCount,
    });
  }

  await TeamMember.destroy({where: {teamId}, transaction});
  await TeamAlias.destroy({where: {teamId}, transaction});
  await team.destroy({transaction});
}

/**
 * Resolve a team by case-insensitive name or alias; create if free.
 * Replaces unsafe Team.findOrCreate({ where: { name } }) in submissions.
 */
export async function resolveOrCreateTeamByName(
  rawName: string,
  transaction: Transaction,
): Promise<Team> {
  const sequelize = getSequelize();
  const trimmed = rawName.trim();
  if (trimmed.length === 0) {
    throw new TeamMutationError(400, 'Team name is required');
  }

  const lowerEq = literal(`LOWER(name) = LOWER(${sequelize.escape(trimmed)})`);

  const existingByName = await Team.findOne({
    where: {[Op.and]: lowerEq},
    transaction,
  });
  if (existingByName) {
    return existingByName;
  }

  const existingAlias = await TeamAlias.findOne({
    where: {[Op.and]: lowerEq},
    transaction,
  });
  if (existingAlias) {
    const team = await Team.findByPk(existingAlias.teamId, {transaction});
    if (team) return team;
  }

  const nameResult = await validateTeamName(sequelize, null, trimmed, transaction);
  if (!nameResult.ok) {
    throw new TeamMutationError(400, nameResult.error);
  }

  try {
    return await Team.create({name: nameResult.name}, {transaction});
  } catch (error) {
    if (mapMysqlClientError(error)?.code === 'ER_DUP_ENTRY') {
      const raced = await Team.findOne({
        where: {[Op.and]: lowerEq},
        transaction,
      });
      if (raced) return raced;
      throw new TeamMutationError(400, `A team with the name "${trimmed}" already exists`);
    }
    throw error;
  }
}

async function syncTeamMembers(
  teamId: number,
  members: unknown,
  transaction: Transaction,
): Promise<void> {
  if (members === undefined) return;

  const memberIds = Array.isArray(members)
    ? members.filter((id): id is number => typeof id === 'number')
    : [];
  const uniqueMembers = [...new Set(memberIds)];

  const teamLevels = await Level.findAll({
    where: {teamId},
    transaction,
  });

  const levelCreators = await Promise.all(
    teamLevels.map(async level => {
      const credits = await LevelCredit.findAll({
        where: {levelId: level.id},
        transaction,
      });
      return credits.map(credit => credit.creatorId);
    }),
  );

  const allTeamCreators = [...new Set(levelCreators.flat())];
  const creatorsToRemove = allTeamCreators.filter(
    (creatorId: number) => !uniqueMembers.includes(creatorId),
  );

  if (creatorsToRemove.length > 0) {
    await TeamMember.destroy({
      where: {
        teamId,
        creatorId: {[Op.in]: creatorsToRemove},
      },
      transaction,
    });
  }

  const existingMembers = await TeamMember.findAll({
    where: {teamId},
    transaction,
  });
  const existingCreatorIds = existingMembers.map(member => member.creatorId);
  const newCreatorIds = uniqueMembers.filter(
    (creatorId: number) => !existingCreatorIds.includes(creatorId),
  );

  for (const creatorId of newCreatorIds) {
    try {
      await TeamMember.create({teamId, creatorId}, {transaction});
    } catch (error) {
      if (mapMysqlClientError(error)?.code === 'ER_DUP_ENTRY') {
        logger.debug(`Team member ${creatorId} already exists for team ${teamId}`);
        continue;
      }
      throw error;
    }
  }
}

/**
 * Assign a team to a level. Creates a team by name when teamId is omitted.
 * When neither teamId nor name is provided, clears the association (legacy PUT behavior).
 */
export async function setLevelTeam(
  levelId: number,
  input: {teamId?: unknown; name?: unknown; members?: unknown},
  transaction: Transaction,
): Promise<TeamFlat | null> {
  const level = await Level.findByPk(levelId, {transaction});
  if (!level) {
    throw new TeamMutationError(404, 'Level not found');
  }

  const hasName = typeof input.name === 'string' && input.name.trim().length > 0;
  const teamIdRaw = input.teamId;
  const hasTeamId =
    (typeof teamIdRaw === 'number' && Number.isFinite(teamIdRaw)) ||
    (typeof teamIdRaw === 'string' && /^\d+$/.test(teamIdRaw));

  if (!hasName && !hasTeamId) {
    await level.update({teamId: null}, {transaction});
    return null;
  }

  let team: Team | null = null;

  if (hasTeamId) {
    const id = typeof teamIdRaw === 'number' ? teamIdRaw : parseInt(String(teamIdRaw), 10);
    team = await Team.findByPk(id, {transaction});
    if (!team) {
      throw new TeamMutationError(404, 'Team not found');
    }
  } else if (hasName) {
    team = await resolveOrCreateTeamByName(String(input.name), transaction);
  }

  if (!team) {
    throw new TeamMutationError(500, 'Failed to create/update team');
  }

  await level.update({teamId: team.id}, {transaction});
  await syncTeamMembers(team.id, input.members, transaction);

  const flat = await loadTeamFlat(team.id, {transaction});
  if (!flat) {
    throw new TeamMutationError(500, 'Failed to fetch created team');
  }
  return flat;
}

/**
 * Remove team association from a level. If the team is unused elsewhere, destroy it
 * (including aliases and members).
 */
export async function clearLevelTeam(
  levelId: number,
  transaction: Transaction,
): Promise<{deletedTeamId: number | null}> {
  const level = await Level.findByPk(levelId, {transaction});
  if (!level) {
    throw new TeamMutationError(404, 'Level not found');
  }

  let deletedTeamId: number | null = null;
  const previousTeamId = level.teamId ?? null;

  if (previousTeamId != null) {
    const otherLevels = await Level.count({
      where: {
        teamId: previousTeamId,
        id: {[Op.ne]: levelId},
      },
      transaction,
    });

    if (otherLevels === 0) {
      await TeamMember.destroy({where: {teamId: previousTeamId}, transaction});
      await TeamAlias.destroy({where: {teamId: previousTeamId}, transaction});
      await Team.destroy({where: {id: previousTeamId}, transaction});
      deletedTeamId = previousTeamId;
    }
  }

  await level.update({teamId: null}, {transaction});
  return {deletedTeamId};
}
