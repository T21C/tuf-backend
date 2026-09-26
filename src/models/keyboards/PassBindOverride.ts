import {
  CreationOptional,
  DataTypes,
  InferAttributes,
  InferCreationAttributes,
  Model,
} from 'sequelize';
import {getSequelizeForModelGroup} from '@/config/db.js';

const sequelize = getSequelizeForModelGroup('players');

class PassBindOverride extends Model<
  InferAttributes<PassBindOverride>,
  InferCreationAttributes<PassBindOverride>
> {
  declare passId: number;
  declare playerId: number;
  declare lanePeriodId: number;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

PassBindOverride.init(
  {
    passId: {type: DataTypes.INTEGER, primaryKey: true},
    playerId: {type: DataTypes.INTEGER, allowNull: false},
    lanePeriodId: {type: DataTypes.INTEGER, allowNull: false},
    createdAt: {type: DataTypes.DATE, allowNull: false},
    updatedAt: {type: DataTypes.DATE, allowNull: false},
  },
  {
    sequelize,
    tableName: 'pass_bind_overrides',
    indexes: [
      {fields: ['playerId'], name: 'idx_pass_bind_overrides_player_id'},
      {fields: ['lanePeriodId'], name: 'idx_pass_bind_overrides_lane_period_id'},
    ],
  },
);

export default PassBindOverride;
