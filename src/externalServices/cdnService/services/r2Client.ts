import AWS from 'aws-sdk';

export interface R2CredentialsAndEndpoint {
    accessKeyId: string;
    secretAccessKey: string;
    endpoint: string;
}

export function resolveR2Endpoint(): string | undefined {
    const fromEnv = process.env.CF_R2_S3_ENDPOINT?.trim();
    const accountId = process.env.CF_ACCOUNT_ID?.trim();
    if (fromEnv) {
        return fromEnv.replace(/\/+$/, '');
    }
    if (accountId) {
        return `https://${accountId}.r2.cloudflarestorage.com`;
    }
    return undefined;
}

export function loadR2CredentialsAndEndpoint(): R2CredentialsAndEndpoint | null {
    const accessKeyId = process.env.CF_ACCESS_KEY;
    const secretAccessKey = process.env.CF_SECRET_KEY;
    const endpoint = resolveR2Endpoint();
    if (!accessKeyId || !secretAccessKey || !endpoint) {
        return null;
    }
    return { accessKeyId, secretAccessKey, endpoint };
}

/**
 * Credentials for BackupService only. Falls back to main CDN keys so one token can cover both buckets
 * if the Cloudflare R2 API token is scoped to the whole account (or both buckets).
 * Use CF_BACKUP_ACCESS_KEY / CF_BACKUP_SECRET_KEY when the main token is bucket-scoped to CF_BUCKET only.
 */
export function loadBackupR2CredentialsAndEndpoint(): R2CredentialsAndEndpoint | null {
    const accessKeyId =
        process.env.CF_BACKUP_ACCESS_KEY?.trim() || process.env.CF_ACCESS_KEY;
    const secretAccessKey =
        process.env.CF_BACKUP_SECRET_KEY?.trim() || process.env.CF_SECRET_KEY;
    const endpoint = resolveR2Endpoint();
    if (!accessKeyId || !secretAccessKey || !endpoint) {
        return null;
    }
    return { accessKeyId, secretAccessKey, endpoint };
}

export function createR2S3(creds: R2CredentialsAndEndpoint): AWS.S3 {
    return new AWS.S3({
        accessKeyId: creds.accessKeyId,
        secretAccessKey: creds.secretAccessKey,
        endpoint: creds.endpoint,
        region: 'auto',
        s3ForcePathStyle: true,
        signatureVersion: 'v4'
    });
}

function normalizeCdnBase(url: string): string {
    return url.trim().replace(/\/+$/, '');
}

/** Main CDN bucket: requires public URL base for getFileUrl(). */
export function requireCdnR2StorageConfig(): {
    s3: AWS.S3;
    bucket: string;
    publicCdnBase: string;
} {
    const creds = loadR2CredentialsAndEndpoint();
    const bucket = process.env.CF_BUCKET?.trim();
    const publicRaw = process.env.STORAGE_PUBLIC_CDN_BASE?.trim();

    if (!creds || !bucket) {
        throw new Error(
            'Missing R2 CDN storage env: CF_ACCESS_KEY, CF_SECRET_KEY, CF_BUCKET, and CF_ACCOUNT_ID or CF_R2_S3_ENDPOINT'
        );
    }
    if (!publicRaw) {
        throw new Error('Missing STORAGE_PUBLIC_CDN_BASE (public CDN hostname for object URLs)');
    }

    return {
        s3: createR2S3(creds),
        bucket,
        publicCdnBase: normalizeCdnBase(publicRaw)
    };
}

/** Backup uploads: same R2 account endpoint; optional CF_BACKUP_BUCKET and optional backup-only API token. */
export function requireBackupR2Config(): { s3: AWS.S3; bucket: string } {
    const creds = loadBackupR2CredentialsAndEndpoint();
    const bucket =
        process.env.CF_BACKUP_BUCKET?.trim() || process.env.CF_BUCKET?.trim() || '';

    if (!creds || !bucket) {
        throw new Error(
            'Missing backup R2 env: CF_ACCESS_KEY, CF_SECRET_KEY, CF_BACKUP_BUCKET or CF_BUCKET, and CF_ACCOUNT_ID or CF_R2_S3_ENDPOINT'
        );
    }

    return { s3: createR2S3(creds), bucket };
}
