import { EndpointDefinition } from '../../services/DocumentationService.js';
import loginEndpoints from './login.js';
import registerEndpoints from './register.js';
import oauthEndpoints from './oauth.js';
import verificationEndpoints from './verification.js';

const authEndpoints: EndpointDefinition[] = [
  ...loginEndpoints,
  ...registerEndpoints,
  ...oauthEndpoints,
  ...verificationEndpoints
];

export default authEndpoints; 