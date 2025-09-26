import { initializeAuthAssociations } from './auth/associations.js';
import { initializeCreditsAssociations } from './credits/associations.js';
import { initializeLevelsAssociations } from './levels/associations.js';
import { initializePassesAssociations } from './passes/associations.js';
import { initializePlayersAssociations } from './players/associations.js';
import { initializeSubmissionsAssociations } from './submissions/associations.js';
import { initializeAnnouncementsAssociations } from './announcements/associations.js';
import { initializeCurationsAssociations } from './curations/associations.js';
import { initializePacksAssociations } from './packs/associations.js';

export function initializeAssociations() {
  // Initialize all model associations by calling individual association functions
  initializeAuthAssociations();
  initializeCreditsAssociations();
  initializeLevelsAssociations();
  initializePassesAssociations();
  initializePlayersAssociations();
  initializeSubmissionsAssociations();
  initializeAnnouncementsAssociations();
  initializeCurationsAssociations();
  initializePacksAssociations();
}
