import { EndpointDefinition } from '../../../services/DocumentationService.js';
import search from './search.js';
import announcements from './announcements.js';
import modification from './modification.js';

const passEndpoints: EndpointDefinition[] = [
  ...search,
  ...announcements,
  ...modification,
];

export default passEndpoints;
