import {Webhook, MessageBuilder} from '../../../misc/webhook/index.js';
import { User } from '../../../models/index.js';
import { clientUrlEnv } from '../../../config/app.config.js';
import Level from '../../../models/levels/Level.js';
import Difficulty from '../../../models/levels/Difficulty.js';

const botAvatar = process.env.BOT_AVATAR_URL || '';

async function logLevelFileUpdateHook(originalPath: string, newPath: string, levelId: number, user: User): Promise<void> {
    const hook = new Webhook(process.env.LEVEL_FILE_UPDATE_HOOK);
    hook.setUsername('Level Updates');
    hook.setAvatar(botAvatar);

    const level = await Level.findByPk(levelId, { include: {model: Difficulty, as: 'difficulty'} });
    if (!level) {
      throw new Error('Level not found when logging level file update hook');
    }

    const embed = new MessageBuilder()
    .addEmbed()
    .setAuthor(user.username, user.avatarUrl || '', `${clientUrlEnv}/profile/${user.playerId}`)
    .setTitle('Level File Update')
    .setThumbnail(level.difficulty?.icon || '')
    .addField(`Level #${levelId}`, `${level.song || 'Unknown Song'} — ${level.artist || 'Unknown Artist'}`, false)
    .addField('Original Path', originalPath, false)
    .addField('New Path', newPath, false)
    .setURL(`${clientUrlEnv}/levels/${levelId}`)
    .setColor('#99ff00')
    .setTimestamp();
    await hook.send(embed);
  }

async function logLevelFileDeleteHook(levelId: number, user: User): Promise<void> {
    const hook = new Webhook(process.env.LEVEL_FILE_UPDATE_HOOK);
    hook.setUsername('Level Updates');
    hook.setAvatar(botAvatar);

    const level = await Level.findByPk(levelId, { include: {model: Difficulty, as: 'difficulty'} });
    if (!level) {
      throw new Error('Level not found when logging level file update hook');
    }

    const embed = new MessageBuilder()
    .addEmbed()
    .setAuthor(user.username, user.avatarUrl || '', `${clientUrlEnv}/profile/${user.playerId}`)
    .setTitle('Level File Deleted')
    .setThumbnail(level.difficulty?.icon || '')
    .addField(`Level #${levelId}`, `${level.song || 'Unknown Song'} — ${level.artist || 'Unknown Artist'}`, true)
    .setTimestamp()
    .setURL(`${clientUrlEnv}/levels/${levelId}`)
    .setColor('#990000');
    await hook.send(embed);
  }

async function logLevelFileUploadHook(filePath: string, levelId: number, user: User): Promise<void> {
    const hook = new Webhook(process.env.LEVEL_FILE_UPDATE_HOOK);
    hook.setUsername('Level Updates');
    hook.setAvatar(botAvatar);
    const level = await Level.findByPk(levelId, { include: {model: Difficulty, as: 'difficulty'} });
    if (!level) {
      throw new Error('Level not found when logging level file update hook');
    }
    const embed = new MessageBuilder()
    .addEmbed()
    .setAuthor(user.username, user.avatarUrl || '', `${clientUrlEnv}/profile/${user.playerId}`)
    .setTitle('Level File Uploaded')
    .setThumbnail(level.difficulty?.icon || '')
    .addField(`Level #${levelId}`, `${level.song || 'Unknown Song'} — ${level.artist || 'Unknown Artist'}`, true)
    .addField('File Path', filePath, false)
    .setURL(`${clientUrlEnv}/levels/${levelId}`)
    .setTimestamp()
    .setColor('#00cc00');
    await hook.send(embed);
  }

async function logLevelTargetUpdateHook(target: string, levelId: number, user: User): Promise<void> {
    const hook = new Webhook(process.env.LEVEL_FILE_UPDATE_HOOK);
    hook.setUsername('Level Updates');
    hook.setAvatar(botAvatar);

    const level = await Level.findByPk(levelId, { include: {model: Difficulty, as: 'difficulty'} });
    if (!level) {
      throw new Error('Level not found when logging level file update hook');
    }

    const embed = new MessageBuilder()
    .addEmbed()
    .setAuthor(user.username, user.avatarUrl || '', `${clientUrlEnv}/profile/${user.playerId}`)
    .setTitle(`Level #${levelId} - Target Updated`)
    .setThumbnail(level.difficulty?.icon || '')
    .addField(`Level #${levelId}`, `${level.song || 'Unknown Song'} — ${level.artist || 'Unknown Artist'}`, true)
    .addField('Target', target, false)
    .setURL(`${clientUrlEnv}/levels/${levelId}`)
    .setTimestamp()
    .setColor('#5555ff');
    await hook.send(embed);
  }


function getLevelMetadata(level: Level): {song: string | null, artist: string | null, songId: number | null, suffix: string | null, videoLink: string | null, dlLink: string | null, workshopLink: string | null} {
    return {
      song: level.song || null,
      artist: level.artist || null,
      songId: level.songId || null,
      suffix: level.suffix || null,
      videoLink: level.videoLink || null,
      dlLink: level.dlLink || null,
      workshopLink: level.workshopLink || null,
    };
}

function formatValue(value: string | null): string {
    return value || '(empty)';
}

async function logLevelMetadataUpdateHook(oldLevel: Level, newLevel: Level, user: User): Promise<void> {
    const hook = new Webhook(process.env.LEVEL_FILE_UPDATE_HOOK);
    hook.setUsername('Level Updates');
    hook.setAvatar(botAvatar);

    const oldMetadata = getLevelMetadata(oldLevel);
    const newMetadata = getLevelMetadata(newLevel);

    const embed = new MessageBuilder()
    .addEmbed()
    .setTitle(`Level #${newLevel.id} - Info Changed`)
    .setAuthor(user.username, user.avatarUrl || '', `${clientUrlEnv}/profile/${user.playerId}`)
    .setThumbnail(newLevel.difficulty?.icon || '')
    .setTimestamp()
    .setColor('#aaaaaa')
    .setURL(`${clientUrlEnv}/levels/${newLevel.id}`)

    // Compare each field and add changed fields
    const fieldLabels: Record<string, string> = {
        song: 'Song',
        artist: 'Artist',
        songId: 'Song ID',
        suffix: 'Suffix',
        videoLink: 'Video Link',
        dlLink: 'Download Link',
        workshopLink: 'Workshop Link'
    };

    let hasChanges = false;
    for (const [key, label] of Object.entries(fieldLabels)) {
        const oldValue = oldMetadata[key as keyof typeof oldMetadata];
        const newValue = newMetadata[key as keyof typeof newMetadata];

        // Special handling for songId (numeric comparison)
        if (key === 'songId') {
            const oldId = oldValue ?? null;
            const newId = newValue ?? null;
            if (oldId !== newId) {
                hasChanges = true;
                const changeText = `${oldId ?? '(empty)'} ➔ ${newId ?? '(empty)'}`;
                embed.addField(label, changeText, false);
            }
        } else {
            // Compare values (treat null/undefined/empty as equal)
            const oldVal = oldValue || '';
            const newVal = newValue || '';

            if (oldVal !== newVal) {
                hasChanges = true;
                const changeText = `${formatValue(oldVal as string)} ➔ ${formatValue(newVal as string)}`;
                embed.addField(label, changeText, false);
            }
        }
    }

    // Only send if there are actual changes
    if (hasChanges) {
        await hook.send(embed);
    }
}


export {
  logLevelFileUpdateHook,
  logLevelFileDeleteHook,
  logLevelFileUploadHook,
  logLevelTargetUpdateHook,
  logLevelMetadataUpdateHook
};
