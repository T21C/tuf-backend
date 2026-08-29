import ElasticsearchService from '@/server/services/elasticsearch/ElasticsearchService.js';

export async function indexCatalogMod(modId: number): Promise<void> {
  await ElasticsearchService.getInstance().indexMod(modId);
}

export async function indexCatalogMods(modIds: number[]): Promise<void> {
  await ElasticsearchService.getInstance().reindexMods(modIds);
}

export async function deleteCatalogMod(modId: number): Promise<void> {
  await ElasticsearchService.getInstance().deleteMod(modId);
}
