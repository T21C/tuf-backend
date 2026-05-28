/**
 * Limits how many async tasks run at once. Tasks beyond the limit wait in FIFO order.
 */
export function createAsyncPool(concurrency: number) {
    const limit = Math.max(1, Math.floor(concurrency));
    let active = 0;
    const waiters: Array<() => void> = [];

    const release = (): void => {
        active -= 1;
        const next = waiters.shift();
        if (next) {
            next();
        }
    };

    return async function runPoolTask<T>(task: () => Promise<T>): Promise<T> {
        if (active >= limit) {
            await new Promise<void>((resolve) => {
                waiters.push(resolve);
            });
        }

        active += 1;
        try {
            return await task();
        } finally {
            release();
        }
    };
}
