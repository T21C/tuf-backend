import {DataTypes, Model, Optional} from 'sequelize';
import sequelize from '@/config/db.js';

export interface TufStellarNomineeMonthAttributes {
  id: number;
  userId: string;
  monthKey: string;
  createdAt: Date;
}

type Creation = Optional<TufStellarNomineeMonthAttributes, 'id' | 'createdAt'>;

class TufStellarNomineeMonth
  extends Model<TufStellarNomineeMonthAttributes, Creation>
  implements TufStellarNomineeMonthAttributes
{
  declare id: number;
  declare userId: string;
  declare monthKey: string;
  declare createdAt: Date;
}

TufStellarNomineeMonth.init(
  {
    id: {
      type: DataTypes.BIGINT.UNSIGNED,
      autoIncrement: true,
      primaryKey: true,
    },
    userId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: {model: 'users', key: 'id'},
    },
    monthKey: {
      type: DataTypes.STRING(7),
      allowNull: false,
    },
    createdAt: {
      type: DataTypes.DATE(6),
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
  },
  {
    sequelize,
    modelName: 'TufStellarNomineeMonth',
    tableName: 'tufstellar_nominee_months',
    timestamps: false,
    underscored: false,
    indexes: [
      {
        unique: true,
        fields: ['userId', 'monthKey'],
        name: 'uniq_tufstellar_nominee_months_user_month',
      },
    ],
  },
);

export default TufStellarNomineeMonth;
