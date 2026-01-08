import { EndpointDefinition } from '../services/DocumentationService.js';
import authEndpoints from './auth/index.js';
import adminEndpoints from './admin/index.js';
import databaseEndpoints from './database/index.js';
import miscEndpoints from './misc/index.js';
import profileEndpoints from './profile/index.js';
import webhookEndpoints from './webhooks/index.js';

// Aggregate all endpoints from different categories
export const allEndpoints: EndpointDefinition[] = [
  ...authEndpoints,
  ...adminEndpoints,
  ...databaseEndpoints,
  ...miscEndpoints,
  ...profileEndpoints,
  ...webhookEndpoints
];

export default allEndpoints;
