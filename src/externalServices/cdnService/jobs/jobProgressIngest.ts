import axios from 'axios';
import { logger } from '@/server/services/core/LoggerService.js';
import { getCdnMainServerApiBaseUrl } from '@/externalServices/cdnService/http/mainApiUrl.js';

const JOB_PROGRESS_PATH = '/v2/cdn/job-progress';
const DEFAULT_TIMEOUT_MS = 5000;
const PACK_TIMEOUT_MS = 8000;

/** Common `kind` values for Redis job docs (extend as new CDN workers appear). */
export const CDN_JOB_KIND = {
    LEVEL_UPLOAD: 'level_upload',
    IMAGE_UPLOAD: 'image_upload',
    PACK_DOWNLOAD: 'pack_download',
} as const;

export type CdnPipelineStatus = 'uploading' | 'processing' | 'caching' | 'completed' | 'failed';

export type EmitCdnJobProgressInput = EmitCdnPipelineJobProgressInput | EmitCdnPackDownloadJobProgressInput;

/** Long-running CDN asset work (level zip, images, future workers) ➔ main API job document. */
export interface EmitCdnPipelineJobProgressInput {
    variant: 'pipeline';
    jobId: string | undefined;
    /**
     * Redis job discriminator — use {@link CDN_JOB_KIND} or a new string agreed with main-app consumers.
     */
    kind: string;
    status: CdnPipelineStatus;
    percent: number;
    /** Progress line shown to users */
    message?: string;
    /** Required when `status === 'failed'` — becomes job `error` (poll / waitForJobCompletion) */
    error?: string;
    /** When `status === 'completed'` — stored in meta (key from {@link completedAssetMetaKey}) */
    completedAssetId?: string;
    /**
     * Meta key for the completed asset id. Defaults to `cdnFileId` (matches level uploads).
     */
    completedAssetMetaKey?: string;
    /** Merged into pipeline meta */
    meta?: Record<string, unknown>;
}

/** Pack zip generation jobs use a dedicated snapshot shape and HTTP timeout. */
export interface EmitCdnPackDownloadJobProgressInput {
    variant: 'pack';
    targetJobId: string;
    progress: PackDownloadProgressSnapshot;
}

/** Snapshot for pack progress (matches pack download route worker state). */
export interface PackDownloadProgressSnapshot {
    downloadId: string;
    cacheKey: string;
    status: 'pending' | 'processing' | 'zipping' | 'uploading' | 'completed' | 'failed';
    totalLevels: number;
    processedLevels: number;
    currentLevel?: string;
    /** R2 multipart upload byte progress (when status is `uploading`) */
    uploadLoaded?: number;
    uploadTotal?: number;
    error?: string;
    errorCode?: string;
    packUrl?: string;
    packZipName?: string;
    packExpiresAt?: string;
}

/** Level extraction uses 0–88%; zipping fixed 90%; R2 upload uses full 0–100 from bytes; completed 100%. */
const PACK_PERCENT_LEVEL_CAP = 88;
const PACK_PERCENT_ZIPPING = 90;

/**
 * **Single entry point** for the CDN service to push state to the main API job document
 * (`POST /v2/cdn/job-progress`). Use `variant: 'pipeline'` for any long-running ingest
 * (levels, images, future); use `variant: 'pack'` for pack downloads.
 */
export async function emitCdnJobProgress(input: EmitCdnJobProgressInput): Promise<void> {
    if (input.variant === 'pack') {
        if (!process.env.JOB_PROGRESS_INGEST_SECRET) {
            logger.debug('JOB_PROGRESS_INGEST_SECRET not set; skipping pack job progress ingest', {
                downloadId: input.targetJobId,
            });
            return;
        }
        const body = buildPackDownloadIngestPayload(input.targetJobId, input.progress);
        await postJobProgressHttp(body, PACK_TIMEOUT_MS);
        return;
    }

    if (!input.jobId) {
        return;
    }

    const body = buildPipelineIngestPayload(input);
    await postJobProgressHttp(body, DEFAULT_TIMEOUT_MS);
}

function pipelineStatusToPhase(status: CdnPipelineStatus): string {
    switch (status) {
        case 'completed':
            return 'cdn_ingest_done';
        case 'failed':
            return 'failed';
        case 'caching':
            return 'cdn_caching';
        default:
            return 'cdn_processing';
    }
}

function buildPipelineIngestPayload(input: EmitCdnPipelineJobProgressInput): Record<string, unknown> {
    const {
        jobId,
        kind,
        status,
        percent,
        message: messageIn,
        error: errorIn,
        completedAssetId,
        completedAssetMetaKey,
        meta: extraMeta,
    } = input;

    const phase = pipelineStatusToPhase(status);
    let message: string | undefined;
    let error: string | null;

    if (status === 'failed') {
        const detail =
            (errorIn && errorIn.length > 0 ? errorIn : undefined) ??
            (messageIn && messageIn.length > 0 ? messageIn : undefined);
        error = detail ?? 'Processing failed';
        message = messageIn && messageIn.length > 0 ? messageIn : error;
    } else {
        error = null;
        if (status === 'completed') {
            message =
                messageIn ??
                (kind === CDN_JOB_KIND.LEVEL_UPLOAD ? 'CDN ingest complete' : 'Processing complete');
        } else {
            message = messageIn;
        }
    }

    const meta = buildPipelineMeta(kind, status, completedAssetId, completedAssetMetaKey, extraMeta);

    return {
        jobId,
        kind,
        phase,
        percent: status === 'failed' ? null : percent,
        message,
        error,
        meta,
    };
}

