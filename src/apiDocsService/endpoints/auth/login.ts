import { EndpointDefinition } from '../../services/DocumentationService.js';

const loginEndpoints: EndpointDefinition[] = [
  {
    method: 'POST',
    path: '/v2/auth/login',
    description: 'Authenticate user with email/username and password',
    category: 'AUTH',
    requiresAuth: false,
    parameters: {
      body: {
        emailOrUsername: 'string (required) - User email address or username',
        password: 'string (required) - User password',
        captchaToken: 'string (optional) - reCAPTCHA token for rate limiting'
      }
    },
    responses: {
      '200': 'Login successful - Returns JWT token and user data',
      '401': 'Invalid credentials',
      '400': 'Validation error - Missing fields or captcha required',
      '429': 'Rate limit exceeded - Too many failed attempts'
    }
  },
  {
    method: 'GET',
    path: '/v2/auth/login/:provider',
    description: 'Initiate OAuth login with provider',
    category: 'AUTH',
    requiresAuth: false,
    parameters: {
      path: {
        provider: 'string (required) - OAuth provider (discord, etc.)'
      },
      query: {
        redirect: 'string (optional) - Redirect URL after authentication'
      }
    },
    responses: {
      '302': 'Redirects to provider OAuth authorization page',
      '400': 'Invalid provider or redirect URL'
    }
  }
];

export default loginEndpoints; 