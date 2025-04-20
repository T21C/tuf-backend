import {Model, DataTypes} from 'sequelize';
import {db} from '../index.js';
import Team from './Team.js';

export class TeamAlias extends Model {
  public id!: number;
  public teamId!: number;
  public name!: string;
  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;
}

TeamAlias.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    teamId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'teams',
        key: 'id',
      },
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
    },
  },
  {
    sequelize: db.sequelize,
    tableName: 'team_aliases',
    timestamps: true,
  }
);

// Set up associations
TeamAlias.belongsTo(Team, {
  foreignKey: 'teamId',
  as: 'team',
});

Team.hasMany(TeamAlias, {
  foreignKey: 'teamId',
  as: 'teamAliases',
}); 