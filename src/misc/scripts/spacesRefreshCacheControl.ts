/**
 * List objects under an R2 prefix and copy each object onto itself with MetadataDirective REPLACE,
 * preserving Content-Type, Content-* headers, and user Metadata from headObject; only Cache-Control changes.
 *
 * Requires in .env: CF_ACCESS_KEY, CF_SECRET_KEY, CF_BUCKET, CF_ACCOUNT_ID or CF_R2_S3_ENDPOINT
 * Optional: SPACES_CACHE_CONTROL, SPACES_CONCURRENCY (default 8)
 *
 * Usage (from server/):
 *   npx tsx src/misc/scripts/spacesRefreshCacheControl.ts images/curation_icon/
 *   npx tsx src/misc/scripts/spacesRefreshCacheControl.ts images/curation_icon/ --concurrency 16
 *   npx tsx src/misc/scripts/spacesRefreshCacheControl.ts images/curation_icon/ --dry-run
 *
 */

import AWS from 'aws-sdk';
import dotenv from 'dotenv';
import {
    createR2S3,
    loadR2CredentialsAndEndpoint
} from '@/externalServices/cdnService/services/r2Client.js';

dotenv.config();

const DEFAULT_CACHE_CONTROL = 'public, max-age=31536000, immutable';
const DEFAULT_CONCURRENCY = 64;

/** Bounded parallel map (single-threaded scheduling; safe index handoff). */
async function mapWithConcurrency<T>(
    items: readonly T[],
    concurrency: number,
    fn: (item: T) => Promise<void>
): Promise<void> {
    if (items.length === 0) {
        return;
    }
    const n = Math.min(Math.max(1, concurrency), items.length);
    let index = 0;
    const worker = async () => {
        while (true) {
            const i = index++;
            if (i >= items.length) {
                return;
            }
            await fn(items[i]);
        }
    };
    await Promise.all(Array.from({ length: n }, () => worker()));
}

function parseArgs(argv: string[]): {
    positional: string[];
    dryRun: boolean;
    concurrency: number;
} {
    const positional: string[] = [];
    let dryRun = false;
    let concurrency =
        Number.parseInt(String(process.env.SPACES_CONCURRENCY ?? ''), 10) || DEFAULT_CONCURRENCY;

    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--dry-run') {
            dryRun = true;
            continue;
        }
        if (a === '--concurrency' && argv[i + 1] !== undefined) {
            const c = Number.parseInt(argv[i + 1], 10);
            if (!Number.isNaN(c) && c >= 1) {
                concurrency = c;
            }
            i++;
            continue;
        }
        positional.push(a);
    }

    return { positional, dryRun, concurrency };
}

function loadClient(): { s3: AWS.S3; bucket: string } {
    const creds = loadR2CredentialsAndEndpoint();
    const bucket = process.env.CF_BUCKET?.trim();

    if (!creds || !bucket) {
        throw new Error(
            'Missing CF_ACCESS_KEY, CF_SECRET_KEY, CF_BUCKET, and CF_ACCOUNT_ID or CF_R2_S3_ENDPOINT in environment / .env'
        );
    }

    return { s3: createR2S3(creds), bucket };
}

/** S3 CopySource: bucket + URL-encoded full key (slashes in key become %2F). */
function copySourceValue(bucket: string, key: string): string {
    return `${bucket}/${encodeURIComponent(key)}`;
}

/**
 * Normalize Cache-Control for comparison (directive order and spacing should not force a rewrite).
 */
function normalizeCacheControl(value: string): string {
    return value
        .split(',')
        .map((part) => part.trim().toLowerCase().replace(/\s+/g, ' '))
        .filter(Boolean)
        .sort()
        .join(', ');
}

function metadataFromHead(head: AWS.S3.HeadObjectOutput): Record<string, string> | undefined {
    const raw = head.Metadata;
    if (!raw || typeof raw !== 'object') {
        return undefined;
    }
    const entries = Object.entries(raw).filter(([, v]) => v != null && String(v) !== '');
    if (entries.length === 0) {
        return undefined;
    }
    return Object.fromEntries(entries.map(([k, v]) => [k, String(v)]));
}

/**
 * Subset of headObject fields that are valid copyObject inputs.
 * Head also returns ETag, LastModified, ContentLength, VersionId, Restore, etc. — those are
 * read-only / wrong for CopyObject and can confuse the API or get rejected.
 */
