export class ThumbnailRenderPendingError extends Error {
  constructor(readonly waitMs: number) {
    super(`Thumbnail render is still processing after ${waitMs}ms`);
    this.name = 'ThumbnailRenderPendingError';
  }
}

const inFlightGenerations = new Map<string, Promise<Buffer>>();

async function waitWithTimeout(promise: Promise<Buffer>, waitMs: number): Promise<Buffer> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<Buffer>((_, reject) => {
        timer = setTimeout(() => reject(new ThumbnailRenderPendingError(waitMs)), waitMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Share one in-flight produce() across concurrent HTTP requests.
 *
 * The HTTP wait (`waitMs`) may expire with ThumbnailRenderPendingError while
 * produce() keeps running. Callers must not start a second produce() for the
 * same key — that is what turned renderer timeouts into a CPU stampede.
 */
export async function awaitThumbnailGeneration(options: {
  key: string;
  waitMs: number;
  produce: () => Promise<Buffer>;
}): Promise<Buffer> {
  let generation = inFlightGenerations.get(options.key);
  if (!generation) {
    let current!: Promise<Buffer>;
    current = Promise.resolve()
      .then(() => options.produce())
      .finally(() => {
        if (inFlightGenerations.get(options.key) === current) {
          inFlightGenerations.delete(options.key);
        }
      });
    // Timed-out HTTP requests stop awaiting `current`. Keep a listener so a
    // later produce() failure cannot become an unhandledRejection.
    void current.catch(() => undefined);
    inFlightGenerations.set(options.key, current);
    generation = current;
  }

  return waitWithTimeout(generation, options.waitMs);
}
