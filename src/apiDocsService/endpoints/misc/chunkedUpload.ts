import { EndpointDefinition } from '../../services/DocumentationService.js';

export const chunkedUploadEndpoints: EndpointDefinition[] = [
  {
    method: 'GET',
    path: '/chunked-upload',
    category: 'MEDIA',
    description: 'Check if chunked upload API is running',
    parameters: {},
    responses: {
      '200': 'API status message'
    },
    requiresAuth: true,
    requiresAdmin: true
  },
  {
    method: 'POST',
    path: '/chunked-upload/chunk',
    category: 'MEDIA',
    description: 'Upload a file chunk for assembly',
    parameters: {
      headers: {
        'x-file-id': 'string (required) - Unique file identifier',
        'x-chunk-index': 'string (required) - Chunk index number',
        'x-total-chunks': 'string (required) - Total number of chunks'
      },
      body: {
        chunk: 'file (required) - File chunk data'
      }
    },
    responses: {
      '200': 'Chunk uploaded successfully or file assembled',
      '400': 'Missing required parameters or invalid file ID',
      '500': 'Server error processing upload'
    },
    requiresAuth: true,
    requiresAdmin: true
  },
  {
    method: 'POST',
    path: '/chunked-upload/validate',
    category: 'MEDIA',
    description: 'Validate upload status and check completion',
    parameters: {
      body: {
        fileId: 'string (required) - File ID to validate'
      }
    },
    responses: {
      '200': 'Upload status with completion info',
      '400': 'Missing fileId',
      '403': 'Unauthorized access to upload',
      '404': 'Upload not found'
    },
    requiresAuth: true,
    requiresAdmin: true
  },
  {
    method: 'POST',
    path: '/v2/chunked-upload/cleanup',
    description: 'Clean up all uploads for the current user',
    category: 'UTILS',
    requiresAuth: true,
    requiresAdmin: true,
    responses: {
      '200': 'All uploads cleaned up successfully',
      '401': 'Authentication required',
      '403': 'Admin privileges required',
      '500': 'Failed to clean up uploads'
    }
  }
];

export default chunkedUploadEndpoints; 