function pickCopyFieldsFromHead(head: AWS.S3.HeadObjectOutput): Partial<AWS.S3.CopyObjectRequest> {
    const out: Partial<AWS.S3.CopyObjectRequest> = {};
    if (head.ContentType) {
        out.ContentType = head.ContentType;
    }
    if (head.ContentEncoding) {
        out.ContentEncoding = head.ContentEncoding;
    }
    if (head.ContentDisposition) {
        out.ContentDisposition = head.ContentDisposition;
    }
    if (head.ContentLanguage) {
        out.ContentLanguage = head.ContentLanguage;
    }
    if (head.Expires) {
        out.Expires = head.Expires;
    }
    if (head.WebsiteRedirectLocation) {
        out.WebsiteRedirectLocation = head.WebsiteRedirectLocation;
    }
    if (head.StorageClass && head.StorageClass !== 'STANDARD') {
        out.StorageClass = head.StorageClass;
    }
    const meta = metadataFromHead(head);
    if (meta) {
        out.Metadata = meta;
    }
    return out;
}

type RefreshResult = 'copied' | 'skipped' | 'dry-run-copy' | 'dry-run-skip';

async function refreshOne(
    s3: AWS.S3,
    bucket: string,
    key: string,
    cacheControl: string,
    dryRun: boolean
): Promise<RefreshResult> {
    const head = await s3.headObject({ Bucket: bucket, Key: key }).promise();

    const desiredNorm = normalizeCacheControl(cacheControl);
    const currentNorm = head.CacheControl ? normalizeCacheControl(head.CacheControl) : '';

    if (currentNorm === desiredNorm) {
        if (dryRun) {
            console.log('[dry-run] skip (cache already set)', key);
            return 'dry-run-skip';
        }
        console.log('skip', key);
        return 'skipped';
    }

    const params: AWS.S3.CopyObjectRequest = {
        Bucket: bucket,
        Key: key,
        CopySource: copySourceValue(bucket, key),
        MetadataDirective: 'REPLACE',
        CacheControl: cacheControl,
        ...pickCopyFieldsFromHead(head)
    };

    if (dryRun) {
        console.log('[dry-run] would copy', key);
        return 'dry-run-copy';
    }

    await s3.copyObject(params).promise();
    console.log('OK', key);
    return 'copied';
}

function normalizePrefix(prefix: string): string {
    const trimmed = prefix.trim().replace(/^\/+/, '');
    return trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
}

async function main(): Promise<void> {
    const { positional, dryRun, concurrency } = parseArgs(process.argv.slice(2));
    const prefixArg = positional[0];

    if (!prefixArg) {
        console.error('Usage: tsx src/misc/scripts/spacesRefreshCacheControl.ts <prefix> [--dry-run] [--concurrency N]');
        console.error('Env: SPACES_CONCURRENCY (default 8), SPACES_CACHE_CONTROL');
        console.error('Example: tsx src/misc/scripts/spacesRefreshCacheControl.ts images/curation_icon/ --concurrency 16');
        process.exit(1);
    }

    const prefix = normalizePrefix(prefixArg);
    const cacheControl = process.env.SPACES_CACHE_CONTROL ?? DEFAULT_CACHE_CONTROL;

    const { s3, bucket } = loadClient();

    console.log(`Concurrency: ${concurrency}${dryRun ? ' (dry-run)' : ''}`);

    let continuationToken: string | undefined;
    let copied = 0;
    let skipped = 0;

    do {
        const page = await s3
            .listObjectsV2({
                Bucket: bucket,
                Prefix: prefix,
                MaxKeys: 1000,
                ContinuationToken: continuationToken
            })
            .promise();

        const keys = (page.Contents ?? [])
            .map((o) => o.Key)
            .filter((k): k is string => Boolean(k));

        await mapWithConcurrency(keys, concurrency, async (key) => {
            const result = await refreshOne(s3, bucket, key, cacheControl, dryRun);
            if (result === 'copied' || result === 'dry-run-copy') {
                copied++;
            } else {
                skipped++;
            }
        });

        continuationToken = page.NextContinuationToken;
    } while (continuationToken);

    const verb = dryRun ? 'Would copy' : 'Copied';
    console.log(
        `Done. ${verb} ${copied}, skipped ${skipped} (already had target Cache-Control) under prefix "${prefix}".`
    );
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
