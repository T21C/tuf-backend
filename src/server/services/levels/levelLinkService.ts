import type {Transaction} from 'sequelize';
import {getSequelizeForModelGroup} from '@/config/db.js';
import Level from '@/models/levels/Level.js';
import Difficulty from '@/models/levels/Difficulty.js';
import LevelLinkGroup from '@/models/levels/LevelLinkGroup.js';
import LevelLinkMember from '@/models/levels/LevelLinkMember.js';

const sequelize = getSequelizeForModelGroup('levels');

export class LevelLinkError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = 'LevelLinkError';
    this.statusCode = statusCode;
  }
}

export type LinkedLevelDto = {
  id: number;
  song: string;
  artist: string;
  suffix: string | null;
  diffId: number;
  isDeleted: boolean;
  isHidden: boolean;
  difficulty: {
    id: number;
    name: string;
    icon: string;
    color: string;
    type: string;
  } | null;
};

export type LinkedLevelsResult = {
  groupId: number | null;
  levels: LinkedLevelDto[];
};

function serializeLinkedLevel(level: Level): LinkedLevelDto {
  const diff = level.difficulty;
  return {
    id: level.id,
    song: level.song,
    artist: level.artist,
    suffix: level.suffix ?? null,
    diffId: level.diffId,
    isDeleted: Boolean(level.isDeleted),
    isHidden: Boolean(level.isHidden),
    difficulty: diff
      ? {
          id: diff.id,
          name: diff.name,
          icon: diff.icon,
          color: diff.color,
          type: diff.type,
        }
      : null,
  };
}

async function withTransaction<T>(
  existing: Transaction | undefined,
  fn: (transaction: Transaction) => Promise<T>,
): Promise<T> {
  if (existing) {
    return fn(existing);
  }
  return sequelize.transaction(fn);
}

async function loadLinkedLevelDtos(
  levelIds: number[],
  options: {includeHidden: boolean; transaction?: Transaction},
): Promise<LinkedLevelDto[]> {
  if (levelIds.length === 0) {
    return [];
  }

  const levels = await Level.findAll({
    where: {id: levelIds},
    attributes: ['id', 'song', 'artist', 'suffix', 'diffId', 'isDeleted', 'isHidden'],
    include: [
      {
        model: Difficulty,
        as: 'difficulty',
        attributes: ['id', 'name', 'icon', 'color', 'type'],
        required: false,
      },
    ],
    order: [['id', 'ASC']],
    transaction: options.transaction,
  });

  return levels
    .filter((level) => {
      if (options.includeHidden) {
        return true;
      }
      return !level.isDeleted && !level.isHidden;
    })
    .map(serializeLinkedLevel);
}

export async function getLinkedLevels(
  levelId: number,
  options: {includeHidden: boolean} = {includeHidden: false},
): Promise<LinkedLevelsResult> {
  const member = await LevelLinkMember.findOne({where: {levelId}});
  if (!member) {
    return {groupId: null, levels: []};
  }

  const members = await LevelLinkMember.findAll({
    where: {groupId: member.groupId},
    attributes: ['levelId'],
  });
  const levelIds = members.map((row) => row.levelId);
  const levels = await loadLinkedLevelDtos(levelIds, {
    includeHidden: options.includeHidden,
  });

  if (levels.length < 2) {
    return {groupId: null, levels: []};
  }

  return {groupId: member.groupId, levels};
}

