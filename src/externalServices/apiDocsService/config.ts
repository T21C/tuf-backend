import dotenv from 'dotenv';
dotenv.config();

if (!process.env.API_DOCS_PORT) {
    throw new Error('API_DOCS_PORT must be set');
}

if (!process.env.API_DOCS_URL) {
    throw new Error('API_DOCS_URL must be set');
}

export const API_DOCS_CONFIG = {
    port: process.env.API_DOCS_PORT,
    title: 'TUF API Documentation',
    version: '2.0.0',
    description: 'API documentation for The Universal Forums (TUF)',
    baseUrl: process.env.API_DOCS_URL,
    contact: {
        name: 'TUF Development Team',
        email: 'https://discord.com/invite/adofai'
    },
    license: {
        name: 'MIT',
        url: 'https://opensource.org/licenses/MIT'
    }
} as const;

// API endpoint categories
export const API_CATEGORIES = {
    AUTH: {
        name: 'Authentication',
        description: 'User authentication and authorization endpoints',
        color: '#8f7dea'
    },
    LEVELS: {
        name: 'Levels',
        description: 'Level management and retrieval endpoints',
        color: '#69db7c'
    },
    PASSES: {
        name: 'Passes',
        description: 'Pass management, search, and announcement endpoints',
        color: '#20c997'
    },
    CREATORS: {
        name: 'Creators',
        description: 'Creator and team management endpoints',
        color: '#fd7e14'
    },
    DIFFICULTIES: {
        name: 'Difficulties',
        description: 'Difficulty management and configuration endpoints',
        color: '#6f42c1'
    },
    PLAYERS: {
        name: 'Players',
        description: 'Player profiles and statistics endpoints',
        color: '#4dabf7'
    },
    SUBMISSIONS: {
        name: 'Submissions',
        description: 'Level and pass submission endpoints',
        color: '#ffd43b'
    },
    MEDIA: {
        name: 'Media',
        description: 'File upload and media management endpoints',
        color: '#ff922b'
    },
    UTILS: {
        name: 'Utilities',
        description: 'Utility and helper endpoints',
        color: '#ae3ec9'
    },
    ADMIN: {
        name: 'Admin',
        description: 'Admin endpoints',
        color: '#ff0000'
    },
    PACKS: {
        name: 'Packs',
        description: 'Pack management and retrieval endpoints',
        color: '#ffd43b'
    }
} as const;

export type ApiCategory = keyof typeof API_CATEGORIES;
