import type {PlacementRewardAttributes} from '@/models/tournaments/PlacementReward.js';

export type RewardType = 'avatar_frame';

export interface RewardTypeHandler {
  rewardType: RewardType;
  label: string;
  sync?(reward: PlacementRewardAttributes): Promise<void>;
}

const handlers = new Map<RewardType, RewardTypeHandler>();

handlers.set('avatar_frame', {
  rewardType: 'avatar_frame',
  label: 'Avatar frame',
});

export function getRewardTypeHandler(rewardType: string): RewardTypeHandler | null {
  return handlers.get(rewardType as RewardType) ?? null;
}

export function listRewardTypeHandlers(): RewardTypeHandler[] {
  return [...handlers.values()];
}

export function registerRewardTypeHandler(handler: RewardTypeHandler): void {
  handlers.set(handler.rewardType, handler);
}