export async function addLink(
  anchorLevelId: number,
  otherLevelId: number,
  existingTransaction?: Transaction,
): Promise<{groupId: number; merged: boolean; affectedLevelIds: number[]}> {
  if (anchorLevelId === otherLevelId) {
    throw new LevelLinkError('Cannot link a level to itself', 400);
  }

  return withTransaction(existingTransaction, async (transaction) => {
    const [anchor, other] = await Promise.all([
      Level.findByPk(anchorLevelId, {attributes: ['id'], transaction}),
      Level.findByPk(otherLevelId, {attributes: ['id'], transaction}),
    ]);
    if (!anchor || !other) {
      throw new LevelLinkError('Level not found', 404);
    }

    const [anchorMember, otherMember] = await Promise.all([
      LevelLinkMember.findOne({where: {levelId: anchorLevelId}, transaction}),
      LevelLinkMember.findOne({where: {levelId: otherLevelId}, transaction}),
    ]);

    const affectedLevelIds = new Set<number>([anchorLevelId, otherLevelId]);

    if (!anchorMember && !otherMember) {
      const group = await LevelLinkGroup.create({}, {transaction});
      await LevelLinkMember.bulkCreate(
        [
          {groupId: group.id, levelId: anchorLevelId},
          {groupId: group.id, levelId: otherLevelId},
        ],
        {transaction},
      );
      return {groupId: group.id, merged: false, affectedLevelIds: [...affectedLevelIds]};
    }

    if (anchorMember && otherMember) {
      if (anchorMember.groupId === otherMember.groupId) {
        return {
          groupId: anchorMember.groupId,
          merged: false,
          affectedLevelIds: [...affectedLevelIds],
        };
      }

      const [anchorMembers, otherMembers] = await Promise.all([
        LevelLinkMember.findAll({where: {groupId: anchorMember.groupId}, transaction}),
        LevelLinkMember.findAll({where: {groupId: otherMember.groupId}, transaction}),
      ]);
      for (const row of anchorMembers) affectedLevelIds.add(row.levelId);
      for (const row of otherMembers) affectedLevelIds.add(row.levelId);

      const oldGroupId = otherMember.groupId;
      await LevelLinkMember.update(
        {groupId: anchorMember.groupId},
        {where: {groupId: oldGroupId}, transaction},
      );
      await LevelLinkGroup.destroy({where: {id: oldGroupId}, transaction});
      return {
        groupId: anchorMember.groupId,
        merged: true,
        affectedLevelIds: [...affectedLevelIds],
      };
    }

    const existing = (anchorMember ?? otherMember)!;
    const newLevelId = anchorMember ? otherLevelId : anchorLevelId;
    await LevelLinkMember.create(
      {groupId: existing.groupId, levelId: newLevelId},
      {transaction},
    );
    const allMembers = await LevelLinkMember.findAll({
      where: {groupId: existing.groupId},
      transaction,
    });
    for (const row of allMembers) affectedLevelIds.add(row.levelId);
    return {
      groupId: existing.groupId,
      merged: false,
      affectedLevelIds: [...affectedLevelIds],
    };
  });
}

export async function removeMember(
  anchorLevelId: number,
  memberLevelId: number,
  existingTransaction?: Transaction,
): Promise<{affectedLevelIds: number[]}> {
  return withTransaction(existingTransaction, async (transaction) => {
    const anchorMember = await LevelLinkMember.findOne({
      where: {levelId: anchorLevelId},
      transaction,
    });
    if (!anchorMember) {
      throw new LevelLinkError('Level is not in a link group', 404);
    }

    const member = await LevelLinkMember.findOne({
      where: {levelId: memberLevelId, groupId: anchorMember.groupId},
      transaction,
    });
    if (!member) {
      throw new LevelLinkError('Level is not in this link group', 404);
    }

    const allMembers = await LevelLinkMember.findAll({
      where: {groupId: anchorMember.groupId},
      transaction,
    });
    const affectedLevelIds = allMembers.map((row) => row.levelId);

    await member.destroy({transaction});

    if (allMembers.length - 1 < 2) {
      await LevelLinkMember.destroy({
        where: {groupId: anchorMember.groupId},
        transaction,
      });
      await LevelLinkGroup.destroy({
        where: {id: anchorMember.groupId},
        transaction,
      });
    }

    return {affectedLevelIds};
  });
}

export async function unlinkLevelForDelete(
  levelId: number,
  transaction: Transaction,
): Promise<{affectedLevelIds: number[]}> {
  const member = await LevelLinkMember.findOne({where: {levelId}, transaction});
  if (!member) {
    return {affectedLevelIds: []};
  }
  return removeMember(levelId, levelId, transaction);
}
