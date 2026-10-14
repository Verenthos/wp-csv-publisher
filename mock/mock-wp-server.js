/**
 * MOCK WordPress REST server for local runs and tests. Not production code.
 *
 * It imitates just enough of wp/v2 for this script:
 *   GET  /wp-json/wp/v2/categories?slug=<slug>   -> [{ id, slug, name }] for blog, guides, news
 *   GET  /wp-json/wp/v2/posts?slug=<slug>        -> posts created in this process with that slug
 *   POST /wp-json/wp/v2/posts                    -> 201 { id, slug, link, status }
 * Requests without the expected Basic credentials get WordPress-style 401 JSON.
 *
 * Failure simulation (to watch the retry and reconciliation paths):
 *   - MOCK_FLAKY_EVERY=N : every Nth POST fails once with 503 before succeeding on retry.
 *   - a slug ending in "-simulate-drop" : the post IS created, but the connection is
 *     closed without a response. The client sees a network error, cannot know the
 *     outcome, looks the slug up and finds the post instead of creating a duplicate.
 *
 * Run standalone:  node mock/mock-wp-server.js   (PORT, MOCK_USERNAME, MOCK_APP_PASSWORD)
 */

import { createServer } from 'node:http';

const DEFAULT_CATEGORIES = [
  { id: 2, slug: 'blog', name: 'Blog' },
  { id: 3, slug: 'guides', name: 'Guides' },
  { id: 4, slug: 'news', name: 'News' },
];

export function createMockWordPressServer({
  username = 'mock-user',
  appPassword = 'mock-app-password',
  flakyEvery = 0,
  categories = DEFAULT_CATEGORIES,
  log = () => {},
} = {}) {
  const expectedAuth = 'Basic ' + Buffer.from(`${username}:${appPassword}`).toString('base64');
  const posts = [];
  let postAttempts = 0;
  const flakedOnce = new Set(); // slugs that already got their one simulated 503
  const droppedOnce = new Set(); // slugs that already had their connection dropped

  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    log(`${req.method} ${url.pathname}${url.search}`);

    if (req.headers.authorization !== expectedAuth) {
      return sendJson(res, 401, { code: 'rest_cannot_create', message: 'Sorry, you are not allowed to do that.', data: { status: 401 } });
    }

    if (req.method === 'GET' && url.pathname === '/wp-json/wp/v2/categories') {
      const slug = url.searchParams.get('slug');
      return sendJson(res, 200, categories.filter((c) => !slug || c.slug === slug));
    }

    if (req.method === 'GET' && url.pathname === '/wp-json/wp/v2/posts') {
      const slug = url.searchParams.get('slug');
      return sendJson(res, 200, posts.filter((p) => !slug || p.slug === slug));
    }

    if (req.method === 'POST' && url.pathname === '/wp-json/wp/v2/posts') {
      const body = await readJson(req);
      if (!body || typeof body.title !== 'string' || typeof body.slug !== 'string') {
        return sendJson(res, 400, { code: 'rest_invalid_param', message: 'Invalid parameter(s): title, slug', data: { status: 400 } });
      }

      postAttempts += 1;
      if (flakyEvery > 0 && postAttempts % flakyEvery === 0 && !flakedOnce.has(body.slug)) {
        flakedOnce.add(body.slug);
        return sendJson(res, 503, { code: 'mock_unavailable', message: 'Service temporarily unavailable (simulated)', data: { status: 503 } });
      }

      const post = { id: 1000 + posts.length + 1, slug: body.slug, status: body.status ?? 'draft', link: `http://localhost/${body.slug}/` };
      posts.push(post);

      if (body.slug.endsWith('-simulate-drop') && !droppedOnce.has(body.slug)) {
        droppedOnce.add(body.slug);
        req.socket.destroy(); // created, but the client never hears about it
        return undefined;
      }
      return sendJson(res, 201, post);
    }

    return sendJson(res, 404, { code: 'rest_no_route', message: 'No route was found matching the URL and request method.', data: { status: 404 } });
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function readJson(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(data)); } catch { resolve(null); }
    });
  });
}

const isMainModule = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').replace(/^.*\//, ''));
if (isMainModule) {
  const port = Number(process.env.PORT ?? 8080);
  const server = createMockWordPressServer({
    username: process.env.MOCK_USERNAME ?? 'mock-user',
    appPassword: process.env.MOCK_APP_PASSWORD ?? 'mock-app-password',
    flakyEvery: Number(process.env.MOCK_FLAKY_EVERY ?? 0),
    log: console.log,
  });
  server.listen(port, () => console.log(`Mock WordPress listening on http://localhost:${port} (user: mock-user)`));
}
