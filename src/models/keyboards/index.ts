import KeyboardFormFactor from './KeyboardFormFactor.js';
import KeyboardGeometry from './KeyboardGeometry.js';
import KeyboardProduct from './KeyboardProduct.js';
import KeyboardSwitch from './KeyboardSwitch.js';
import KeyboardRig from './KeyboardRig.js';
import KeyboardBoardPeriod from './KeyboardBoardPeriod.js';
import KeyboardBoardPeriodKey from './KeyboardBoardPeriodKey.js';
import KeyboardLane from './KeyboardLane.js';
import KeyboardLanePeriod from './KeyboardLanePeriod.js';
import PassBindOverride from './PassBindOverride.js';
import Player from '@/models/players/Player.js';

export function initializeKeyboardsAssociations() {
  KeyboardGeometry.hasMany(KeyboardProduct, {foreignKey: 'geometryId', as: 'products'});
  KeyboardProduct.belongsTo(KeyboardGeometry, {foreignKey: 'geometryId', as: 'geometry'});

  Player.hasMany(KeyboardRig, {foreignKey: 'playerId', as: 'keyboardRigs'});
  KeyboardRig.belongsTo(Player, {foreignKey: 'playerId', as: 'player'});

  KeyboardRig.hasMany(KeyboardBoardPeriod, {
    foreignKey: 'rigId',
    as: 'boardPeriods',
    onDelete: 'CASCADE',
  });
  KeyboardBoardPeriod.belongsTo(KeyboardRig, {foreignKey: 'rigId', as: 'rig'});
  KeyboardBoardPeriod.belongsTo(KeyboardGeometry, {foreignKey: 'geometryId', as: 'geometry'});
  KeyboardBoardPeriod.belongsTo(KeyboardProduct, {foreignKey: 'productId', as: 'product'});
  KeyboardBoardPeriod.belongsTo(KeyboardSwitch, {foreignKey: 'switchId', as: 'switch'});

  KeyboardBoardPeriod.hasMany(KeyboardBoardPeriodKey, {
    foreignKey: 'boardPeriodId',
    as: 'keyOverrides',
    onDelete: 'CASCADE',
  });
  KeyboardBoardPeriodKey.belongsTo(KeyboardBoardPeriod, {
    foreignKey: 'boardPeriodId',
    as: 'boardPeriod',
  });
  KeyboardBoardPeriodKey.belongsTo(KeyboardSwitch, {foreignKey: 'switchId', as: 'switch'});

  KeyboardRig.hasMany(KeyboardLane, {foreignKey: 'rigId', as: 'lanes', onDelete: 'CASCADE'});
  KeyboardLane.belongsTo(KeyboardRig, {foreignKey: 'rigId', as: 'rig'});

  KeyboardLane.hasMany(KeyboardLanePeriod, {
    foreignKey: 'laneId',
    as: 'periods',
    onDelete: 'CASCADE',
  });
  KeyboardLanePeriod.belongsTo(KeyboardLane, {foreignKey: 'laneId', as: 'lane'});

  KeyboardLanePeriod.hasMany(PassBindOverride, {
    foreignKey: 'lanePeriodId',
    as: 'passOverrides',
    onDelete: 'CASCADE',
  });
  PassBindOverride.belongsTo(KeyboardLanePeriod, {foreignKey: 'lanePeriodId', as: 'lanePeriod'});
  PassBindOverride.belongsTo(Player, {foreignKey: 'playerId', as: 'player'});
}

export {
  KeyboardFormFactor,
  KeyboardGeometry,
  KeyboardProduct,
  KeyboardSwitch,
  KeyboardRig,
  KeyboardBoardPeriod,
  KeyboardBoardPeriodKey,
  KeyboardLane,
  KeyboardLanePeriod,
  PassBindOverride,
};
