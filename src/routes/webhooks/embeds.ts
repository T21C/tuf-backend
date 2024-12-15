import Difficulty from "../../models/Difficulty";
import Level from "../../models/Level";
import Pass from "../../models/Pass";
import { MessageBuilder } from "../../webhook";

const placeHolder = process.env.OWN_URL + '/v2/media/image/soggycat.png';

export async function getDifficultyEmojis(levelInfo: Level | null): Promise<string | null> {
    if (!levelInfo) return null;
    const qList = "Q2,Q2+,Q3,Q3+,Q4";
    const qMap = {
      "Q2": ["U5", "U6"],
      "Q2+": ["U7", "U8"],
      "Q3": ["U9", "U10"],
      "Q3+": ["U11", "U12"],
      "Q4": ["U13", "U14"],
    }
    const difficulties = await Difficulty.findAll().then(data => data.map(difficulty => difficulty.dataValues));
    const level = levelInfo.dataValues;
    const difficulty = difficulties.find(difficulty => difficulty.name === level.difficulty?.name);
    if (qList.includes(level.difficulty?.name || '')) {
      const q = qMap[`${level.difficulty?.name || ''}` as keyof typeof qMap];
      const emoji = q.map(emoji => 
        difficulties.find(
          difficulty => difficulty.name === emoji
        )?.emoji || ''
      ).join('~')
      + ` | ${difficulties.find(
        difficulty => difficulty.name === q[0]
      )?.legacyEmoji || ''}`;
      return `${difficulty?.emoji || ''}${emoji ? ` | ${emoji}` : ''}${difficulty?.legacyEmoji ? ` | ${difficulty?.legacyEmoji}` : ''}`;
    }
    return `${difficulty?.emoji || ''}${difficulty?.legacyEmoji ? ` | ${difficulty?.legacyEmoji}` : ''}`;
  }
  
  
  export function createRerateEmbed(levelInfo: Level | null): MessageBuilder {
    if (!levelInfo) return new MessageBuilder().setDescription('No pass info available');
    const level = levelInfo.dataValues;
  
    const embed = new MessageBuilder()
      .setTitle('New level!')
      .setAuthor(
        `${level.artist || 'Unknown Artist'} - ${level.song || 'Unknown Song'}\n`,
        '',
        level.vidLink
      )
      .setColor('#000000')
      .setThumbnail(
        level.difficulty?.icon || ''
      )
      .setDescription(
        `${level.artist || 'Unknown Artist'} - ${level.song || 'Unknown Song'}\n` +
        `${level.vidLink ? `[Go to video](${level.vidLink})` : 'No video link'}\n\n` +
        `Difficulty: **${level.difficulty?.emoji} | ${level.difficulty?.legacyEmoji}**\n\n`
      )
      .setFooter(
        `Mapped by ${level.charter || 'Unknown'}${level.vfxer ? ` | VFX by ${level.vfxer || 'Unknown'}` : ''}`, 
        placeHolder
      )
      .setTimestamp();
  
    return embed;
  }
  
  
  
  
  export async function createNewLevelEmbed(levelInfo: Level | null): Promise<MessageBuilder> {
    if (!levelInfo) return new MessageBuilder().setDescription('No pass info available');
    const level = levelInfo.dataValues;
  
    const embed = new MessageBuilder()
      .setTitle('New level!')
      .setAuthor(
        `${level.artist || 'Unknown Artist'} - ${level.song || 'Unknown Song'}\n`,
        '',
        level.vidLink
      )
      .setColor('#000000')
      .setThumbnail(
        level.difficulty?.icon || ''
      )
      .setDescription(
        `${level.artist || 'Unknown Artist'} - ${level.song || 'Unknown Song'}\n` +
        `${level.vidLink ? `[Go to video](${level.vidLink})` : 'No video link'}\n\n` +
        `Difficulty: ${await getDifficultyEmojis(levelInfo)}\n\n`
      )
      .setFooter(
        `Mapped by ${level.charter || 'Unknown'}${level.vfxer ? ` | VFX by ${level.vfxer || 'Unknown'}` : ''}`, 
        placeHolder
      )
      .setTimestamp();
  
    return embed;
  }
  
  
  
  
  export function createClearEmbed(passInfo: Pass | null): MessageBuilder {
    if (!passInfo) return new MessageBuilder().setDescription('No pass info available');
    const pass = passInfo.dataValues;
    console.log(pass.level?.difficulty?.icon);
  
    pass.player?.passes?.map(pass => {
      console.log(pass.level?.difficulty?.icon);
    });


    const showAddInfo = pass.isWorldsFirst || pass.is12K || pass.is16K || pass.isNoHoldTap;
    const additionalInfo = `### ${pass.isWorldsFirst ? '🏆 World\'s First!\n' : ''}` +
    `${pass.is12K ? '12K ' : ''}${pass.is16K ? '16K ' : ''}${pass.isNoHoldTap ? 'No Hold Tap ' : ''}`;
    console.log(pass);
    const judgementLine = pass.judgements ? 
      `\`\`\`ansi\n[2;31m${pass.judgements.earlyDouble}[0m [2;33m${pass.judgements.earlySingle}[0m [2;32m${pass.judgements.ePerfect}[0m [1;32m${pass.judgements.perfect}[0m [2;32m${pass.judgements.lPerfect}[0m [2;33m${pass.judgements.lateSingle}[0m [2;31m${pass.judgements.lateDouble}[0m\n\`\`\`\n` : '';
  
    const embed = new MessageBuilder()
      .setTitle(`${pass.level?.song || 'Unknown Song'} - ${pass.level?.artist || 'Unknown Artist'}`)
      .setAuthor(
        pass.player?.name || 'Unknown Player',
        pass.level?.difficulty?.icon || '',
        ''
      )
      .setColor('#000000')
      .setThumbnail(
        pass.player?.discordAvatar ? 
        pass.player?.discordAvatar : 
        pass.player?.pfp && 
        pass.player?.pfp !== "none" ? 
        pass.player?.pfp : 
        placeHolder
      )
      .setDescription(
        `${pass.vidLink ? `[Go to video](${pass.vidLink})` : 'No video link'}\n\n` +
        `Player: \n` +
        `**${pass.player?.discordId ? `<@${pass.player?.discordId}>` : pass.player?.name || 'Unknown Player'}**\n\n` +
        `Score: \n` +
        `**${pass.scoreV2 || 0}**\n\n` +
        `Feeling Rating:\n` +
        `**${pass.feelingRating || 'None'}**\n\n` +
        `Accuracy:\n` +
        `**${((pass.accuracy || 0.95) * 100).toFixed(4)}%**\n\n` +
        judgementLine +
        (showAddInfo ? additionalInfo : '')
      )
      .setFooter(
        `Mapped by ${pass.level?.charter || 'Unknown'} | VFX by ${pass.level?.vfxer || 'Unknown'}`, 
        placeHolder
      )
      .setTimestamp();
  
    return embed;
  }