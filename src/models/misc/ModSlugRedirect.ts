import {
  Model,
  DataTypes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
  ForeignKey,
} from 'sequelize';
import {getSequelizeForModelGroup} from '@/config/db.js';
import type Mod from './Mod.js';

const sequelize = getSequelizeForModelGroup('admin');

class ModSlugRedirect extends Model<
  InferAttributes<ModSlugRedirect>,
  InferCreationAttributes<ModSlugRedirect>
> {
  declare id: CreationOptional<number>;
  declare slug: string;
  declare modId: ForeignKey<Mod['id']>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

ModSlugRedirect.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    slug: {
      type: DataTypes.STRING(80),
      allowNull: false,
      unique: true,
    },
    modId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    updatedAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
  },
  {
    sequelize,
    tableName: 'mod_slug_redirects',
    indexes: [{fields: ['modId'], name: 'idx_mod_slug_redirects_mod_id'}],
  },
);

export default ModSlugRedirect;
