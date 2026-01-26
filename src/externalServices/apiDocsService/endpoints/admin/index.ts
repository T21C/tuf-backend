import { EndpointDefinition } from '../../services/DocumentationService.js';
import verifyPasswordEndpoints from './verify-password.js';
import usersEndpoints from './users.js';
import ratingEndpoints from './rating.js';
import submissionsEndpoints from './submissions.js';
import curationsEndpoints from './curations.js';
import auditLogEndpoints from './auditLog.js';
import backupEndpoints from './backup.js';
import statisticsEndpoints from './statistics.js';
const adminEndpoints: EndpointDefinition[] = [
  ...verifyPasswordEndpoints,
  ...usersEndpoints,
  ...ratingEndpoints,
  ...submissionsEndpoints,
  ...curationsEndpoints,
  ...auditLogEndpoints,
  ...backupEndpoints,
  ...statisticsEndpoints
];

export default adminEndpoints;
