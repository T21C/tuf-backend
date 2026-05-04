/** Bad or empty user archive — safe to show to the user; omit from server error logs ({@link skipLogging}). */
export class CdnIngestUserError extends Error {
    readonly skipLogging = true as const;
    constructor(message: string) {
        super(message);
        this.name = 'CdnIngestUserError';
        Object.setPrototypeOf(this, CdnIngestUserError.prototype);
    }
}
