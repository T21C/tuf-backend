import { EndpointDefinition } from '../../services/DocumentationService.js';
import verifyPasswordEndpoints from './verify-password.js';
import usersEndpoints from './users.js';
import ratingEndpoints from './rating.js';
import submissionsEndpoints from './submissions.js';
import curationsEndpoints from './curations.js';
import auditLogEndpoints from './auditLog.js';
import backupEndpoints from './backup.js';
import statisticsEndpoints from './statistics.js';
import songsEndpoints from './songs.js';
import artistsEndpoints from './artists.js';

const adminEndpoints: EndpointDefinition[] = [
  ...verifyPasswordEndpoints,
  ...usersEndpoints,
  ...ratingEndpoints,
  ...submissionsEndpoints,
  ...curationsEndpoints,
  ...auditLogEndpoints,
  ...backupEndpoints,
  ...statisticsEndpoints,
  ...songsEndpoints,
  ...artistsEndpoints
];

export default adminEndpoints;
