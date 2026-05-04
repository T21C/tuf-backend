/**
 * Base URL for the main TUF API (used by the CDN service to call job-progress and related ingest routes).
 */
export function getCdnMainServerApiBaseUrl(): string {
    if (process.env.NODE_ENV === 'production') {
        return process.env.PROD_API_URL || 'http://localhost:3000';
    }
    if (process.env.NODE_ENV === 'staging') {
        return process.env.STAGING_API_URL || 'http://localhost:3000';
    }
    return process.env.DEV_URL || 'http://localhost:3002';
}
