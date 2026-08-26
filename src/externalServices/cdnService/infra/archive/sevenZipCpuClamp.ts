/**
 * CPU clamps for 7-Zip children.
 *
 * Pack downloads spawn many `7z` processes. Without `-mmt`, each child uses every
 * host core. Compose `cpus` is the hard cgroup cap; these switches keep each child
 * from oversubscribing inside that quota so the Node event loop still gets time.
 */

const ENV_THREADS = 'CDN_7Z_THREADS';
const DEFAULT_THREADS = 2;
const MAX_THREADS = 8;

/** CFS niceness for 7z children (higher = lower priority than the CDN Node process). */
export const SEVEN_ZIP_CHILD_NICE = 10;

export function resolveSevenZipThreadCount(env: NodeJS.ProcessEnv = process.env): number {
    const raw = env[ENV_THREADS]?.trim();
    if (!raw) {
        return DEFAULT_THREADS;
    }
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n < 1) {
        return DEFAULT_THREADS;
    }
    return Math.min(n, MAX_THREADS);
}

export function sevenZipThreadArg(env: NodeJS.ProcessEnv = process.env): string {
    return `-mmt=${resolveSevenZipThreadCount(env)}`;
}

function argsAlreadySetThreadLimit(args: readonly string[]): boolean {
    return args.some(
        (a) => a === '-mmt' || a.startsWith('-mmt=') || /^-mmt\d+$/.test(a),
    );
}

/**
 * Insert `-mmt=N` after the 7z command verb so list/extract/create all share one thread cap.
 */
export function withSevenZipThreadLimit(
    args: readonly string[],
    env: NodeJS.ProcessEnv = process.env,
): string[] {
    if (argsAlreadySetThreadLimit(args)) {
        return [...args];
    }
    const threadArg = sevenZipThreadArg(env);
    if (args.length > 0 && !args[0]!.startsWith('-')) {
        return [args[0]!, threadArg, ...args.slice(1)];
    }
    return [threadArg, ...args];
}
