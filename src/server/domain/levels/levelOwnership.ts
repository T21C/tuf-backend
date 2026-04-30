import { Transaction } from 'sequelize';
import { permissionFlags } from '@/config/constants.js';
import { hasFlag } from '@/misc/utils/auth/permissionUtils.js';
import LevelCredit, { CreditRole } from '@/models/levels/LevelCredit.js';

export interface OwnershipCheckResult {
  canEdit: boolean;
  errorMessage?: string;
}

export const checkLevelOwnership = async (
  levelId: number,
  user: any,
  transaction: Transaction,
): Promise<OwnershipCheckResult> => {
  const isSuperAdmin = user && hasFlag(user, permissionFlags.SUPER_ADMIN);
  let isCreator = false;
  let charterCount = 0;
  let isOwner = false;

  if (!isSuperAdmin && user?.creatorId) {
    const levelCredits = await LevelCredit.findAll({
      where: { levelId },
      transaction,
    });

    charterCount = levelCredits.filter(
      (credit) => credit.role?.toLowerCase() === CreditRole.CHARTER,
    ).length;

    isCreator = levelCredits.some(
      (credit) =>
        credit.creatorId === user.creatorId && credit.role?.toLowerCase() === CreditRole.CHARTER,
    );

    isOwner = levelCredits.some((credit) => credit.creatorId === user.creatorId && credit.isOwner);
  }

  let canEdit = false;
  let errorMessage: string | undefined;
  if (isSuperAdmin || isOwner) {
    canEdit = true;
  } else if (isCreator && charterCount <= 2) {
    canEdit = true;
  } else if (isCreator && charterCount > 2) {
    canEdit = false;
    errorMessage =
      '(>2 CHARTERS) You must be the owner of this level to edit it. Contact admins if you believe that you should be the owner.';
  } else {
    canEdit = false;
    errorMessage = 'You are not authorized to edit this level';
  }
  return { canEdit, errorMessage };
};
