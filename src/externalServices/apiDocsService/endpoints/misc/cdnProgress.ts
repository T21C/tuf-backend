import { EndpointDefinition } from '../../services/DocumentationService.js';

export const cdnProgressEndpoints: EndpointDefinition[] = [
  {
    method: 'POST',
    path: '/v2/misc/cdn/pack-progress',
    description: 'Receive progress updates from CDN service for pack downloads. Used internally by CDN service to report pack download/zip progress via SSE.',
    category: 'MEDIA',
    parameters: {
      body: {
        downloadId: 'string (required) - Unique download ID',
        cacheKey: 'string (required) - Cache key for the pack',
        status: 'string (required) - Status: "pending" | "processing" | "zipping" | "uploading" | "completed" | "failed"',
        totalLevels: 'number (required) - Total number of levels in pack',
        processedLevels: 'number (required) - Number of levels processed',
        currentLevel: 'string (optional) - Name of current level being processed',
        progressPercent: 'number (required) - Progress percentage (0-100)',
        error: 'string (optional) - Error message if status is "failed"'
      }
    },
    responses: {
      '200': 'Returns { success: true }',
      '400': 'Missing required fields',
      '500': 'Failed to process progress update'
    }
  },
  {
    method: 'POST',
    path: '/v2/misc/cdn/level-upload-progress',
    description: 'Receive progress updates from CDN service for level uploads. Used internally by CDN service to report level upload progress via SSE.',
    category: 'MEDIA',
    parameters: {
      body: {
        uploadId: 'string (required) - Unique upload ID',
        status: 'string (required) - Status: "uploading" | "processing" | "caching" | "completed" | "failed"',
        progressPercent: 'number (required) - Progress percentage (0-100)',
        currentStep: 'string (optional) - Current step description',
        error: 'string (optional) - Error message if status is "failed"'
      }
    },
    responses: {
      '200': 'Returns { success: true }',
      '400': 'Missing required fields',
      '500': 'Failed to process progress update'
    }
  }
];

export default cdnProgressEndpoints;
