import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { WordPressClient, backoffWithJitter, parseRetryAfter } from '../src/wp-client.js';
import { ApiError } from '../src/errors.js';
import { jsonResponse, abortError, networkError, scriptedFetch, recordingSleep, silentLogger } from './helpers.js';

const payload = { title: 'T', slug: 't', content: '<p/>', status: 'future', date_gmt: '2027-01-01T00:00:00', categories: [2], meta: {} };

function makeClient(script, options = {}) {
  const { fetchImpl, calls } = scriptedFetch(script);
  const { sleep, delays } = recordingSleep();
  let clock = 1_000_000;
  const client = new WordPressClient({
    baseUrl: 'https://site.test/',
    username: 'user',
    appPassword: 'abcd efgh',
    minRequestIntervalMs: 0, // pacing is covered by its own tests below
    maxRetries: 3,
    requestTimeoutMs: 1_000,
    fetchImpl,
    sleep,
    now: () => clock,
    logger: silentLogger,
    ...options,
  });
  return { client, calls, delays, advance: (ms) => { clock += ms; } };
}

const PACED = { minRequestIntervalMs: 500 };

describe('WordPressClient: requests and auth', () => {
  test('createPost sends POST to /wp-json/wp/v2/posts with Basic auth and JSON body', async () => {
    const { client, calls } = makeClient([jsonResponse(201, { id: 42, link: 'https://site.test/t/' })]);
    const result = await client.createPost(payload);

    assert.deepEqual(result, { id: 42, link: 'https://site.test/t/', reconciled: false });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://site.test/wp-json/wp/v2/posts');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.headers.Authorization, 'Basic ' + Buffer.from('user:abcd efgh').toString('base64'));
    assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(calls[0].init.body), payload);
    assert.equal(calls[0].init.redirect, 'manual');
  });

  test('findCategoryBySlug returns the id, or null when the slug is unknown', async () => {
    const { client, calls } = makeClient([jsonResponse(200, [{ id: 3, slug: 'guides' }]), jsonResponse(200, [])]);
    assert.equal(await client.findCategoryBySlug('guides'), 3);
    assert.equal(await client.findCategoryBySlug('nope'), null);
    assert.match(calls[0].url, /\/wp-json\/wp\/v2\/categories\?slug=guides/);
  });

  test('findPostBySlug queries any status and matches the slug exactly', async () => {
    const { client, calls } = makeClient([jsonResponse(200, [{ id: 9, slug: 't', link: 'l' }])]);
    assert.deepEqual(await client.findPostBySlug('t'), { id: 9, link: 'l' });
    assert.match(calls[0].url, /slug=t&status=any/);
  });

  test('a 201 without an id is reported as an error, not a success', async () => {
    const { client } = makeClient([jsonResponse(201, { message: 'weird' })]);
    await assert.rejects(client.createPost(payload), (e) => e instanceof ApiError && /did not contain a post id/.test(e.message));
  });
});

describe('WordPressClient: pacing', () => {
  test('waits for the minimum interval between consecutive requests', async () => {
    const { client, delays, advance } = makeClient([jsonResponse(200, []), jsonResponse(200, [])], PACED);
    await client.findCategoryBySlug('a');
    advance(120);
    await client.findCategoryBySlug('b');
    assert.deepEqual(delays, [380]); // 500 - 120 elapsed
  });

  test('does not wait when enough time has already passed', async () => {
    const { client, delays, advance } = makeClient([jsonResponse(200, []), jsonResponse(200, [])], PACED);
    await client.findCategoryBySlug('a');
    advance(5_000);
    await client.findCategoryBySlug('b');
    assert.deepEqual(delays, []);
  });
});

describe('WordPressClient: retries', () => {
  test('retries a 503 then succeeds, with a backoff wait in between', async () => {
    const { client, calls, delays } = makeClient([jsonResponse(503, { message: 'down' }), jsonResponse(201, { id: 1 })]);
    const result = await client.createPost(payload);
    assert.equal(result.id, 1);
    assert.equal(calls.length, 2);
    assert.equal(delays.length, 1);
    assert.ok(delays[0] >= 500 && delays[0] <= 1_000, `first backoff ${delays[0]} should be 0.5s-1s`);
  });

  test('gives up after maxRetries and reports the last status and message', async () => {
    const script = [500, 502, 503, 504].map((s) => jsonResponse(s, { message: `err ${s}` }));
    const { client, calls } = makeClient(script);
    await assert.rejects(client.createPost(payload), (e) => {
      assert.ok(e instanceof ApiError);
      assert.equal(e.status, 504);
      assert.match(e.message, /err 504 \(gave up after 4 attempts\)/);
      return true;
    });
    assert.equal(calls.length, 4); // 1 + 3 retries, never more
  });

  test('does not retry a 400 and surfaces the WordPress message', async () => {
    const { client, calls } = makeClient([jsonResponse(400, { code: 'rest_invalid_param', message: 'Invalid parameter(s): date_gmt' })]);
    await assert.rejects(client.createPost(payload), (e) => e.status === 400 && e.code === 'rest_invalid_param' && /date_gmt/.test(e.message));
    assert.equal(calls.length, 1);
  });

  test('does not retry 401/403/404/409', async () => {
    for (const status of [401, 403, 404, 409]) {
      const { client, calls } = makeClient([jsonResponse(status, { message: 'no' })]);
      await assert.rejects(client.createPost(payload), (e) => e.status === status);
      assert.equal(calls.length, 1, `status ${status}`);
    }
  });

  test('an error with an empty body still reports the status and says the body was empty', async () => {
    const { client } = makeClient([new Response('', { status: 500 }), jsonResponse(201, { id: 1 })]);
    await client.createPost(payload); // succeeds on retry
    const { client: failing } = makeClient([new Response('', { status: 403 })]);
    await assert.rejects(failing.createPost(payload), (e) => e.status === 403 && /\(empty response body\)$/.test(e.message));
  });

  test('a non-JSON error body does not crash the client and is told apart from an empty body', async () => {
    const { client } = makeClient([new Response('<html>Bad gateway</html>', { status: 502, statusText: 'Bad Gateway' })], { maxRetries: 0 });
    await assert.rejects(client.createPost(payload), (e) => e.status === 502 && /Bad Gateway \(non-JSON response body\)/.test(e.message));
  });

  test('429 honors Retry-After in seconds instead of the backoff', async () => {
    const { client, delays } = makeClient([jsonResponse(429, { message: 'slow down' }, { 'retry-after': '7' }), jsonResponse(201, { id: 1 })]);
    await client.createPost(payload);
    assert.deepEqual(delays, [7_000]);
  });

  test('429 without Retry-After falls back to backoff', async () => {
    const { client, delays } = makeClient([jsonResponse(429, { message: 'slow down' }), jsonResponse(201, { id: 1 })]);
    await client.createPost(payload);
    assert.equal(delays.length, 1);
    assert.ok(delays[0] >= 500 && delays[0] <= 1_000);
  });

  test('a redirect is a permanent error that names the location', async () => {
    const { client, calls } = makeClient([new Response('', { status: 301, headers: { location: 'https://www.site.test/' } })]);
    await assert.rejects(client.createPost(payload), (e) => e.status === 301 && /check WP_BASE_URL/.test(e.message));
    assert.equal(calls.length, 1);
  });
});

