import dotenv from 'dotenv';
import {randomBytes, randomUUID} from 'node:crypto';
dotenv.config();

async function main() {
  if (process.env.NODE_ENV !== 'development' || process.env.DB_HOST !== '127.0.0.1'
    || process.env.DB_DATABASE !== 'tuf_web_test') throw new Error('Local test database required');
  await import('@/models/index.js');
  const {default: User} = await import('@/models/auth/User.js');
  const {default: Player} = await import('@/models/players/Player.js');
  const {default: Mod} = await import('@/models/misc/Mod.js');
  const {assignUserToMods} = await import('@/server/services/mods/modAssign.js');
  const {passwordUtils} = await import('@/misc/utils/auth/auth.js');
  const username = 'modziptest';
  if (await User.findOne({where: {username}})) throw new Error('Test username already exists; keep its credentials');
  const mod = await Mod.findOne({where: {slug: 'mod-zip-url-test'}});
  if (!mod) throw new Error('Seed the test mod first');
  const password = `TufZip!${randomBytes(9).toString('base64url')}`;
  const player = await Player.create({name: username, country: 'XX', isBanned: false, isSubmissionsPaused: false});
  const now = new Date();
  const user = await User.create({
    id: randomUUID(), username, email: null, pendingEmail: null,
    password: await passwordUtils.hashPassword(password),
    playerId: player.id, isEmailVerified: false, isRater: false, isSuperAdmin: false,
    isRatingBanned: false, isTagVoteBanned: false, status: 'active',
    permissionFlags: 0, permissionVersion: 1, createdAt: now, updatedAt: now,
  });
  const result = await assignUserToMods({modId: mod.id, playerId: player.id, applyToSameCreator: false});
  if (!result.ok) throw new Error(result.error);
  console.log(JSON.stringify({username, password, userId: user.id, modId: mod.id, assignedModCount: result.assignedModCount}));
  process.exit(0);
}
main().catch((error) => {console.error((error as Error).message); process.exit(1);});
