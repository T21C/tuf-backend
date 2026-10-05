import dotenv from 'dotenv';
import {randomBytes} from 'node:crypto';
dotenv.config();

async function main() {
  if (process.env.NODE_ENV !== 'development' || process.env.DB_HOST !== '127.0.0.1'
    || process.env.DB_DATABASE !== 'tuf_web_test') throw new Error('Local test database required');
  await import('@/models/index.js');
  const {default: Mod} = await import('@/models/misc/Mod.js');
  const {recordUniqueModDownload} = await import('@/server/services/mods/modDownloads.js');
  const mod = await Mod.findOne({where: {slug: 'zip-case-matrix-15'}});
  if (!mod) throw new Error('Seed ZIP cases first');
  const before = mod.downloadCount;
  const ip = `2001:db8:${randomBytes(8).toString('hex').match(/.{4}/g)!.join(':')}`;
  const results = await Promise.all(Array.from({length: 24}, () => recordUniqueModDownload({modId: mod.id, ip})));
  await mod.reload();
  const counted = results.filter(result => result.counted).length;
  if (counted !== 1 || mod.downloadCount !== before + 1) throw new Error('Concurrent download deduplication failed');
  console.log(JSON.stringify({requests: results.length, counted, increment: mod.downloadCount - before}));
  process.exit(0);
}
main().catch(error => {console.error((error as Error).message); process.exit(1);});
