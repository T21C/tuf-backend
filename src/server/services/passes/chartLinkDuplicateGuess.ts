import {Op, type Transaction} from 'sequelize';
import Pass from '@/models/passes/Pass.js';
import LevelLinkMember from '@/models/levels/LevelLinkMember.js';
import ElasticsearchService from '@/server/services/elasticsearch/ElasticsearchService.js';
import {logger} from '@/server/services/core/LoggerService.js';
import {guessChartLinkDuplicatePasses} from '@/misc/utils/pass/chartLinkDuplicateGuess.js';

export type ChartLinkDuplicateApplyResult = {
  markNewPass: boolean;
  markedPassIds: number[];
};

async function loadChartSubgroupLevelIds(levelId: number): Promise<number[]> {
  const member = await LevelLinkMember.findOne({
    where: {levelId},
    attributes: ['groupId', 'chartSubgroup'],
  });
  if (!member || member.chartSubgroup == null) return [];

  const members = await LevelLinkMember.findAll({
    where: {
      groupId: member.groupId,
      chartSubgroup: member.chartSubgroup,
    },
    attributes: ['levelId'],
  });
  return members.map((row) => row.levelId);
}

export async function applyChartLinkDuplicateGuess(params: {
  playerId: number;
  levelId: number;
  scoreV2: number;
  transaction: Transaction;
}): Promise<ChartLinkDuplicateApplyResult> {
  const poolLevelIds = await loadChartSubgroupLevelIds(params.levelId);
  if (poolLevelIds.length < 2) {
    return {markNewPass: false, markedPassIds: []};
  }

  const existing = await Pass.findAll({
    where: {
      playerId: params.playerId,
      levelId: {[Op.in]: poolLevelIds},
    },
    attributes: ['id', 'levelId', 'scoreV2', 'isDuplicate', 'isDuplicateOverridden', 'isDeleted', 'isHidden'],
    transaction: params.transaction,
  });

  const guess = guessChartLinkDuplicatePasses([
    {
      id: null,
      levelId: params.levelId,
      scoreV2: params.scoreV2,
      isDuplicate: false,
      isDuplicateOverridden: false,
    },
    ...existing
      .filter((row) => !row.isDeleted && !row.isHidden)
      .map((row) => ({
        id: row.id,
        levelId: row.levelId,
        scoreV2: row.scoreV2,
        isDuplicate: Boolean(row.isDuplicate),
        isDuplicateOverridden: Boolean(row.isDuplicateOverridden),
      })),
  ]);

  if (guess.existingPassIds.length > 0) {
    await Pass.update(
      {isDuplicate: true},
      {
        where: {id: {[Op.in]: guess.existingPassIds}},
        transaction: params.transaction,
      },
    );
  }

  return {markNewPass: guess.markNewPass, markedPassIds: guess.existingPassIds};
}

export async function reindexChartLinkDuplicateChanges(
  playerId: number | null,
  passIds: number[],
): Promise<void> {
  const elasticsearchService = ElasticsearchService.getInstance();
  const uniquePassIds = [...new Set(passIds)].filter((id) => Number.isFinite(id) && id > 0);
  try {
    if (uniquePassIds.length > 0) {
      await elasticsearchService.reindexPasses(uniquePassIds);
    }
    if (playerId != null && playerId > 0) {
      await elasticsearchService.reindexPlayers([playerId]);
    }
  } catch (error) {
    logger.warn('Failed to reindex after chart-link duplicate guess', {
      playerId,
      passIds: uniquePassIds,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
