import {UniqueConstraintError} from 'sequelize';
import UserYoutubeChannel from '@/models/auth/UserYoutubeChannel.js';
import User from '@/models/auth/User.js';
import {isYoutubeChannelLinkingEnabled} from '@/config/app.config.js';
import {accountCredentialService} from '@/server/services/accounts/AccountCredentialService.js';
import {
  nextPrimaryChannelId,
  serializeYoutubeChannel,
  shouldBePrimaryOnInsert,
  youtubeLinkConflict,
  type YoutubeChannelPublic,
} from '@/misc/utils/data/youtubeChannel.js';

export class YoutubeChannelError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = 'YoutubeChannelError';
    this.status = status;
    this.code = code;
  }
}

export function isYoutubeChannelError(error: unknown): error is YoutubeChannelError {
  return error instanceof YoutubeChannelError;
}

export interface YoutubeChannelLinkInput {
  channelId: string;
  title?: string;
  handle?: string | null;
}

function assertLinkingEnabled(): void {
  if (!isYoutubeChannelLinkingEnabled()) {
    throw new YoutubeChannelError(
      'YouTube channel linking is temporarily unavailable',
      503,
      'YOUTUBE_CHANNEL_LINKING_DISABLED',
    );
  }
}

class YouTubeChannelService {
  async listPublic(userId: string): Promise<YoutubeChannelPublic[]> {
    const rows = await UserYoutubeChannel.findAll({
      where: {userId},
      order: [
        ['isPrimary', 'DESC'],
        ['createdAt', 'ASC'],
      ],
    });
    return rows.map((row) => serializeYoutubeChannel(row));
  }

  async listIdsByUserIds(userIds: string[]): Promise<Map<string, string[]>> {
    const map = new Map<string, string[]>();
    const unique = [...new Set(userIds.filter(Boolean))];
    if (unique.length === 0) return map;
    const rows = await UserYoutubeChannel.findAll({
      where: {userId: unique},
      attributes: ['userId', 'channelId'],
    });
    for (const row of rows) {
      const list = map.get(row.userId) ?? [];
      list.push(row.channelId);
      map.set(row.userId, list);
    }
    return map;
  }

  async listIdsByPlayerIds(playerIds: number[]): Promise<Map<number, string[]>> {
    const map = new Map<number, string[]>();
    const unique = [...new Set(playerIds.filter((id) => Number.isFinite(id) && id > 0))];
    if (unique.length === 0) return map;
    const users = await User.findAll({
      where: {playerId: unique},
      attributes: ['id', 'playerId'],
    });
    if (users.length === 0) return map;
    const byUser = await this.listIdsByUserIds(users.map((u) => u.id));
    for (const user of users) {
      if (user.playerId == null) continue;
      map.set(user.playerId, byUser.get(user.id) ?? []);
    }
    return map;
  }

  async link(userId: string, input: YoutubeChannelLinkInput): Promise<YoutubeChannelPublic> {
    assertLinkingEnabled();
    const channelId = input.channelId.trim();
    if (!channelId) {
      throw new YoutubeChannelError('YouTube channel id is required', 400, 'YOUTUBE_CHANNEL_REQUIRED');
    }
    const title = typeof input.title === 'string' ? input.title.trim() : '';
    const handle =
      typeof input.handle === 'string' && input.handle.trim() ? input.handle.trim() : null;

    const existing = await UserYoutubeChannel.findOne({where: {channelId}});
    const conflict = youtubeLinkConflict(existing, userId);
    if (conflict === 'already_linked_other') {
      throw new YoutubeChannelError(
        'This YouTube channel is already linked to another account',
        409,
        'YOUTUBE_CHANNEL_TAKEN',
      );
    }
    if (existing && conflict === 'already_linked_self') {
      await existing.update({
        title: title || existing.title,
        handle: handle ?? existing.handle,
      });
      return serializeYoutubeChannel(existing);
    }

    const count = await UserYoutubeChannel.count({where: {userId}});
    const isPrimary = shouldBePrimaryOnInsert(count);
    const now = new Date();
    try {
      const row = await UserYoutubeChannel.create({
        userId,
        channelId,
        title,
        handle,
        isPrimary,
        createdAt: now,
        updatedAt: now,
      });
      await accountCredentialService.logAction(userId, 'youtube_link', {channelId});
      return serializeYoutubeChannel(row);
    } catch (error) {
      if (error instanceof UniqueConstraintError) {
        throw new YoutubeChannelError(
          'This YouTube channel is already linked to another account',
          409,
          'YOUTUBE_CHANNEL_TAKEN',
        );
      }
      throw error;
    }
  }

  async setPrimary(userId: string, channelId: string): Promise<YoutubeChannelPublic[]> {
    assertLinkingEnabled();
    const row = await UserYoutubeChannel.findOne({where: {userId, channelId}});
    if (!row) {
      throw new YoutubeChannelError('YouTube channel is not linked', 404, 'YOUTUBE_CHANNEL_NOT_FOUND');
    }
    const others = await UserYoutubeChannel.findAll({
      where: {userId, isPrimary: true},
    });
    for (const other of others) {
      if (other.id !== row.id) {
        await other.update({isPrimary: false});
      }
    }
    if (!row.isPrimary) {
      await row.update({isPrimary: true});
    }
    return this.listPublic(userId);
  }

  async unlink(userId: string, channelId: string): Promise<YoutubeChannelPublic[]> {
    assertLinkingEnabled();
    const row = await UserYoutubeChannel.findOne({where: {userId, channelId}});
    if (!row) {
      throw new YoutubeChannelError('YouTube channel is not linked', 404, 'YOUTUBE_CHANNEL_NOT_FOUND');
    }
    const remaining = await UserYoutubeChannel.findAll({
      where: {userId},
    });
    const others = remaining.filter((r) => r.channelId !== channelId);
    const promoteId = nextPrimaryChannelId(
      {channelId: row.channelId, isPrimary: row.isPrimary},
      others.map((r) => ({channelId: r.channelId, createdAt: r.createdAt})),
    );
    await row.destroy();
    if (promoteId) {
      await UserYoutubeChannel.update(
        {isPrimary: true},
        {where: {userId, channelId: promoteId}},
      );
    }
    await accountCredentialService.logAction(userId, 'youtube_unlink', {channelId});
    return this.listPublic(userId);
  }
}

export const youtubeChannelService = new YouTubeChannelService();
export default youtubeChannelService;
