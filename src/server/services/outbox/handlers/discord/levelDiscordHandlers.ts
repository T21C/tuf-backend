import Level from '@/models/levels/Level.js';
import Difficulty from '@/models/levels/Difficulty.js';
import { Webhook, MessageBuilder } from '@/misc/webhook/index.js';
import { clientUrlEnv } from '@/config/app.config.js';
import type {
  DiscordLevelFileDeletedPayload,
  DiscordLevelFileUpdatedPayload,
  DiscordLevelFileUploadedPayload,
  DiscordLevelMetadataChangedPayload,
  DiscordLevelTargetUpdatedPayload,
} from '@/server/services/outbox/events.js';

const botAvatar = process.env.BOT_AVATAR_URL || '';

async function loadLevelForEmbed(levelId: number): Promise<Level | null> {
  return Level.findByPk(levelId, { include: { model: Difficulty, as: 'difficulty' } });
}

export async function handleDiscordLevelFileUpdated(payload: DiscordLevelFileUpdatedPayload): Promise<void> {
  const hook = new Webhook(process.env.LEVEL_FILE_UPDATE_HOOK);
  hook.setUsername('Level Updates');
  hook.setAvatar(botAvatar);
  const level = await loadLevelForEmbed(payload.levelId);
  if (!level) throw new Error('Level not found when logging level file update hook');
  const embed = new MessageBuilder()
    .addEmbed()
    .setAuthor(
      payload.user.username,
      payload.user.avatarUrl || '',
      `${clientUrlEnv}/profile/${payload.user.playerId}`,
    )
    .setTitle('Level File Update')
    .setThumbnail(level.difficulty?.icon || '')
    .addField(
      `Level #${payload.levelId}`,
      `${level.song || 'Unknown Song'} — ${level.artist || 'Unknown Artist'}`,
      false,
    )
    .addField('Original Path', payload.originalPath, false)
    .addField('New Path', payload.newPath, false)
    .setURL(`${clientUrlEnv}/levels/${payload.levelId}`)
    .setColor('#99ff00')
    .setTimestamp();
  await hook.send(embed);
}

export async function handleDiscordLevelFileDeleted(payload: DiscordLevelFileDeletedPayload): Promise<void> {
  const hook = new Webhook(process.env.LEVEL_FILE_UPDATE_HOOK);
  hook.setUsername('Level Updates');
  hook.setAvatar(botAvatar);
  const level = await loadLevelForEmbed(payload.levelId);
  if (!level) throw new Error('Level not found when logging level file update hook');
  const embed = new MessageBuilder()
    .addEmbed()
    .setAuthor(
      payload.user.username,
      payload.user.avatarUrl || '',
      `${clientUrlEnv}/profile/${payload.user.playerId}`,
    )
    .setTitle('Level File Deleted')
    .setThumbnail(level.difficulty?.icon || '')
    .addField(
      `Level #${payload.levelId}`,
      `${level.song || 'Unknown Song'} — ${level.artist || 'Unknown Artist'}`,
      true,
    )
    .setTimestamp()
    .setURL(`${clientUrlEnv}/levels/${payload.levelId}`)
    .setColor('#990000');
  await hook.send(embed);
}

export async function handleDiscordLevelFileUploaded(payload: DiscordLevelFileUploadedPayload): Promise<void> {
  const hook = new Webhook(process.env.LEVEL_FILE_UPDATE_HOOK);
  hook.setUsername('Level Updates');
  hook.setAvatar(botAvatar);
  const level = await loadLevelForEmbed(payload.levelId);
  if (!level) throw new Error('Level not found when logging level file update hook');
  const embed = new MessageBuilder()
    .addEmbed()
    .setAuthor(
      payload.user.username,
      payload.user.avatarUrl || '',
      `${clientUrlEnv}/profile/${payload.user.playerId}`,
    )
    .setTitle('Level File Uploaded')
    .setThumbnail(level.difficulty?.icon || '')
    .addField(
      `Level #${payload.levelId}`,
      `${level.song || 'Unknown Song'} — ${level.artist || 'Unknown Artist'}`,
      true,
    )
    .addField('File Path', payload.filePath, false)
    .setURL(`${clientUrlEnv}/levels/${payload.levelId}`)
    .setTimestamp()
    .setColor('#00cc00');
  await hook.send(embed);
}

export async function handleDiscordLevelTargetUpdated(payload: DiscordLevelTargetUpdatedPayload): Promise<void> {
  const hook = new Webhook(process.env.LEVEL_FILE_UPDATE_HOOK);
  hook.setUsername('Level Updates');
  hook.setAvatar(botAvatar);
  const level = await loadLevelForEmbed(payload.levelId);
  if (!level) throw new Error('Level not found when logging level file update hook');
  const embed = new MessageBuilder()
    .addEmbed()
    .setAuthor(
      payload.user.username,
      payload.user.avatarUrl || '',
      `${clientUrlEnv}/profile/${payload.user.playerId}`,
    )
    .setTitle(`Level #${payload.levelId} - Target Updated`)
    .setThumbnail(level.difficulty?.icon || '')
    .addField(
      `Level #${payload.levelId}`,
      `${level.song || 'Unknown Song'} — ${level.artist || 'Unknown Artist'}`,
      true,
    )
    .addField('Target', payload.target, false)
    .setURL(`${clientUrlEnv}/levels/${payload.levelId}`)
    .setTimestamp()
    .setColor('#5555ff');
  await hook.send(embed);
}

function formatValue(value: string | null): string {
  return value || '(empty)';
}

export async function handleDiscordLevelMetadataChanged(payload: DiscordLevelMetadataChangedPayload): Promise<void> {
  const hook = new Webhook(process.env.LEVEL_FILE_UPDATE_HOOK);
  hook.setUsername('Level Updates');
  hook.setAvatar(botAvatar);

  const embed = new MessageBuilder()
    .addEmbed()
    .setAuthor(
      payload.user.username,
      payload.user.avatarUrl || '',
      `${clientUrlEnv}/profile/${payload.user.playerId}`,
    )
    .setTitle(`Level #${payload.levelId} - Info Changed`)
    .setThumbnail(payload.difficultyIcon || '')
    .setTimestamp()
    .setColor('#aaaaaa')
    .setURL(`${clientUrlEnv}/levels/${payload.levelId}`);

  const fieldLabels: Record<string, string> = {
    song: 'Song',
    artist: 'Artist',
    songId: 'Song ID',
    suffix: 'Suffix',
    videoLink: 'Video Link',
    dlLink: 'Download Link',
    workshopLink: 'Workshop Link',
  };

  let hasChanges = false;
  const oldM = payload.oldMetadata;
  const newM = payload.newMetadata;

  for (const [key, label] of Object.entries(fieldLabels)) {
    const oldValue = oldM[key as keyof typeof oldM];
    const newValue = newM[key as keyof typeof newM];

    if (key === 'songId') {
      const oldId = oldValue ?? null;
      const newId = newValue ?? null;
      if (oldId !== newId) {
        hasChanges = true;
        const changeText = `${oldId ?? '(empty)'} ➔ ${newId ?? '(empty)'}`;
        embed.addField(label, changeText, false);
      }
    } else {
      const oldVal = (oldValue as string) || '';
      const newVal = (newValue as string) || '';
      if (oldVal !== newVal) {
        hasChanges = true;
        const changeText = `${formatValue(oldVal)} ➔ ${formatValue(newVal)}`;
        embed.addField(label, changeText, false);
      }
    }
  }

  if (hasChanges) {
    await hook.send(embed);
  }
}
