import { DataTypes, Model } from 'sequelize';
import sequelize from '../config/db';
import { ICreator, ITeam } from '../interfaces/models';

class Team extends Model implements ITeam {
  declare id: number;
  declare name: string;
  declare aliases: string[];
  declare description?: string;
  declare createdAt: Date;
  declare updatedAt: Date;
  declare members: ICreator[];
}

Team.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
    },
    aliases: {
      type: DataTypes.JSON,
      defaultValue: [],
      get() {
        const rawValue = this.getDataValue('aliases');
        return rawValue ? JSON.parse(rawValue) : [];
      },
      set(value: string[]) {
        this.setDataValue('aliases', JSON.stringify(value));
      }
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    updatedAt: {
      type: DataTypes.DATE,
      allowNull: false,
    }
  },
  {
    sequelize,
    modelName: 'Team',
    tableName: 'teams',
  }
);

export default Team; 