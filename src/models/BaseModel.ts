import {Model} from 'sequelize';

export default class BaseModel extends Model {
  public id!: number;
  public createdAt!: Date;
  public updatedAt!: Date;
}
