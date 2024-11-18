import {updateData} from '../utils/updateHelpers.js';

export const startScheduledTasks = () => {
  // Update data every 5 minutes
  const DATA_UPDATE_INTERVAL = 5 * 60 * 1000;
  setInterval(updateData, DATA_UPDATE_INTERVAL);
};
