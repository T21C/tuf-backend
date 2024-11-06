import { updateData, syncJsonToSheet } from '../utils/updateHelpers.js';

export const startScheduledTasks = () => {
  // Update data every 10 minutes
  const DATA_UPDATE_INTERVAL = 10 * 60 * 1000;
  setInterval(updateData, DATA_UPDATE_INTERVAL);

  // Sync with Google Sheet every 5 minutes
  const SHEET_SYNC_INTERVAL = 5 * 60 * 1000;
  setInterval(syncJsonToSheet, SHEET_SYNC_INTERVAL);
};