function buildPipelineMeta(
    kind: string,
    status: CdnPipelineStatus,
    completedAssetId: string | undefined,
    completedAssetMetaKey: string | undefined,
    extraMeta: Record<string, unknown> | undefined
): Record<string, unknown> {
    const idKey = completedAssetMetaKey ?? 'cdnFileId';

    if (kind === CDN_JOB_KIND.LEVEL_UPLOAD) {
        if (status === 'completed' && completedAssetId) {
            return {cdnFileId: completedAssetId, stage: 'cdn_ingest', ...(extraMeta ?? {})};
        }
        return {stage: 'cdn_ingest', ingestStatus: status, ...(extraMeta ?? {})};
    }

    if (status === 'completed' && completedAssetId) {
        return {
            [idKey]: completedAssetId,
            stage: 'cdn_pipeline',
            pipelineKind: kind,
            ...(extraMeta ?? {}),
        };
    }

    return {
        stage: 'cdn_pipeline',
        pipelineKind: kind,
        ingestStatus: status,
        ...(extraMeta ?? {}),
    };
}

function packProgressToPhase(status: PackDownloadProgressSnapshot['status']): string {
    switch (status) {
        case 'completed':
            return 'completed';
        case 'failed':
            return 'failed';
        default:
            return status;
    }
}

function packProgressToPercent(progress: PackDownloadProgressSnapshot): number | null {
    if (progress.status === 'failed') {
        return null;
    }
    if (progress.status === 'completed') {
        return 100;
    }

    const {status, totalLevels, processedLevels, uploadLoaded, uploadTotal} = progress;

    if (status === 'pending' || status === 'processing') {
        if (totalLevels > 0) {
            return Math.min(
                PACK_PERCENT_LEVEL_CAP,
                Math.round((processedLevels / totalLevels) * PACK_PERCENT_LEVEL_CAP)
            );
        }
        return 0;
    }

    if (status === 'zipping') {
        return PACK_PERCENT_ZIPPING;
    }

    if (status === 'uploading') {
        if (
            typeof uploadLoaded === 'number' &&
            typeof uploadTotal === 'number' &&
            uploadTotal > 0
        ) {
            return Math.min(100, Math.round((uploadLoaded / uploadTotal) * 100));
        }
        return 0;
    }

    return 0;
}

function packFallbackStatusMessage(
    status: PackDownloadProgressSnapshot['status']
): string | undefined {
    switch (status) {
        case 'pending':
            return 'Preparing pack…';
        case 'zipping':
            return 'Creating pack archive…';
        case 'uploading':
            return 'Uploading pack to storage…';
        default:
            return undefined;
    }
}

function buildPackDownloadIngestPayload(
    targetJobId: string,
    progress: PackDownloadProgressSnapshot
): Record<string, unknown> {
    const phase = packProgressToPhase(progress.status);
    const percent = packProgressToPercent(progress);

    const meta: Record<string, unknown> = {
        cacheKey: progress.cacheKey,
        totalLevels: progress.totalLevels,
        processedLevels: progress.processedLevels,
        ingestStatus: progress.status,
    };
    if (progress.currentLevel) {
        meta.currentLevel = progress.currentLevel;
    }
    if (progress.packUrl) {
        meta.url = progress.packUrl;
    }
    if (progress.packZipName) {
        meta.zipName = progress.packZipName;
    }
    if (progress.packExpiresAt) {
        meta.expiresAt = progress.packExpiresAt;
    }
    if (progress.errorCode) {
        meta.code = progress.errorCode;
    }
    if (
        typeof progress.uploadLoaded === 'number' &&
        typeof progress.uploadTotal === 'number' &&
        progress.uploadTotal > 0
    ) {
        meta.uploadBytesLoaded = progress.uploadLoaded;
        meta.uploadBytesTotal = progress.uploadTotal;
    }

    const message =
        progress.currentLevel ??
        packFallbackStatusMessage(progress.status) ??
        (progress.status === 'completed'
            ? 'Pack ready'
            : progress.status === 'failed'
              ? 'Pack generation failed'
              : undefined);

    const errField = progress.status === 'failed' ? (progress.error ?? 'Pack generation failed') : null;

    return {
        jobId: targetJobId,
        kind: CDN_JOB_KIND.PACK_DOWNLOAD,
        phase,
        percent,
        message,
        error: errField,
        meta,
    };
}

async function postJobProgressHttp(body: Record<string, unknown>, timeoutMs: number): Promise<void> {
    const secret = process.env.JOB_PROGRESS_INGEST_SECRET;
    if (!secret) {
        return;
    }

    const baseUrl = getCdnMainServerApiBaseUrl();

    try {
        await axios.post(`${baseUrl}${JOB_PROGRESS_PATH}`, body, {
            headers: {'X-Job-Ingest-Key': secret},
            timeout: timeoutMs,
        });
    } catch (err) {
        logger.debug('Failed to send job progress ingest', {
            jobId: typeof body.jobId === 'string' ? body.jobId : undefined,
            kind: typeof body.kind === 'string' ? body.kind : undefined,
            error: err instanceof Error ? err.message : String(err),
        });
    }
}
