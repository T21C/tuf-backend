import {Model} from 'sequelize';

export default class BaseModel extends Model {
  declare id: number;
  declare createdAt: Date;
  declare updatedAt: Date;
}
