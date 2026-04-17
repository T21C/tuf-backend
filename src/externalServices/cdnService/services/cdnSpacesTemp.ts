import path from 'path';
import { withWorkspace, type WorkspaceDomain } from '@/server/services/core/WorkspaceService.js';

/**
 * Legacy wrapper around the shared {@link withWorkspace} primitive so existing CDN call sites
 * that were organised around `(domain, cdnFileId)` keep working unchanged. All new code should
 * call `withWorkspace(...)` directly — this module exists only to route through the unified
 * `WORKSPACE_ROOT` tree and the shutdown coordinator integration.
 */

/** Operation-type scope. Values map 1:1 to {@link WorkspaceDomain}. */
export const CdnSpacesTempDomain = {
    LevelCache: 'level-cache' as const,
    LevelsRouteModes: 'levels-route-modes' as const,
    LevelsRouteRepack: 'levels-route-repack' as const,
    LevelsRouteMisc: 'levels-route-misc' as const
} as const;

export type CdnSpacesTempDomainKey = (typeof CdnSpacesTempDomain)[keyof typeof CdnSpacesTempDomain];

export interface CdnFileDomainWorkspaceContext {
    dir: string;
    join: (...parts: string[]) => string;
}

/**
 * Create a workspace keyed on (domain, cdnFileId), run `fn`, then guarantee removal. Delegates
 * to {@link withWorkspace} so all temp dirs land under the unified `WORKSPACE_ROOT` and participate
 * in the shutdown coordinator's abort-and-clean flow.
 */
export async function withCdnFileDomainWorkspace<T>(
    domain: WorkspaceDomain,
    fileId: string,
    fn: (ctx: CdnFileDomainWorkspaceContext) => Promise<T>
): Promise<T> {
    return withWorkspace(
        domain,
        async (ws) => {
            const ctx: CdnFileDomainWorkspaceContext = {
                dir: ws.dir,
                join: (...parts: string[]) => path.join(ws.dir, ...parts)
            };
            return fn(ctx);
        },
        { key: fileId }
    );
}
