import { ApiError } from './errors.js';

/**
 * Thin WordPress REST client with the reliability behavior the run depends on:
 *   - Application Password auth (HTTP Basic) on every request.
 *   - Pacing: a minimum gap between consecutive requests so the site is never hammered.
 *   - Per-request timeout.
 *   - Bounded retries with exponential backoff and jitter, only for failures that are
 *     plausibly transient (5xx, 429, timeouts, network errors). 4xx errors are permanent
 *     and are returned to the caller immediately. 429 honors Retry-After when present.
 *   - Reconciliation for uncertain POST outcomes: a timeout does not prove the post was
 *     not created, so before retrying a create we look the slug up and, if the post exists,
 *     report it as created instead of making a duplicate.
 *
 * `fetchImpl`, `sleep` and `now` are injectable so tests run without a network or real time.
 */

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 30_000;
const RETRY_AFTER_CAP_MS = 60_000;
const TRANSIENT_STATUSES = new Set([429, 500, 502, 503, 504]);

export class WordPressClient {
  #baseUrl;
  #authHeader;
  #minRequestIntervalMs;
  #maxRetries;
  #requestTimeoutMs;
  #fetch;
  #sleep;
  #now;
  #logger;
  #lastRequestAt = -Infinity;

  constructor({
    baseUrl,
    username,
    appPassword,
    minRequestIntervalMs = 500,
    maxRetries = 3,
    requestTimeoutMs = 15_000,
    fetchImpl = globalThis.fetch,
    sleep = defaultSleep,
    now = Date.now,
    logger = console,
  }) {
    this.#baseUrl = baseUrl.replace(/\/+$/, '');
    // Application Passwords are sent as HTTP Basic auth. The header is kept private and
    // never logged or included in error messages.
    this.#authHeader = 'Basic ' + Buffer.from(`${username}:${appPassword}`).toString('base64');
    this.#minRequestIntervalMs = minRequestIntervalMs;
    this.#maxRetries = maxRetries;
    this.#requestTimeoutMs = requestTimeoutMs;
    this.#fetch = fetchImpl;
    this.#sleep = sleep;
    this.#now = now;
    this.#logger = logger;
  }

  /** @returns {Promise<number | null>} term ID, or null when no category has that slug */
  async findCategoryBySlug(slug) {
    const query = new URLSearchParams({ slug, per_page: '1' });
    const categories = await this.#request('GET', `/wp-json/wp/v2/categories?${query}`);
    const match = Array.isArray(categories) ? categories.find((c) => c.slug === slug) : undefined;
    return match ? match.id : null;
  }

  /** @returns {Promise<{ id: number, link?: string } | null>} any post (any status) with that slug */
  async findPostBySlug(slug) {
    const query = new URLSearchParams({ slug, status: 'any', per_page: '1' });
    const posts = await this.#request('GET', `/wp-json/wp/v2/posts?${query}`);
    const match = Array.isArray(posts) ? posts.find((p) => p.slug === slug) : undefined;
    return match ? { id: match.id, link: match.link } : null;
  }

