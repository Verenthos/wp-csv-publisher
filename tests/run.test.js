import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { runPublish } from '../src/run.js';
import { ApiError } from '../src/errors.js';
import { validFields, NOW, silentLogger } from './helpers.js';

/** A fake client that records calls and answers from a per-slug script. */
function fakeClient({ categories = { blog: 2, guides: 3, news: 4 }, posts = {} } = {}) {
  const calls = { findCategoryBySlug: [], createPost: [] };
  return {
    calls,
    async findCategoryBySlug(slug) {
      calls.findCategoryBySlug.push(slug);
      const value = categories[slug];
      if (value instanceof Error) throw value;
      return value ?? null;
    },
    async createPost(payload) {
      calls.createPost.push(payload);
      const outcome = posts[payload.slug];
      if (outcome instanceof Error) throw outcome;
      return outcome ?? { id: 100 + calls.createPost.length, link: `https://s/${payload.slug}/`, reconciled: false };
    },
  };
}

const article = (row, overrides) => ({ row, fields: validFields({ slug: `row-${row}`, ...overrides }) });
const run = (articles, client) => runPublish({ articles, client, now: NOW, logger: silentLogger });

describe('runPublish', () => {
  test('invalid rows never reach the API and every row gets a result in input order', async () => {
    const client = fakeClient();
    const results = await run([article(1), article(2, { title: '' }), article(3, { category: 'sports' }), article(4)], client);

    assert.deepEqual(results.map((r) => r.status), ['posted', 'validation_failed', 'validation_failed', 'posted']);
    assert.deepEqual(results.map((r) => r.row), [1, 2, 3, 4]);
    assert.deepEqual(client.calls.createPost.map((p) => p.slug), ['row-1', 'row-4']);
    assert.equal(results[1].reason, 'missing required field: title');
    assert.equal(results[0].postId, 101);
    assert.equal(results[0].httpStatus, 201);
  });

  test('an API failure on one row does not stop the following rows', async () => {
    const client = fakeClient({ posts: { 'row-2': new ApiError({ status: 503, message: 'down (gave up after 4 attempts)' }) } });
    const results = await run([article(1), article(2), article(3)], client);

    assert.deepEqual(results.map((r) => r.status), ['posted', 'api_failed', 'posted']);
    assert.equal(results[1].httpStatus, 503);
    assert.match(results[1].message, /gave up after 4 attempts/);
    assert.equal(client.calls.createPost.length, 3);
  });

  test('the last row failing is still reported', async () => {
    const client = fakeClient({ posts: { 'row-2': new ApiError({ status: 400, message: 'Invalid parameter(s): date_gmt' }) } });
    const results = await run([article(1), article(2)], client);
    assert.equal(results[1].status, 'api_failed');
    assert.equal(results[1].httpStatus, 400);
    assert.equal(results[1].message, 'Invalid parameter(s): date_gmt');
  });

  test('an unexpected exception is reported as api_failed, never as posted', async () => {
    const client = fakeClient({ posts: { 'row-1': new TypeError("Cannot read properties of undefined (reading 'id')") } });
    const results = await run([article(1), article(2)], client);
    assert.equal(results[0].status, 'api_failed');
    assert.equal(results[0].httpStatus, 'n/a');
    assert.match(results[0].message, /^unexpected error: Cannot read/);
    assert.equal(results[1].status, 'posted');
  });

  test('categories are resolved once per distinct slug, not once per row', async () => {
    const client = fakeClient();
    await run([article(1, { category: 'blog' }), article(2, { category: 'blog' }), article(3, { category: 'news' })], client);
    assert.deepEqual(client.calls.findCategoryBySlug, ['blog', 'news']);
  });

  test('an allow-listed category that does not exist on the site fails its rows without posting', async () => {
    const client = fakeClient({ categories: { blog: 2 } }); // guides is missing on the site
    const results = await run([article(1, { category: 'guides' }), article(2, { category: 'blog' })], client);
    assert.equal(results[0].status, 'api_failed');
    assert.equal(results[0].httpStatus, 'n/a');
    assert.match(results[0].message, /category "guides" not found on the site/);
    assert.equal(results[1].status, 'posted');
    assert.deepEqual(client.calls.createPost.map((p) => p.slug), ['row-2']);
  });

  test('wrong credentials: every valid row is api_failed with 401 and nothing is posted', async () => {
    const client = fakeClient({ categories: { blog: new ApiError({ status: 401, message: 'Sorry, you are not allowed to do that.' }) } });
    const results = await run([article(1), article(2, { title: '' }), article(3)], client);
    assert.deepEqual(results.map((r) => r.status), ['api_failed', 'validation_failed', 'api_failed']);
    assert.equal(results[0].httpStatus, 401);
    assert.match(results[0].message, /authentication failed/);
    assert.equal(client.calls.createPost.length, 0);
    assert.equal(client.calls.findCategoryBySlug.length, 1);
  });

  test('a category lookup that fails for another reason only affects rows using that category', async () => {
    const client = fakeClient({ categories: { blog: 2, news: new ApiError({ status: 502, message: 'bad gateway (gave up after 4 attempts)' }) } });
    const results = await run([article(1, { category: 'news' }), article(2, { category: 'blog' })], client);
    assert.equal(results[0].status, 'api_failed');
    assert.equal(results[1].status, 'posted');
  });

  test('no rows: returns an empty result set without touching the API', async () => {
    const client = fakeClient();
    assert.deepEqual(await run([], client), []);
    assert.equal(client.calls.findCategoryBySlug.length, 0);
  });

  test('all rows invalid: no category lookup or post is made', async () => {
    const client = fakeClient();
    const results = await run([article(1, { slug: 'BAD' })], client);
    assert.equal(results[0].status, 'validation_failed');
    assert.equal(client.calls.findCategoryBySlug.length, 0);
  });

  test('payload sent to the API carries the resolved category id and the Yoast meta', async () => {
    const client = fakeClient();
    await run([article(1, { category: 'guides', meta_title: 'MT', meta_description: 'MD' })], client);
    const [payload] = client.calls.createPost;
    assert.deepEqual(payload.categories, [3]);
    assert.equal(payload.status, 'future');
    assert.equal(payload.meta._yoast_wpseo_title, 'MT');
    assert.equal(payload.meta._yoast_wpseo_metadesc, 'MD');
  });

  test('a reconciled post (existed after an uncertain outcome) is posted with a warning', async () => {
    const client = fakeClient({ posts: { 'row-1': { id: 55, link: 'l', reconciled: true } } });
    const [result] = await run([article(1)], client);
    assert.equal(result.status, 'posted');
    assert.equal(result.postId, 55);
    assert.ok(result.warnings.some((w) => /existed already/.test(w)));
  });

  test('duplicate slugs in the file are warned on the later row and still processed', async () => {
    const client = fakeClient();
    const results = await run([article(1, { slug: 'same' }), article(2, { slug: 'same' })], client);
    assert.deepEqual(results[0].warnings, []);
    assert.deepEqual(results[1].warnings, ['duplicate slug: also used on row 1']);
    assert.equal(results[1].status, 'posted');
  });
});
