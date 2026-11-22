export { normalizeDefinition, type BadgeDraft } from './engine/params.js';
export {
  catalogDifficultyCoverage,
  ownerDifficultyCounts,
  prepareOwnerDifficultyCounts,
  type DifficultyCount,
  type DifficultyCoverageTable,
  type OwnerDifficultyCounts,
} from './engine/difficultyCoverage.js';
export { enqueueBadgeJob, enqueueBadgeDirt, signalBadgeJob, signalBadgeDirt } from './jobs/signals.js';
export {
  clampOwnerRange,
  ownerRangeFrom,
  parseOwnerBound,
  parseOwnerBounds,
  parseOwnerKind,
} from './jobs/owners.js';
export { definitionExpression, shouldEnqueueOnSave } from './jobs/definitionSave.js';
export { registerBadgeHooks } from './jobs/hooks.js';
export { startBadgeJobWorker, stopBadgeJobWorker } from './jobs/worker.js';
export { logBadgeFailure, snapshotMissingPasses } from './catalog/snapshot.js';
export { readOwnerBadges, saveOwnerEquips } from './present/read.js';
