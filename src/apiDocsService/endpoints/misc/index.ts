import { EndpointDefinition } from '../../services/DocumentationService.js';
import { utilsEndpoints } from './utils.js';
import { mediaEndpoints } from './media.js';
import { formEndpoints } from './form.js';
import { eventsEndpoints } from './events.js';
import { discordEndpoints } from './discord.js';
import { chunkedUploadEndpoints } from './chunkedUpload.js';
import { healthEndpoints } from './health.js';

const miscEndpoints: EndpointDefinition[] = [
  ...utilsEndpoints,
  ...mediaEndpoints,
  ...formEndpoints,
  ...eventsEndpoints,
  ...discordEndpoints,
  ...chunkedUploadEndpoints,
  ...healthEndpoints
];

export default miscEndpoints;
