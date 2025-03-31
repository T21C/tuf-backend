import PlayerModifier, { ModifierType } from '../models/PlayerModifier.js';
import { Op } from 'sequelize';
import { PlayerStatsService } from './PlayerStatsService.js';
import Pass from '../models/Pass.js';
import Level from '../models/Level.js';
import { CronJob } from 'cron';
import Player from '../models/Player.js';

export class ModifierService {
  private static instance: ModifierService;
  private modifiersEnabled: boolean = true;
  private cronJobs: Map<number, CronJob> = new Map();
  private cooldownSet = new Set<string>();
  private readonly COOLDOWN_MS = 15 * 1000; // 15 seconds
  

  private constructor() {
    // Initialize cron job to check for expired modifiers every minute
    new CronJob('* * * * *', this.checkExpiredModifiers.bind(this)).start();
  }

  public static getInstance(): ModifierService {
    if (!ModifierService.instance) {
      ModifierService.instance = new ModifierService();
    }
    return ModifierService.instance;
  }

  public setModifiersEnabled(enabled: boolean): void {
    this.modifiersEnabled = enabled;
  }

  public isModifiersEnabled(): boolean {
    return this.modifiersEnabled;
  }

  public async getActiveModifiers(playerId: number): Promise<PlayerModifier[]> {
    return await PlayerModifier.findAll({
      where: {
        playerId,
        expiresAt: {
          [Op.gt]: new Date()
        }
      }
    });
  }

  public async addModifier(playerId: number, type: ModifierType, value: number | null = null): Promise<PlayerModifier> {
    // Default expiration is 2 hours from now
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 2);

