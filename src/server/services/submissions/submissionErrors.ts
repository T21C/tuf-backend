export class FormError extends Error {
  readonly code: number;
  readonly details?: Record<string, unknown>;
  readonly field?: string;
  readonly denialReason?: string;
  constructor(code: number, message: string, opts: {
    details?: Record<string, unknown>;
    field?: string;
    denialReason?: string;
  } = {}) {
    super(message);
    this.name = 'FormError';
    this.code = code;
    this.details = opts.details;
    this.field = opts.field;
    this.denialReason = opts.denialReason;
  }
}

export const formError = {
  bad: (message: string, opts?: { details?: Record<string, unknown>; field?: string }) =>
    new FormError(400, message, opts),
  unauth: (message = 'User not authenticated') => new FormError(401, message),
  forbid: (message: string, denialReason?: string) => new FormError(403, message, { denialReason }),
  notFound: (message: string) => new FormError(404, message),
  conflict: (message: string, opts?: { details?: Record<string, unknown>; field?: string }) =>
    new FormError(409, message, opts),
  server: (message = 'Internal server error', opts?: { details?: Record<string, unknown> }) =>
    new FormError(500, message, opts),
};