describe('WordPressClient: timeouts and uncertain outcomes', () => {
  test('timeout on a POST: looks the slug up first and reuses the existing post instead of re-creating it', async () => {
    const { client, calls } = makeClient([
      abortError(), // POST timed out
      jsonResponse(200, [{ id: 77, slug: 't', link: 'https://site.test/t/' }]), // GET posts?slug=t finds it
    ]);
    const result = await client.createPost(payload);
    assert.deepEqual(result, { id: 77, link: 'https://site.test/t/', reconciled: true });
    assert.equal(calls.length, 2);
    assert.equal(calls[1].init.method, 'GET');
  });

  test('timeout on a POST with no existing post: retries the create', async () => {
    const { client, calls } = makeClient([
      abortError(),
      jsonResponse(200, []), // not found
      jsonResponse(201, { id: 5 }),
    ]);
    const result = await client.createPost(payload);
    assert.equal(result.id, 5);
    assert.equal(result.reconciled, false);
    assert.deepEqual(calls.map((c) => c.init.method), ['POST', 'GET', 'POST']);
  });

  test('network error with a cause code is retried and described', async () => {
    const { client } = makeClient([networkError('ECONNREFUSED'), jsonResponse(200, [])], { maxRetries: 1 });
    assert.equal(await client.findCategoryBySlug('x'), null);
    const { client: failing } = makeClient([networkError('ECONNREFUSED')], { maxRetries: 0 });
    await assert.rejects(failing.findCategoryBySlug('x'), (e) => e.status === 'n/a' && /ECONNREFUSED/.test(e.message));
  });

  test('if the reconciliation lookup itself fails, the create is still retried', async () => {
    const { client, calls } = makeClient([
      abortError(), // POST
      abortError(), // GET lookup attempt 1 (its own retries exhausted quickly with maxRetries 0? no: lookup uses same client, so it also retries)
      abortError(), // GET retry
      jsonResponse(201, { id: 8 }), // second POST
    ], { maxRetries: 1 });
    const result = await client.createPost(payload);
    assert.equal(result.id, 8);
    assert.deepEqual(calls.map((c) => c.init.method), ['POST', 'GET', 'GET', 'POST']);
  });

  test('exhausted timeouts end as api error with status n/a', async () => {
    const { client } = makeClient([abortError(), jsonResponse(200, []), abortError(), jsonResponse(200, [])], { maxRetries: 1 });
    await assert.rejects(client.createPost(payload), (e) => e.status === 'n/a' && /timed out .*gave up after 2 attempts/.test(e.message));
  });

  test('the real timeout fires: a fetch that never resolves is aborted', async () => {
    const neverResolves = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(abortError())));
    const client = new WordPressClient({ baseUrl: 'https://site.test', username: 'u', appPassword: 'p', requestTimeoutMs: 20, maxRetries: 0, minRequestIntervalMs: 0, fetchImpl: neverResolves, logger: silentLogger });
    await assert.rejects(client.findCategoryBySlug('x'), (e) => /timed out/.test(e.message));
  });
});

describe('helpers', () => {
  test('backoff doubles per attempt, is capped, and keeps jitter within 50-100%', () => {
    assert.equal(backoffWithJitter(0, () => 1), 1_000);
    assert.equal(backoffWithJitter(1, () => 1), 2_000);
    assert.equal(backoffWithJitter(2, () => 0), 2_000); // 4000 * 0.5
    assert.equal(backoffWithJitter(10, () => 1), 30_000); // capped
  });

  test('parseRetryAfter handles seconds, HTTP dates, caps and garbage', () => {
    const now = Date.parse('2026-10-14T12:00:00Z');
    assert.equal(parseRetryAfter('3', now), 3_000);
    assert.equal(parseRetryAfter('Wed, 14 Oct 2026 12:00:10 GMT', now), 10_000);
    assert.equal(parseRetryAfter('99999', now), 60_000);
    assert.equal(parseRetryAfter('soon', now), null);
    assert.equal(parseRetryAfter(null, now), null);
  });
});
