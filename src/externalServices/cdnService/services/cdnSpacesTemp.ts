import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { CDN_CONFIG } from '../config.js';

/** Random segment for per-invocation isolation under a CDN file (default for {@link withCdnFileDomainWorkspace}). */
export function createCdnTempRunId(): string {
    return crypto.randomBytes(8).toString('hex');
}

/** Root for all CDN Spaces temp workspaces: under {@link CDN_CONFIG.localRoot}/tuf-cdn-spaces. */
export const CDN_SPACES_TEMP_ROOT = path.join(path.resolve(CDN_CONFIG.localRoot), 'tuf-cdn-spaces');

/**
 * Operation-type scope under `tuf-cdn-spaces/<scope>/...` so different features never share a tree.
 */
export const CdnSpacesTempDomain = {
    LevelCache: 'level-cache',
    /** Route: GET level data with modes (cached fields + optional heavy modes). */
    LevelsRouteModes: 'levels-route-modes',
    /** Route: repack / transform flows under levels router. */
    LevelsRouteRepack: 'levels-route-repack',
    /** Route: one-off level download / options parsing. */
    LevelsRouteMisc: 'levels-route-misc'
} as const;

export type CdnSpacesTempDomainKey = (typeof CdnSpacesTempDomain)[keyof typeof CdnSpacesTempDomain];

/**
 * `tuf-cdn-spaces/<scope>/<cdnFileId>/` or `.../<scope>/<cdnFileId>/<runId>/`.
 * Order is **scope (domain) first**, then **CDN entry id (uuid)**, then optional session id.
 */
export function workspaceDirForDomain(domain: string, fileId: string, runId?: string): string {
    if (runId) {
        return path.join(CDN_SPACES_TEMP_ROOT, domain, fileId, runId);
    }
    return path.join(CDN_SPACES_TEMP_ROOT, domain, fileId);
}

function isPathUnderRoot(absCandidate: string, absRoot: string): boolean {
    const rootWithSep = absRoot.endsWith(path.sep) ? absRoot : absRoot + path.sep;
    return absCandidate === absRoot || absCandidate.startsWith(rootWithSep);
}

/**
 * Remove a directory only if it lies under {@link CDN_SPACES_TEMP_ROOT}.
 */
export async function removeScopedDirIfUnderRoot(dirPath: string): Promise<void> {
    const absTarget = path.resolve(dirPath);
    const absRoot = path.resolve(CDN_SPACES_TEMP_ROOT);
    if (!isPathUnderRoot(absTarget, absRoot)) {
        throw new Error(`Refusing to remove path outside CDN temp root: ${absTarget}`);
    }
    await fs.promises.rm(absTarget, { recursive: true, force: true });
    await pruneEmptyParentsUnderRoot(absTarget).catch(() => Promise.resolve());
}

/** Best-effort remove empty parents up to (but not including) {@link CDN_SPACES_TEMP_ROOT}. */
async function pruneEmptyParentsUnderRoot(startDir: string): Promise<void> {
    let parent = path.dirname(path.resolve(startDir));
    const absRoot = path.resolve(CDN_SPACES_TEMP_ROOT);
    while (parent !== absRoot) {
        const absParent = path.resolve(parent);
        if (!isPathUnderRoot(absParent, absRoot)) {
            break;
        }
        try {
            await fs.promises.rmdir(parent);
        } catch {
            break;
        }
        parent = path.dirname(parent);
    }
}

export interface CdnFileDomainWorkspaceContext {
    dir: string;
    join: (...parts: string[]) => string;
}

/**
 * Create `tuf-cdn-spaces/<scope>/<cdnFileId>/<runId>/`, run `fn`, then delete that directory tree (the whole session folder).
 * `runId` defaults to {@link createCdnTempRunId} so concurrent work for the same file under the same scope never shares a folder.
 */
export async function withCdnFileDomainWorkspace<T>(
    domain: string,
    fileId: string,
    fn: (ctx: CdnFileDomainWorkspaceContext) => Promise<T>
): Promise<T> {
    const runId = createCdnTempRunId();
    const dir = workspaceDirForDomain(domain, fileId, runId);
    await fs.promises.mkdir(dir, { recursive: true });
    const join = (...parts: string[]) => path.join(dir, ...parts);
    try {
        return await fn({ dir, join });
    } finally {
        await removeScopedDirIfUnderRoot(dir).catch(() => Promise.resolve());
    }
}
