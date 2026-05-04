import { CdnIngestUserError } from '@/externalServices/cdnService/jobs/cdnIngestErrors.js';

export type ZipIngestServerLogDisposition = 'none' | 'info' | 'error';

export interface ZipIngestErrorClassification {
    /** Message suitable for job `error` / user display */
    userMessage: string;
    /** How the CDN service should log this failure */
    serverLog: ZipIngestServerLogDisposition;
}

/**
 * Maps thrown errors from zip ingest / archive processing to logging and user-visible text.
 * Keeps policy out of route handlers and duplicate instanceof chains.
 */
export function classifyZipIngestError(error: unknown): ZipIngestErrorClassification {
    const userMessage =
        error instanceof Error ? error.message : typeof error === 'string' ? error : String(error);

    if (error instanceof CdnIngestUserError) {
        return {userMessage, serverLog: 'none'};
    }

    if (error instanceof Error && 'skipLogging' in error && (error as Error & {skipLogging?: boolean}).skipLogging) {
        return {userMessage, serverLog: 'none'};
    }

    const anyErr = error as Error & {
        clientFacing?: boolean;
        userMessage?: string;
    };
    if (anyErr?.clientFacing) {
        const msg =
            typeof anyErr.userMessage === 'string' && anyErr.userMessage.trim() !== ''
                ? anyErr.userMessage.trim()
                : userMessage;
        return {userMessage: msg, serverLog: 'info'};
    }

    return {userMessage, serverLog: 'error'};
}
