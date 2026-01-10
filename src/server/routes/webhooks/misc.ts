import {Webhook, MessageBuilder} from '../../../misc/webhook/index.js';
import { User } from "../../../models/index.js";
import { clientUrlEnv } from "../../../config/app.config.js";
import Level from '../../../models/levels/Level.js';
import Difficulty from '../../../models/levels/Difficulty.js';

const botAvatar = process.env.BOT_AVATAR_URL || '';

async function logLevelFileUpdateHook(originalPath: string, newPath: string, levelId: number, user: User): Promise<void> {
    const hook = new Webhook(process.env.LEVEL_FILE_UPDATE_HOOK);
    hook.setUsername('TUF Level File Updated');
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
    .addField(`Level #${levelId}`, `${level.song || 'Unknown Song'} — ${level.artist || 'Unknown Artist'}`, true)
    .addField('Original Path', originalPath, true)
    .addField('New Path', newPath, true)
    .setColor('#99ff00')
    .setTimestamp();
    await hook.send(embed);
  }

  async function logLevelFileDeleteHook(levelId: number, user: User): Promise<void> {
    const hook = new Webhook(process.env.LEVEL_FILE_UPDATE_HOOK);
    hook.setUsername('TUF Level File Deleted');
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
    .setColor('#990000');
    await hook.send(embed);
  }

  async function logLevelFileUploadHook(filePath: string, levelId: number, user: User): Promise<void> {
    const hook = new Webhook(process.env.LEVEL_FILE_UPDATE_HOOK);
    hook.setUsername('TUF Level File Uploaded');
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
    .setTimestamp()
    .setColor('#00cc00');
    await hook.send(embed);
  }

  async function logLevelTargetUpdateHook(target: string, levelId: number, user: User): Promise<void> {
    const hook = new Webhook(process.env.LEVEL_FILE_UPDATE_HOOK);
    hook.setUsername('TUF Level Target Updated');
    hook.setAvatar(botAvatar);

    const level = await Level.findByPk(levelId, { include: {model: Difficulty, as: 'difficulty'} });
    if (!level) {
      throw new Error('Level not found when logging level file update hook');
    }

    const embed = new MessageBuilder()
    .addEmbed()
    .setAuthor(user.username, user.avatarUrl || '', `${clientUrlEnv}/profile/${user.playerId}`)
    .setTitle('Level Target Updated')
    .setThumbnail(level.difficulty?.icon || '')
    .addField(`Level #${levelId}`, `${level.song || 'Unknown Song'} — ${level.artist || 'Unknown Artist'}`, true)
    .addField('Target', target, false)
    .setTimestamp()
    .setColor('#777777');
    await hook.send(embed);
  }

  
  export { logLevelFileUpdateHook, logLevelFileDeleteHook, logLevelFileUploadHook, logLevelTargetUpdateHook };