    const modifier = await PlayerModifier.create({
      playerId,
      type,
      value,
      expiresAt
    });
    return modifier;
  }

  private async checkExpiredModifiers() {
    try {
      const expiredModifiers = await PlayerModifier.findAll({
        where: {
          expiresAt: {
            [Op.lte]: new Date()
          }
        }
      });

      for (const modifier of expiredModifiers) {
        if (modifier.type === ModifierType.KING_OF_CASTLE) {
          await this.handleKingOfCastleExpiration(modifier.playerId);
        }
        await modifier.destroy();
      }
    } catch (error) {
      console.error('Error checking expired modifiers:', error);
    }
  }

  private async recalculateLevelClearCount(levelId: number): Promise<void> {
    try {
      const clearCount = await Pass.count({
        where: {
          levelId,
          isDeleted: false,
          isHidden: false
        }
      });

      await Level.update(
        { clears: clearCount },
        {
          where: { id: levelId }
        }
      );
    } catch (error) {
      console.error('Error recalculating level clear count:', error);
    }
  }

  private async handleKingOfCastleExpiration(playerId: number) {
    try {
      const hiddenPasses = await Pass.findAll({
        where: {
          playerId,
          isWorldsFirst: true
        }
      });

      // Get unique level IDs from hidden passes
      const levelIds = [...new Set(hiddenPasses.map(pass => pass.levelId))];

      // Unhide all passes
      await Pass.update(
        { isHidden: false },
        {
          where: {
            id: {
              [Op.in]: hiddenPasses.map(pass => pass.id)
            }
          }
        }
      );

      // Recalculate clear counts for affected levels
      for (const levelId of levelIds) {
        await this.recalculateLevelClearCount(levelId);
      }
    } catch (error) {
      console.error('Error handling kingofcastle expiration:', error);
    }
  }

  public async handleKingOfCastle(playerId: number, passes: any[], hide: boolean = true): Promise<void> {
    try {
      // Get all passes where the player has WF
      const wfPasses = passes.filter(pass => pass.isWorldsFirst);
      
      for (const wfPass of wfPasses) {
        // Find all other passes for this level
        const otherPasses = await Pass.findAll({
          where: {
            levelId: wfPass.levelId,
            playerId: {
              [Op.ne]: playerId
            },
            isWorldsFirst: true
          }
        });

        // Hide all other passes
        await Pass.update(
          { isHidden: hide },
          {
            where: {
              id: {
                [Op.in]: otherPasses.map(pass => pass.id)
              }
            }
          }
        );

        // Set clear count to 1 for this level (only showing the king's pass)
        if (hide) {
          await Level.update(
            { clears: 1 },
            {
              where: { id: wfPass.levelId }
            }
          );
        } else {
          await this.recalculateLevelClearCount(wfPass.levelId);
        }
      }
    } catch (error) {
      console.error('Error handling kingofcastle:', error);
    }
  }

  public async applyModifiers(playerId: number, stats: any): Promise<any> {
    if (!this.modifiersEnabled) return stats;
    
    const activeModifiers = await this.getActiveModifiers(playerId);
    let modifiedStats = { ...stats };

    for (const modifier of activeModifiers) {
      switch (modifier.type) {
        case ModifierType.RANKED_ADD:
          modifiedStats.rankedScore += modifier.value || 0;
          break;
        case ModifierType.RANKED_MULTIPLY:
          modifiedStats.rankedScore *= modifier.value || 1;
          break;
        case ModifierType.SCORE_FLIP:
          modifiedStats.rankedScore = this.flipScore(modifiedStats.rankedScore);
          break;
        case ModifierType.SCORE_COMBINE:
          modifiedStats.rankedScore = this.combineScores(
            modifiedStats.rankedScore,
            modifiedStats.generalScore,
            modifiedStats.ppScore,
            modifiedStats.wfScore,
            modifiedStats.score12K
          );
          break;
        case ModifierType.KING_OF_CASTLE:
          // Handle kingofcastle modifier
          if (stats.passes) {
            await this.handleKingOfCastle(playerId, stats.passes);
          }
          break;
      }
    }

    // Ensure all scores are floored
    modifiedStats.rankedScore = Math.floor(modifiedStats.rankedScore);
    modifiedStats.generalScore = Math.floor(modifiedStats.generalScore);
    modifiedStats.ppScore = Math.floor(modifiedStats.ppScore);
    modifiedStats.wfScore = Math.floor(modifiedStats.wfScore);
    modifiedStats.score12K = Math.floor(modifiedStats.score12K);

    return modifiedStats;
  }

  public async generateModifier(playerId: number): Promise<PlayerModifier | null> {
    const roll = Math.random() * 100;
    let cumulativeProbability = 0;

    for (const [type, probability] of Object.entries(PlayerModifier.PROBABILITIES)) {
      cumulativeProbability += probability;
      
      if (roll <= cumulativeProbability) {
        let value = null;
        const config = PlayerModifier.CONFIGS[type as ModifierType];
        
        if (config) {
          value = config.min + Math.random() * (config.max - config.min);
        }

        return await this.addModifier(playerId, type as ModifierType, value);
      }
    }

    return null;
  }

  private flipScore(score: number): number {
    // Convert to string and handle decimals
    const scoreStr = score.toFixed(2);
    
    // Split into integer and decimal parts
    const [intPart, decPart] = scoreStr.split('.');
    
    // Flip the integer part
    const flippedInt = intPart.split('').reverse().join('');
    
    // Combine back with decimal part
    return parseFloat(`${flippedInt}.${decPart}`);
  }

  private combineScores(
    rankedScore: number,
    generalScore: number,
    ppScore: number,
    wfScore: number,
    score12K: number
  ): number {
    // Convert all scores to integers and sum them
    return Math.floor(rankedScore) + 
           Math.floor(generalScore) + 
           Math.floor(ppScore) + 
           Math.floor(wfScore) + 
           Math.floor(score12K);
  }

  private getCooldownKey(playerId: number, targetPlayerId: number): string {
    return `${playerId}:${targetPlayerId}`;
  }

  private isOnCooldown(playerId: number, targetPlayerId: number): boolean {
    const key = this.getCooldownKey(playerId, targetPlayerId);
    return this.cooldownSet.has(key);
  }

  private addCooldown(playerId: number, targetPlayerId: number): void {
    const key = this.getCooldownKey(playerId, targetPlayerId);
    this.cooldownSet.add(key);
    
    // Remove the cooldown after the timeout
    setTimeout(() => {
      this.cooldownSet.delete(key);
    }, this.COOLDOWN_MS);
  }

  public getRemainingCooldown(playerId: number, targetPlayerId: number): number {
    return this.isOnCooldown(playerId, targetPlayerId) ? this.COOLDOWN_MS : 0;
  }

  public async handleModifierGeneration(playerId: number, targetPlayerId: number): Promise<{ modifier: PlayerModifier | null; error?: string }> {
    try {
      // Check if target player exists
      const targetPlayer = await Player.findByPk(targetPlayerId);
      if (!targetPlayer) {
        return { modifier: null, error: 'Target player not found' };
      }

      // Check cooldown
      if (this.isOnCooldown(playerId, targetPlayerId)) {
        const remainingTime = Math.ceil(this.getRemainingCooldown(playerId, targetPlayerId) / 1000);
        return { 
          modifier: null, 
          error: `Spin cooldown active (${remainingTime}s remaining)` 
        };
      }

      // Generate the modifier
      const modifier = await this.generateModifier(targetPlayerId);
      if (!modifier) {
        return { modifier: null, error: 'No modifier was generated' };
      }

      // Handle special cases
      if (modifier.type === ModifierType.BAN_HAMMER && playerId !== targetPlayerId) {
        // If it's a ban hammer and not a self-roll, apply it to the roller instead
        const banModifier = await this.addModifier(
          playerId,
          modifier.type,
          modifier.value
        );
        
        // Update player stats
        await PlayerStatsService.getInstance().updatePlayerStats(playerId);
        
        // Add cooldown
        this.addCooldown(playerId, targetPlayerId);
        
        return { modifier: banModifier };
      }

      // Add cooldown
      this.addCooldown(playerId, targetPlayerId);

      return { modifier };
    } catch (error) {
      console.error('Error handling modifier generation:', error);
      return { modifier: null, error: 'Failed to generate modifier' };
    }
  }
}
