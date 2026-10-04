/**
 * Stable, client-safe failure codes. LibreChat maps `unsupported_capability` to a permanent
 * capability error and reads `retry_after_seconds` on `rate_limited`; everything else is
 * surfaced by HTTP status. Messages here are written for the client, never copied from upstream.
 */
export type ErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'invalid_request'
  | 'not_found'
  | 'input_file_not_found'
  | 'payload_too_large'
  | 'unsupported_capability'
  | 'rate_limited'
  | 'sandbox_unavailable'
  | 'sandbox_setup_failed'
  | 'continuation_invalid'
  | 'internal_error';

export class ServiceError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly retryAfterSeconds?: number;

  constructor(status: number, code: ErrorCode, message: string, retryAfterSeconds?: number) {
    super(message);
    this.name = 'ServiceError';
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export const invalid = (message: string): ServiceError =>
  new ServiceError(400, 'invalid_request', message);

export const notFound = (message = 'Not found'): ServiceError =>
  new ServiceError(404, 'not_found', message);

export const rateLimited = (retryAfterSeconds: number): ServiceError =>
  new ServiceError(429, 'rate_limited', 'Too many concurrent executions', retryAfterSeconds);

export const sandboxUnavailable = (): ServiceError =>
  new ServiceError(502, 'sandbox_unavailable', 'Code interpreter is unavailable');
