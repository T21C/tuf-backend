import { EndpointDefinition } from '../../services/DocumentationService.js';

const loginEndpoints: EndpointDefinition[] = [
  {
    method: 'POST',
    path: '/v2/auth/login',
    description: 'Authenticate user with email and password',
    category: 'AUTH',
    requiresAuth: false,
    parameters: {
      body: {
        email: 'string (required) - User email address',
        password: 'string (required) - User password',
        remember: 'boolean (optional) - Remember user session'
      }
    },
    responses: {
      '200': 'Login successful - Returns JWT token and user data',
      '401': 'Invalid credentials',
      '400': 'Validation error - Invalid email or password format'
    }
  }
];

export default loginEndpoints; 