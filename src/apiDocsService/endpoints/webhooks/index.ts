import { EndpointDefinition } from '../../services/DocumentationService.js';
import webhookEndpoints from './webhook.js';
import embedsEndpoints from './embeds.js';
import channelParserEndpoints from './channelParser.js';

const webhookEndpointsList: EndpointDefinition[] = [
  ...webhookEndpoints,
  ...embedsEndpoints,
  ...channelParserEndpoints
];

export default webhookEndpointsList; 