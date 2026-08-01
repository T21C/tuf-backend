/**
 * Target level object is missing from object storage (DB metadata points at a dead key).
 * Expected client-facing miss — not an unexpected 500.
 */
export class LevelStorageMissingError extends Error {
    readonly statusCode = 404;

    constructor(public readonly levelPath: string) {
        super(`Level file not found in storage: ${levelPath}`);
        this.name = 'LevelStorageMissingError';
    }
}

export function isLevelStorageMissingError(error: unknown): error is LevelStorageMissingError {
    return error instanceof LevelStorageMissingError;
}
