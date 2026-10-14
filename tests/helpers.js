/** Shared test helpers: a fake fetch driven by a queue of scripted responses, and fixtures. */

export const NOW = new Date('2026-10-14T12:00:00Z');

export function validFields(overrides = {}) {
  return {
    title: 'A valid title',
    slug: 'a-valid-title',
    meta_title: 'A valid SEO title',
    meta_description: 'A valid meta description.',
    body_html: '<p>Hello</p>',
    primary_keyword: 'valid',
    publish_date: '2027-01-01T10:00:00Z',
    category: 'blog',
    ...overrides,
  };
}

export function jsonResponse(status, body, headers = {}) {
  const text = body === undefined ? '' : JSON.stringify(body);
  return new Response(text, { status, headers: { 'content-type': 'application/json', ...headers } });
}

export function abortError() {
  return Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
}

export function networkError(code = 'ECONNRESET') {
  return Object.assign(new TypeError('fetch failed'), { cause: { code } });
}

/**
 * Returns a fetch stand-in that answers each call with the next scripted item.
 * An item is either a Response or an Error (which is thrown). Every call is recorded.
 */
export function scriptedFetch(script) {
  const calls = [];
  const queue = [...script];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    if (queue.length === 0) throw new Error(`unexpected fetch call #${calls.length}: ${init?.method} ${url}`);
    const next = queue.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetchImpl, calls };
}

export function recordingSleep() {
  const delays = [];
  return { sleep: async (ms) => { delays.push(ms); }, delays };
}

export const silentLogger = { info() {}, warn() {}, error() {} };
