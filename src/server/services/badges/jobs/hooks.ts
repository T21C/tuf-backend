import LevelCredit from '@/models/levels/LevelCredit.js';
import LevelLinkMember from '@/models/levels/LevelLinkMember.js';
import LevelPackItem from '@/models/packs/LevelPackItem.js';
import LevelRerateHistory from '@/models/levels/LevelRerateHistory.js';
import type { Transaction } from 'sequelize';
import { signalBadgeDirt, signalLevelIdentityDirt } from './signals.js';

let registered = false;

function transactionOf(options: unknown): Transaction | null {
  const hook = options as { transaction?: Transaction | null } | undefined;
  return hook?.transaction ?? null;
}

export function registerBadgeHooks(): void {
  if (registered) return;
  registered = true;

  const onCredit = (credit: LevelCredit, options: unknown) => {
    const transaction = transactionOf(options);
    if (credit.creatorId) signalBadgeDirt({ creators: [Number(credit.creatorId)] }, transaction);
  };
  LevelCredit.addHook('afterCreate', onCredit);
  LevelCredit.addHook('afterDestroy', onCredit);
  LevelCredit.addHook('afterUpdate', onCredit);

  const onLink = (member: LevelLinkMember, options: unknown) => {
    if (!member.levelId) return;
    signalLevelIdentityDirt(Number(member.levelId), transactionOf(options));
  };
  LevelLinkMember.addHook('afterCreate', onLink);
  LevelLinkMember.addHook('afterDestroy', onLink);
  LevelLinkMember.addHook('afterUpdate', onLink);

  const onPack = (item: LevelPackItem, options: unknown) => {
    if (item.packId) signalBadgeDirt({ packs: [Number(item.packId)] }, transactionOf(options));
  };
  LevelPackItem.addHook('afterCreate', onPack);
  LevelPackItem.addHook('afterDestroy', onPack);
  LevelPackItem.addHook('afterUpdate', onPack);

  LevelRerateHistory.addHook('afterCreate', (row: LevelRerateHistory, options: unknown) => {
    if (row.levelId) signalBadgeDirt({ catalog: true }, transactionOf(options));
  });
}
