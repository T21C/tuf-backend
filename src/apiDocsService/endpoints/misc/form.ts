import { EndpointDefinition } from '../../services/DocumentationService.js';

export const formEndpoints: EndpointDefinition[] = [
  {
    method: 'POST',
    path: '/v2/form/form-submit',
    category: 'SUBMISSIONS',
    description: 'Submit level or pass form with file upload',
    parameters: {
      headers: {
        'x-form-type': 'string (required) - Form type (level or pass)'
      },
      body: {
        levelZip: 'file (optional) - Level ZIP file for level submissions',
        artist: 'string (required) - Artist name',
        song: 'string (required) - Song title',
        videoLink: 'string (required) - Video link (YouTube/Bilibili)',
        directDL: 'string (optional) - Direct download link',
        description: 'string (optional) - Level description',
        difficulty: 'string (required) - Difficulty name',
        creatorRequests: 'array (optional) - Creator requests for level submissions',
        teamRequests: 'array (optional) - Team requests for level submissions',
        passId: 'number (required for pass submissions) - Pass ID',
        score: 'number (required for pass submissions) - Player score',
        accuracy: 'number (required for pass submissions) - Player accuracy',
        judgement: 'string (required for pass submissions) - Judgement type'
      }
    },
    responses: {
      '200': 'Submission created successfully',
      '400': 'Invalid submission data or duplicate submission',
      '403': 'User banned, submissions paused, or email not verified',
      '500': 'Server error processing submission'
    },
    requiresAuth: true
  }
];

export default formEndpoints; 