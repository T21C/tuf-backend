import UserYoutubeChannelCredential from '@/models/auth/UserYoutubeChannelCredential.js';
import {decodeAes256GcmKey, encryptSecret, decryptSecret} from '@/misc/utils/crypto/secretBox.js';
import {logger} from '@/server/services/core/LoggerService.js';

let warnedAboutKey = false;

function encryptionKey(): Buffer | null {
  const raw = process.env.YOUTUBE_TOKEN_ENCRYPTION_KEY;
  if (typeof raw !== 'string' || !raw.trim()) {
    if (!warnedAboutKey) {
      warnedAboutKey = true;
      logger.warn('youtube_token_encryption_key_missing');
    }
    return null;
  }
  const key = decodeAes256GcmKey(raw);
  if (!key) {
    if (!warnedAboutKey) {
      warnedAboutKey = true;
      logger.warn('youtube_token_encryption_key_invalid');
    }
    return null;
  }
  return key;
}

/** Persist a refresh token. Returns false when encryption is not configured. */
export async function saveYoutubeRefreshToken(
  channelRowId: number,
  refreshToken: string,
): Promise<boolean> {
  const token = refreshToken.trim();
  if (!token) return false;
  const key = encryptionKey();
  if (!key) return false;
  const encrypted = encryptSecret(token, key);
  const now = new Date();
  const existing = await UserYoutubeChannelCredential.findByPk(channelRowId);
  if (existing) {
    await existing.update({refreshToken: encrypted, updatedAt: now});
  } else {
    await UserYoutubeChannelCredential.create({
      userYoutubeChannelId: channelRowId,
      refreshToken: encrypted,
      createdAt: now,
      updatedAt: now,
    });
  }
  return true;
}

export async function readYoutubeRefreshToken(channelRowId: number): Promise<string | null> {
  const row = await UserYoutubeChannelCredential.findByPk(channelRowId);
  if (!row?.refreshToken) return null;
  const key = encryptionKey();
  if (!key) return null;
  try {
    return decryptSecret(row.refreshToken, key);
  } catch {
    logger.warn('youtube_refresh_token_decrypt_failed', {channelRowId});
    return null;
  }
}

export async function clearYoutubeRefreshToken(channelRowId: number): Promise<void> {
  await UserYoutubeChannelCredential.destroy({where: {userYoutubeChannelId: channelRowId}});
}

export async function youtubeChannelIdsWithCredentials(channelRowIds: number[]): Promise<Set<number>> {
  const ids = [...new Set(channelRowIds.filter((id) => Number.isFinite(id)))];
  if (ids.length === 0) return new Set();
  const rows = await UserYoutubeChannelCredential.findAll({
    where: {userYoutubeChannelId: ids},
    attributes: ['userYoutubeChannelId'],
  });
  return new Set(rows.map((row) => row.userYoutubeChannelId));
}
