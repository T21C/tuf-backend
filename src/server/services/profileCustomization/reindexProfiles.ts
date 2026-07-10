import ElasticsearchService from '@/server/services/elasticsearch/ElasticsearchService.js';
import type ProfileCustomizationPiece from '@/models/profile/ProfileCustomizationPiece.js';
import { getReindexIdsFromPiece } from '@/server/services/profileCustomization/ProfileCustomizationService.js';

const elasticsearchService = ElasticsearchService.getInstance();

export async function reindexProfilesForPiece(piece: ProfileCustomizationPiece): Promise<void> {
  const { playerIds, creatorIds } = getReindexIdsFromPiece(piece);
  if (playerIds.length) {
    await elasticsearchService.reindexPlayers(playerIds);
  }
  if (creatorIds.length) {
    await elasticsearchService.reindexCreators(creatorIds);
  }
}

export async function reindexProfilesForIds(params: {
  playerIds?: number[];
  creatorIds?: number[];
}): Promise<void> {
  const playerIds = params.playerIds?.filter((id) => Number.isFinite(id) && id > 0) ?? [];
  const creatorIds = params.creatorIds?.filter((id) => Number.isFinite(id) && id > 0) ?? [];
  if (playerIds.length) {
    await elasticsearchService.reindexPlayers(playerIds);
  }
  if (creatorIds.length) {
    await elasticsearchService.reindexCreators(creatorIds);
  }
}
