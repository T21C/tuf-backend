import { Model, DataTypes } from 'sequelize';
import sequelize from '../config/db';
import { SUPER_ADMINS } from '../config/constants';

// Define the Rater model
export class Rater extends Model {
  public id!: number;
  public discordId!: string;
  public name!: string;
  public discordUsername!: string | null;
  public discordAvatar!: string | null;
  public isSuperAdmin!: boolean;
  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;
}

// Initialize the model
Rater.init({
  id: {
    type: DataTypes.INTEGER,
    autoIncrement: true,
    primaryKey: true,
  },
  discordId: {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true,
  },
  name: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  discordUsername: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  discordAvatar: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  isSuperAdmin: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
  },
}, {
  sequelize,
  modelName: 'Rater',
  tableName: 'raters',
  timestamps: true,
});

export class RaterService {
  // Create a new rater
  static async create(raterData: Partial<Rater>) {
    return await Rater.create({
      ...raterData,
      isSuperAdmin: SUPER_ADMINS.includes(raterData.name || '')
    });
  }

  // Get all raters
  static async getAll() {
    return await Rater.findAll({
      order: [['name', 'ASC']]
    });
  }

  // Get rater by ID
  static async getById(id: string) {
    return await Rater.findOne({
      where: {
        discordId: id
      }
    });
  }

  // Delete rater by ID
  static async deleteById(id: string) {
    return await Rater.destroy({
      where: {
        discordId: id
      }
    });
  }

  // Update rater's Discord info
  static async updateDiscordInfo(id: string, discordUsername: string, discordAvatar: string) {
    return await Rater.update(
      {
        discordUsername,
        discordAvatar,
        updatedAt: new Date()
      },
      {
        where: {
          discordId: id
        }
      }
    );
  }

  // Bulk update raters' Discord info
  static async bulkUpdateDiscordInfo(updates: Array<{
    id: string;
    discordUsername: string;
    discordAvatar: string;
  }>) {
    return await Promise.all(
      updates.map(update => 
        Rater.update(
          {
            discordUsername: update.discordUsername,
            discordAvatar: update.discordAvatar,
            updatedAt: new Date()
          },
          {
            where: {
              discordId: update.id
            }
          }
        )
      )
    );
  }

  // Get all rater IDs
  static async getAllIds(): Promise<string[]> {
    const raters = await Rater.findAll({
      attributes: ['discordId']
    });
    return raters.map(rater => rater.discordId);
  }

  // Check if user is a rater
  static async isRater(id: string): Promise<boolean> {
    const count = await Rater.count({
      where: {
        discordId: id
      }
    });
    return count > 0;
  }
} 