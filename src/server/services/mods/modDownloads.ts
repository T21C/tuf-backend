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

  const [row, created] = await ModDownloadUnique.findOrCreate({
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
