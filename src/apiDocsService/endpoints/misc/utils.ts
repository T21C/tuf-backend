import { EndpointDefinition } from '../../services/DocumentationService.js';

export const utilsEndpoints: EndpointDefinition[] = [
  {
    method: 'POST',
    path: '/utils/verify-translations',
    category: 'UTILS',
    description: 'Upload a ZIP file containing translations to verify against the English base translations',
    parameters: {
      body: {
        translationZip: 'file (required) - ZIP file containing translation files'
      }
    },
    responses: {
      '200': 'Translation verification result with missing files, missing keys, and extra keys',
      '400': 'No file uploaded or invalid file format',
      '500': 'Server error during verification'
    },
    requiresAuth: false
  },
  {
    method: 'GET',
    path: '/utils/download-translations',
    category: 'UTILS',
    description: 'Download English translations as a ZIP file',
    parameters: {},
    responses: {
      '200': 'ZIP file containing English translations',
      '500': 'Server error creating translations zip'
    },
    requiresAuth: false
  },
  {
    method: 'GET',
    path: '/utils/languages',
    category: 'UTILS',
    description: 'Get list of available languages with implementation status',
    parameters: {},
    responses: {
      '200': 'List of languages with display names, country codes, and implementation status',
      '500': 'Server error getting languages list'
    },
    requiresAuth: false
  },
  {
    method: 'GET',
    path: '/utils/download-translations/:lang',
    category: 'UTILS',
    description: 'Download translations for a specific language',
    parameters: {
      path: {
        lang: 'string (required) - Language code (e.g., en, pl, kr, cn, etc.)'
      }
    },
    responses: {
      '200': 'ZIP file containing translations for the specified language',
      '404': 'Language not found or translations not available',
      '500': 'Server error creating translations zip'
    },
    requiresAuth: false
  },
  {
    method: 'GET',
    path: '/utils',
    category: 'UTILS',
    description: 'Serve the utility navigation page with translation tools',
    parameters: {},
    responses: {
      '200': 'HTML page with translation verification interface'
    },
    requiresAuth: false
  }
]; 