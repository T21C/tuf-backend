import {
  CreationOptional,
  DataTypes,
  InferAttributes,
  InferCreationAttributes,
  Model,
} from 'sequelize';
import {getSequelizeForModelGroup} from '@/config/db.js';

const sequelize = getSequelizeForModelGroup('players');

class KeyboardLanePeriod extends Model<
  InferAttributes<KeyboardLanePeriod>,
  InferCreationAttributes<KeyboardLanePeriod>
> {
  declare id: CreationOptional<number>;
  declare laneId: number;
  declare sinceDate: string | null;
  declare untilDate: string | null;
  declare untilAuto: CreationOptional<boolean>;
  declare keysJson: string[] | null;
  declare keySignature: string | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

KeyboardLanePeriod.init(
  {
    id: {type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true},
    laneId: {type: DataTypes.INTEGER, allowNull: false},
    sinceDate: {type: DataTypes.DATEONLY, allowNull: true},
    untilDate: {type: DataTypes.DATEONLY, allowNull: true},
    untilAuto: {type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true},
    keysJson: {type: DataTypes.JSON, allowNull: true},
    keySignature: {type: DataTypes.STRING(1024), allowNull: true},
    createdAt: {type: DataTypes.DATE, allowNull: false},
    updatedAt: {type: DataTypes.DATE, allowNull: false},
  },
  {
    sequelize,
    tableName: 'keyboard_lane_periods',
    indexes: [{fields: ['laneId', 'sinceDate'], name: 'idx_keyboard_lane_periods_lane_since'}],
  },
);

export default KeyboardLanePeriod;