  /**
   * Creates a post. Resolves with { id, link, reconciled } where `reconciled` is true when
   * the post was found to already exist after an uncertain outcome instead of being created
   * by this call.
   */
  async createPost(payload) {
    const result = await this.#request('POST', '/wp-json/wp/v2/posts', {
      body: payload,
      onUncertainOutcome: () => this.findPostBySlug(payload.slug),
    });
    if (result.reconciled) return result;
    if (!result || typeof result.id !== 'number') {
      throw new ApiError({ status: 201, message: 'response did not contain a post id' });
    }
    return { id: result.id, link: result.link, reconciled: false };
  }

  /**
   * Sends one request with pacing, timeout and retries.
   * @param {() => Promise<object|null>} [options.onUncertainOutcome]
   *   Called after a timeout/network error on a non-idempotent request. If it resolves with
   *   an object, that object is returned (marked `reconciled`) and no retry is made.
   */
  async #request(method, path, { body, onUncertainOutcome } = {}) {
    let lastError;

    for (let attempt = 0; attempt <= this.#maxRetries; attempt++) {
      await this.#pace();

      let response;
      try {
        response = await this.#send(method, path, body);
      } catch (error) {
        // Timeout or network failure. For a POST we cannot know whether the server acted.
        lastError = new ApiError({ status: 'n/a', message: describeNetworkError(error), transient: true });
        if (onUncertainOutcome) {
          const existing = await this.#tryReconcile(onUncertainOutcome);
          if (existing) return { ...existing, reconciled: true };
        }
        await this.#waitBeforeRetry(attempt, lastError, null);
        continue;
      }

      if (response.ok) return (await readBody(response)).json;

      const apiError = await toApiError(response);
      if (!apiError.transient) throw apiError;

      lastError = apiError;
      await this.#waitBeforeRetry(attempt, lastError, response);
    }

    throw new ApiError({
      status: lastError.status,
      code: lastError.code,
      message: `${lastError.message} (gave up after ${this.#maxRetries + 1} attempts)`,
      transient: true,
    });
  }

  async #send(method, path, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#requestTimeoutMs);
    try {
      return await this.#fetch(this.#baseUrl + path, {
        method,
        headers: {
          Authorization: this.#authHeader,
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
        // A redirect would turn a POST into a GET or re-send credentials elsewhere.
        // Surface it as an error so a wrong WP_BASE_URL is noticed instead of masked.
        redirect: 'manual',
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /** Waits so that consecutive requests are at least minRequestIntervalMs apart. */
  async #pace() {
    const elapsed = this.#now() - this.#lastRequestAt;
    const remaining = this.#minRequestIntervalMs - elapsed;
    if (remaining > 0) await this.#sleep(remaining);
    this.#lastRequestAt = this.#now();
  }

  async #tryReconcile(onUncertainOutcome) {
    try {
      const existing = await onUncertainOutcome();
      if (existing) {
        this.#logger.warn(`  outcome uncertain after network error, but the post already exists (id ${existing.id}); not retrying`);
      }
      return existing;
    } catch (error) {
      this.#logger.warn(`  could not check whether the post exists (${error.message}); will retry the create`);
      return null;
    }
  }

  async #waitBeforeRetry(attempt, error, response) {
    if (attempt >= this.#maxRetries) return; // the loop ends and the caller gets the error

    const retryAfterMs = response ? parseRetryAfter(response.headers.get('retry-after'), this.#now()) : null;
    const delayMs = retryAfterMs ?? backoffWithJitter(attempt);
    this.#logger.warn(`  transient failure (${error.status}: ${error.message}); retry ${attempt + 1}/${this.#maxRetries} in ${Math.round(delayMs)} ms`);
    await this.#sleep(delayMs);
  }
}

/** Exponential backoff (1s, 2s, 4s, ...) capped, with jitter so retries from several runs spread out. */
export function backoffWithJitter(attempt, random = Math.random) {
  const exponential = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);
  const jitterFactor = 0.5 + random() * 0.5; // between 50% and 100% of the delay
  return exponential * jitterFactor;
}

/** Retry-After can be seconds or an HTTP date. Returns ms to wait, capped, or null if absent/invalid. */
export function parseRetryAfter(headerValue, nowMs) {
  if (!headerValue) return null;
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, RETRY_AFTER_CAP_MS);
  const dateMs = Date.parse(headerValue);
  if (Number.isNaN(dateMs)) return null;
  return Math.min(Math.max(dateMs - nowMs, 0), RETRY_AFTER_CAP_MS);
}

/** Turns a non-2xx response into an ApiError with the most useful message available. */
async function toApiError(response) {
  if (response.status >= 300 && response.status < 400) {
    return new ApiError({
      status: response.status,
      message: `unexpected redirect to ${response.headers.get('location') ?? 'unknown location'}; check WP_BASE_URL`,
    });
  }

  const { text, json } = await readBody(response);
  const statusText = response.statusText || 'request failed';
  let message;
  if (json && typeof json.message === 'string') {
    message = json.message; // WordPress error shape: { code, message, data }
  } else if (text.trim() === '') {
    message = `${statusText} (empty response body)`;
  } else {
    message = `${statusText} (non-JSON response body)`; // e.g. an HTML page from a host firewall
  }

  return new ApiError({
    status: response.status,
    code: json && typeof json.code === 'string' ? json.code : undefined,
    message,
    transient: TRANSIENT_STATUSES.has(response.status),
  });
}

/** Reads the body once; `json` is null when the body is empty or not valid JSON. */
async function readBody(response) {
  const text = await response.text();
  let json = null;
  if (text.trim() !== '') {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return { text, json };
}

function describeNetworkError(error) {
  if (error.name === 'AbortError') return 'request timed out';
  const cause = error.cause?.code ? ` (${error.cause.code})` : '';
  return `network error: ${error.message}${cause}`;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
