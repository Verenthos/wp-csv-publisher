import { validateArticle } from './validate.js';
import { buildPostPayload } from './payload.js';
import { ApiError } from './errors.js';

/**
 * Orchestrates one run: validate every row, resolve categories, post the valid rows one at
 * a time, and return one result per input row in input order.
 *
 * Failures are kept at the row level on purpose. A row that fails validation or whose API
 * call fails gets its own result and the loop moves on; only configuration-level problems
 * (bad credentials) stop the posting phase, and even then every row still gets a result.
 */

const STATUS = Object.freeze({
  posted: 'posted',
  validationFailed: 'validation_failed',
  apiFailed: 'api_failed',
});

const AUTH_FAILURE_STATUSES = new Set([401, 403]);

/**
 * @param {object} options
 * @param {Array<{ row: number, fields: Record<string, string> }>} options.articles
 * @param {import('./wp-client.js').WordPressClient} options.client
 * @param {Date} [options.now]
 * @param {{ info: Function, warn: Function, error: Function }} [options.logger]
 */
export async function runPublish({ articles, client, now = new Date(), logger = console }) {
  const results = new Array(articles.length);
  const validRows = [];
  const duplicateSlugWarnings = findDuplicateSlugs(articles);

  // Phase 1: validation. Pure and local, so invalid rows never generate a request.
  articles.forEach((article, index) => {
    const { errors, warnings, publishDate } = validateArticle(article.fields, { now });
    const allWarnings = [...warnings, ...(duplicateSlugWarnings.get(index) ?? [])];
    const base = { row: article.row, title: article.fields.title, slug: article.fields.slug, warnings: allWarnings };

    if (errors.length > 0) {
      results[index] = { ...base, status: STATUS.validationFailed, reason: errors.join('; ') };
      logger.info(`row ${article.row}: validation_failed (${results[index].reason})`);
    } else {
      validRows.push({ index, article, publishDate, base });
    }
  });

  if (validRows.length === 0) return results;

  // Phase 2: resolve category slugs to term IDs once, not once per row.
  const categoryIds = await resolveCategories(validRows, client, logger);
  if (categoryIds.authFailure) {
    // Credentials are wrong for the whole run: do not send 100 requests that will all 401.
    for (const { index, base } of validRows) {
      results[index] = apiFailed(base, categoryIds.authFailure);
    }
    return results;
  }

  // Phase 3: post sequentially so the client's pacing is real and the site is not flooded.
  for (const { index, article, publishDate, base } of validRows) {
    const categorySlug = article.fields.category;
    const categoryId = categoryIds.get(categorySlug);

    if (typeof categoryId !== 'number') {
      results[index] = apiFailed(base, { status: 'n/a', message: `category "${categorySlug}" not found on the site` });
      logger.info(`row ${article.row}: api_failed (${results[index].message})`);
      continue;
    }

    results[index] = await postRow({ article, publishDate, categoryId, base, client, logger });
  }

  return results;
}

async function postRow({ article, publishDate, categoryId, base, client, logger }) {
  try {
    const payload = buildPostPayload(article.fields, { categoryId, publishDate });
    const created = await client.createPost(payload);
    const note = created.reconciled ? ' (already existed after an uncertain outcome)' : '';
    logger.info(`row ${article.row}: posted as id ${created.id}${note}`);
    return {
      ...base,
      status: STATUS.posted,
      httpStatus: 201,
      message: created.link ?? 'created',
      postId: created.id,
      warnings: created.reconciled ? [...base.warnings, 'post existed already; not re-created'] : base.warnings,
    };
  } catch (error) {
    if (error instanceof ApiError) {
      logger.info(`row ${article.row}: api_failed (${error.status}: ${error.message})`);
      return apiFailed(base, error);
    }
    // A bug or an unexpected condition. It is still reported per row, with the cause kept,
    // and it is never allowed to look like a success.
    logger.error(`row ${article.row}: unexpected error: ${error.stack ?? error.message}`);
    return apiFailed(base, { status: 'n/a', message: `unexpected error: ${error.message}` });
  }
}

/**
 * Looks up each distinct category used by the valid rows.
 * Returns a Map slug → id (missing or failed lookups are absent), or { authFailure } when the
 * site rejected the credentials.
 */
async function resolveCategories(validRows, client, logger) {
  const slugs = [...new Set(validRows.map(({ article }) => article.fields.category))];
  const ids = new Map();

  for (const slug of slugs) {
    try {
      const id = await client.findCategoryBySlug(slug);
      if (id === null) {
        logger.warn(`category "${slug}" is in the allow-list but does not exist on the site`);
      } else {
        ids.set(slug, id);
      }
    } catch (error) {
      if (error instanceof ApiError && AUTH_FAILURE_STATUSES.has(error.status)) {
        logger.error(`authentication failed (${error.status}: ${error.message}); aborting the posting phase`);
        return { authFailure: { status: error.status, message: `aborted: authentication failed (${error.message})` } };
      }
      logger.error(`could not resolve category "${slug}": ${error.message}`);
      // Rows using this category will be reported as api_failed below.
    }
  }
  return ids;
}

function apiFailed(base, { status, message }) {
  return { ...base, status: STATUS.apiFailed, httpStatus: status, message };
}

/** Flags later rows that reuse a slug seen earlier in the file (a warning, not a validation error). */
function findDuplicateSlugs(articles) {
  const firstSeen = new Map();
  const warnings = new Map();
  articles.forEach((article, index) => {
    const slug = article.fields.slug;
    if (slug === '') return;
    if (firstSeen.has(slug)) {
      warnings.set(index, [`duplicate slug: also used on row ${firstSeen.get(slug)}`]);
    } else {
      firstSeen.set(slug, article.row);
    }
  });
  return warnings;
}
