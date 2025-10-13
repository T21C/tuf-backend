import { EndpointDefinition } from '../../services/DocumentationService.js';

const registerEndpoints: EndpointDefinition[] = [
  {
    method: 'POST',
    path: '/v2/auth/register',
    description: 'Register a new user account',
    category: 'AUTH',
    requiresAuth: false,
    parameters: {
      body: {
        username: 'string (required) - Unique username (3-20 chars, alphanumeric + _ -)',
        email: 'string (required) - Valid email address',
        password: 'string (required) - Password (min 8 characters)',
        captchaToken: 'string (optional) - reCAPTCHA token for rate limiting'
      }
    },
    responses: {
      '201': 'Registration successful - Returns JWT token and user data',
      '400': 'Validation error - Invalid input data or email/username already taken',
      '429': 'Rate limit exceeded - Too many registration attempts'
    }
  }
];

export default registerEndpoints;
