/**
 * End-to-end: the real client against the in-process mock WordPress server over HTTP.
 * Exercises real fetch, real timeouts/sockets, pacing (set to 0 here) and the
 * reconciliation path with a dropped connection. No external network.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createMockWordPressServer } from '../mock/mock-wp-server.js';
import { WordPressClient } from '../src/wp-client.js';
import { runPublish } from '../src/run.js';
import { validFields, NOW, silentLogger } from './helpers.js';

let server;
let baseUrl;

before(async () => {
  server = createMockWordPressServer({ flakyEvery: 2 });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const client = (overrides = {}) =>
  new WordPressClient({ baseUrl, username: 'mock-user', appPassword: 'mock-app-password', minRequestIntervalMs: 0, maxRetries: 2, requestTimeoutMs: 2_000, sleep: async () => {}, logger: silentLogger, ...overrides });

describe('integration against the mock server', () => {
  test('posts valid rows, survives a simulated 503, reconciles a dropped connection, reports invalid rows', async () => {
    const articles = [
      { row: 1, fields: validFields({ slug: 'first-post' }) },
      { row: 2, fields: validFields({ slug: 'second-post', category: 'news' }) }, // 2nd POST attempt: 503 once, then ok
      { row: 3, fields: validFields({ slug: 'third-simulate-drop' }) }, // created, connection dropped, found by lookup
      { row: 4, fields: validFields({ slug: 'Invalid Slug' }) },
    ];
    const results = await runPublish({ articles, client: client(), now: NOW, logger: silentLogger });

    assert.deepEqual(results.map((r) => r.status), ['posted', 'posted', 'posted', 'validation_failed']);
    assert.ok(results.slice(0, 3).every((r) => typeof r.postId === 'number'));
    assert.ok(results[2].warnings.some((w) => /existed already/.test(w)), 'dropped connection should be reconciled');

    // The dropped-connection post must exist exactly once on the server.
    const lookup = await client().findPostBySlug('third-simulate-drop');
    assert.equal(lookup.id, results[2].postId);
  });

  test('wrong credentials produce api_failed 401 for valid rows without creating anything', async () => {
    const results = await runPublish({
      articles: [{ row: 1, fields: validFields({ slug: 'never-created' }) }],
      client: client({ appPassword: 'wrong' }),
      now: NOW,
      logger: silentLogger,
    });
    assert.equal(results[0].status, 'api_failed');
    assert.equal(results[0].httpStatus, 401);
    assert.equal(await client().findPostBySlug('never-created'), null);
  });
});
