import { FatalError } from './errors.js';

/**
 * Reads configuration from environment variables.
 * Credentials never appear in code; they come from the environment (or a .env file
 * loaded with `node --env-file=.env`). Missing credentials stop the run before any
 * network call is made.
 */

const DEFAULTS = {
  minRequestIntervalMs: 500, // at most 2 requests per second
  maxRetries: 3,
  requestTimeoutMs: 15_000,
};

export function loadConfig(env = process.env) {
  const baseUrl = requireString(env, 'WP_BASE_URL').replace(/\/+$/, '');
  const username = requireString(env, 'WP_USERNAME');
  const appPassword = requireString(env, 'WP_APP_PASSWORD');

  if (!/^https?:\/\//i.test(baseUrl)) {
    throw new FatalError('WP_BASE_URL must start with http:// or https://');
  }

  return {
    baseUrl,
    username,
    appPassword,
    minRequestIntervalMs: optionalNonNegativeInt(env, 'WP_MIN_REQUEST_INTERVAL_MS', DEFAULTS.minRequestIntervalMs),
    maxRetries: optionalNonNegativeInt(env, 'WP_MAX_RETRIES', DEFAULTS.maxRetries),
    requestTimeoutMs: optionalNonNegativeInt(env, 'WP_REQUEST_TIMEOUT_MS', DEFAULTS.requestTimeoutMs),
  };
}

function requireString(env, name) {
  const value = (env[name] ?? '').trim();
  if (value === '') {
    throw new FatalError(`Missing required environment variable ${name}. See .env.example.`);
  }
  return value;
}

function optionalNonNegativeInt(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new FatalError(`${name} must be a non-negative integer, got "${raw}"`);
  }
  return value;
}
