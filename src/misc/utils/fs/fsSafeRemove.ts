import fs from 'fs';
import path from 'path';

/**
 * Returns true if `absCandidate` is `absRoot` or lives under it.
 * Both inputs must be already resolved to absolute paths.
 */
export function isPathUnderRoot(absCandidate: string, absRoot: string): boolean {
  const rootWithSep = absRoot.endsWith(path.sep) ? absRoot : absRoot + path.sep;
  return absCandidate === absRoot || absCandidate.startsWith(rootWithSep);
}

/**
 * Recursive remove that refuses to operate outside the configured root.
 * Caller passes the absolute root that bounds where this helper is allowed to delete.
 */
export async function safeRemoveUnderRoot(targetPath: string, allowedRoot: string): Promise<void> {
  const absTarget = path.resolve(targetPath);
  const absRoot = path.resolve(allowedRoot);
  if (!isPathUnderRoot(absTarget, absRoot)) {
    throw new Error(`Refusing to remove path outside allowed root: ${absTarget}`);
  }
  await fs.promises.rm(absTarget, { recursive: true, force: true });
  await pruneEmptyParentsUnderRoot(absTarget, absRoot).catch(() => Promise.resolve());
}

/**
 * Best-effort remove of empty parents up to (but not including) `allowedRoot`.
 * Stops on the first non-empty parent (rmdir throws ENOTEMPTY).
 */
async function pruneEmptyParentsUnderRoot(startDir: string, allowedRoot: string): Promise<void> {
  let parent = path.dirname(path.resolve(startDir));
  const absRoot = path.resolve(allowedRoot);
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
