/**
 * Error types used to tell the three kinds of failure apart:
 *   - FatalError: the whole run cannot continue (bad config, unreadable CSV).
 *   - ApiError:   one request to WordPress failed permanently or exhausted its retries.
 *                 Carries the HTTP status and the message so the report can show both.
 * Validation failures are not exceptions; they are plain results (see validate.js).
 */

export class FatalError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FatalError';
  }
}

export class ApiError extends Error {
  /**
   * @param {object} options
   * @param {number|string} options.status  HTTP status code, or 'n/a' for network-level failures
   * @param {string} options.message        Human-readable explanation (never contains credentials)
   * @param {string} [options.code]         WordPress error code from the response body, if any
   * @param {boolean} [options.transient]   Whether the failure was of a retryable kind
   */
  constructor({ status, message, code, transient = false }) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.transient = transient;
  }
}
