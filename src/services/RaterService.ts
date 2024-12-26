import { Model, DataTypes } from 'sequelize';
import sequelize from '../config/db';
import { SUPER_ADMINS } from '../config/constants';

// Define the Rater model
export class Rater extends Model {
  public id!: number;
  public discordId!: string;
  public discordUsername!: string;
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
  discordUsername: {
    type: DataTypes.STRING,
    allowNull: false,
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
    await Rater.create({
      ...raterData,
      isSuperAdmin: SUPER_ADMINS.includes(raterData.discordUsername || '')
    });
    return Rater.findOne({
      where: {
        discordId: raterData.discordId
      }
    });
  }

  // Get all raters
  static async getAll() {
    return await Rater.findAll({
      order: [['discordUsername', 'ASC']]
    });
  }

  // Get rater by ID
  static async getById(id: string) {
    return await Rater.findByPk(id);
  }

  // Delete rater by ID
  static async deleteById(id: string) {
    return await Rater.destroy({
      where: {
        id: id
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
          id: id
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
              id: update.id
            }
          }
        )
      )
    );
  }

  // Get all rater IDs
  static async getAllIds(): Promise<string[]> {
    const raters = await Rater.findAll({
      attributes: ['id']
    });
    return raters.map(rater => rater.id.toString());
  }

  // Check if user is a rater
  static async isRater(discordId: string): Promise<boolean> {
    const count = await Rater.count({
      where: {
        discordId: discordId
      }
    });
    return count > 0;
  }

  // Get rater by username
  static async getByUsername(username: string) {
    return await Rater.findOne({
      where: {
        discordUsername: username
      }
    });
  }

  // Update super admin status
  static async updateSuperAdminStatus(id: string, isSuperAdmin: boolean) {
    return await Rater.update(
      {
        isSuperAdmin,
        updatedAt: new Date()
      },
      {
        where: {
          id: id
        }
      }
    );
  }
} 