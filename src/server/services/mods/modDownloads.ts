import {Op, type Transaction} from 'sequelize';
import Mod from '@/models/misc/Mod.js';
import ModDownloadUnique from '@/models/misc/ModDownloadUnique.js';
import {
  hashDownloadIp,
  pruneUniquesBeforeDate,
  utcDayDate,
} from './modDownloadCount.js';

export async function recordUniqueModDownload(options: {
  modId: number;
  ip: string;
  now?: Date;
  transaction?: Transaction;
}): Promise<{counted: boolean; downloadCount: number}> {
  const now = options.now ?? new Date();
  const ipHash = hashDownloadIp(options.ip);
  const dayDate = utcDayDate(now);
  const pruneBefore = pruneUniquesBeforeDate(now);

  await ModDownloadUnique.destroy({
    where: {dayDate: {[Op.lt]: pruneBefore}},
    transaction: options.transaction,
  });

  // MySQL findOrCreate opens implicit transactions whose gap locks can deadlock
  // when several platform links are requested for the same mod/IP/day.
  // Without an outer transaction, let the unique index arbitrate concurrent inserts.
  const findOrCreate = options.transaction
    ? ModDownloadUnique.findOrCreate.bind(ModDownloadUnique)
    : ModDownloadUnique.findCreateFind.bind(ModDownloadUnique);
  const [row, created] = await findOrCreate({
    where: {modId: options.modId, ipHash, dayDate},
    defaults: {modId: options.modId, ipHash, dayDate},
    transaction: options.transaction,
  });
  void row;

  if (created) {
    await Mod.increment('downloadCount', {
      by: 1,
      where: {id: options.modId},
      transaction: options.transaction,
    });
  }

  const mod = await Mod.findByPk(options.modId, {
    attributes: ['downloadCount'],
    transaction: options.transaction,
  });
  return {counted: created, downloadCount: mod?.downloadCount ?? 0};
}
