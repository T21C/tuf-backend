import { EndpointDefinition } from '../../services/DocumentationService.js';
import profileEndpoints from './profile.js';

const profileEndpointsList: EndpointDefinition[] = [
  ...profileEndpoints
];

export default profileEndpointsList; 