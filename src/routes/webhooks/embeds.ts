import Difficulty from "../../models/Difficulty";
import Level from "../../models/Level";
import Pass from "../../models/Pass";
import { MessageBuilder } from "../../webhook";
import { Score, calculateRankedScore } from "../../misc/PlayerStatsCalculator";


const placeHolder = process.env.OWN_URL + '/v2/media/image/soggycat.png';

function trim(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength - 3) + '...';
}

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
  
  
  
// DONE ################
  export function createClearEmbed(passInfo: Pass | null): MessageBuilder {
    if (!passInfo) return new MessageBuilder().setDescription('No pass info available');
    const pass = passInfo.dataValues;
    const level = pass.level;

    const currentRankedScore = calculateRankedScore(pass.player?.passes?.map(pass => ({ 
        score: pass.scoreV2 || 0, 
        baseScore: pass.level?.baseScore || 0,
        xacc: pass.accuracy || 0,
        isWorldsFirst: pass.isWorldsFirst || false,
        is12K: pass.is12K || false,
        isDeleted: pass.isDeleted || false
    })) || []);

    const previousRankedScore = calculateRankedScore(pass.player?.passes?.filter(p => p.id !== pass.id).map(pass => ({ 
        score: pass.scoreV2 || 0, 
        baseScore: pass.level?.baseScore || 0,
        xacc: pass.accuracy || 0,
        isWorldsFirst: pass.isWorldsFirst || false,
        is12K: pass.is12K || false,
        isDeleted: pass.isDeleted || false
    })) || []);

    const showAddInfo = pass.isWorldsFirst || pass.is12K || pass.is16K || pass.isNoHoldTap;
    const additionalInfo = (
    `${pass.isWorldsFirst ? '🏆 World\'s First!  |  ' : ''}` +
    `${pass.is12K ? '12K  |  ' : ''}` +
    `${pass.is16K ? '16K  |  ' : ''}` +
    `${pass.isNoHoldTap ? 'No Hold Tap  |  ' : ''}`
    ).replace(/\|\s*$/, '');
    const judgementLine = pass.judgements ? 
      `\`\`\`ansi\n[2;31m${pass.judgements.earlyDouble}[0m [2;33m${pass.judgements.earlySingle}[0m [2;32m${pass.judgements.ePerfect}[0m [1;32m${pass.judgements.perfect}[0m [2;32m${pass.judgements.lPerfect}[0m [2;33m${pass.judgements.lateSingle}[0m [2;31m${pass.judgements.lateDouble}[0m\n\`\`\`\n` : '';
    
    const team = `Level by ${pass.level?.team || ''}`
    const credit = `${trim(pass.level?.charter || 'Unknown', 25)} ${pass.level?.vfxer ? `| VFX by ${trim(pass.level?.vfxer || 'Unknown', 25)}` : ''}`;

    const embed = new MessageBuilder()
      .setAuthor(
        `${trim(level?.song || 'Unknown Song', 27)}\n— ${trim(level?.artist || 'Unknown Artist', 30)}`,
        pass.level?.difficulty?.icon || '',
        ''
      )
      .setTitle(`Clear by ${trim(pass.player?.name || 'Unknown Player', 25)}`)
      .setColor('#000000')
      .setThumbnail(
        pass.player?.discordAvatar ? 
        pass.player?.discordAvatar : 
        pass.player?.pfp && 
        pass.player?.pfp !== "none" ? 
        pass.player?.pfp : 
        placeHolder
      )
      .addField("", "", false)
      .addField('Player', `**${pass.player?.discordId ? `<@${pass.player?.discordId}>` : pass.player?.name || 'Unknown Player'}**`, true)
      .addField('Ranked Score', `**${currentRankedScore.toFixed(2)}** (+${(currentRankedScore - previousRankedScore).toFixed(2)})`, true)
      .addField("", "", false)

      .addField('Feeling Rating', `**${pass.feelingRating || 'None'}**`, true)
      .addField('Score', `**${pass.scoreV2?.toFixed(2) || 0}**`, true)
      .addField("", "", false)

      .addField('Accuracy', `**${((pass.accuracy || 0.95) * 100).toFixed(2)}%**`, true)
      .addField('<:1384060:1317995999355994112>', `**[Go to video](${pass.vidLink})**`, true)
      .addField("", "", false)
      .addField('', judgementLine, false)
      .addField(showAddInfo ? additionalInfo : '', '', false)
      .setFooter(
        team || credit, 
        ''
      )
      .setTimestamp();
    console.log("embed");
    console.log(JSON.stringify(embed.getJSON(), null, 2));
    return embed;
  }