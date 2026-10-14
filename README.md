# WordPress CSV publisher

Reads `articles.csv`, validates every row, schedules the valid rows on a WordPress site through the REST API (`POST /wp-json/wp/v2/posts`, Application Password auth, Yoast SEO fields), and writes a per-row report. One bad row never stops the run.

Node.js 20.6+ (uses the built-in `fetch`, `node:test` and `--env-file`). Two dependencies: `csv-parse` and `csv-stringify`, because `body_html` contains commas, quotes and newlines and hand-rolled CSV handling is where imports go wrong.

## Setup

```bash
npm install
cp .env.example .env   # then fill in WP_BASE_URL, WP_USERNAME, WP_APP_PASSWORD
```

Use a dedicated WordPress user with the Editor role and generate an Application Password for it (Users > Profile > Application Passwords). Credentials are read from the environment only; they are never logged or written to the report.

On the WordPress side, copy `wordpress/register-yoast-meta.php` into `wp-content/mu-plugins/`. Yoast keeps its fields in protected (`_`-prefixed) post meta, and the REST API silently drops those unless they are registered with `show_in_rest`. Without this file the posts are created but the SEO title and description are lost, and the API still answers 201.

## Run

```bash
npm start -- articles.csv                      # report written to report.csv
npm start -- articles.csv --report out.csv     # custom report path
```

Exit codes: `0` every row posted, `2` run completed but some rows failed (see the report), `1` fatal (bad config, unreadable CSV, report not writable).

### Try it without a real site

```bash
npm run mock-server            # mock WordPress on http://localhost:8080, user mock-user / mock-app-password
```

In a second terminal, with `WP_BASE_URL=http://localhost:8080`, `WP_USERNAME=mock-user`, `WP_APP_PASSWORD=mock-app-password` in `.env`:

```bash
npm start -- articles.sample.csv
```

`articles.sample.csv` has 10 rows: 3 valid (one exactly at the 60-character title limit) and one row for each validation rule, plus one row that breaks several rules at once. Start the mock with `MOCK_FLAKY_EVERY=2` to watch 503 retries, or give a row a slug ending in `-simulate-drop` to watch the dropped-connection reconciliation described below.

### Tests

```bash
npm test
```

106 tests, no network, no credentials: validation rules and boundaries, CSV edge cases, the HTTP client with scripted responses (retries, 429 with `Retry-After`, timeouts, empty and non-JSON bodies, redirects), the run orchestration with a fake client, the report writer, and an integration test that runs the real client against the in-process mock server over HTTP.

## Validation rules

A row is rejected, and never sent to the API, when any of these fail. All failures for a row are reported together.

| Rule | Condition |
|---|---|
| Required fields | every column must be present and not blank after trimming |
| `slug` | only `a-z`, `0-9` and `-` |
| `title` | at most 60 characters |
| `meta_description` | at most 160 characters |
| `publish_date` | valid ISO 8601 (`YYYY-MM-DD` or `YYYY-MM-DDTHH:mm[:ss][Z|±HH:mm]`) and not before the time of the run |
| `category` | one of `blog`, `guides`, `news` (exact match) |

Non-blocking warnings are added to the report for `meta_title` over 60 characters and for a slug reused inside the file.

Character counts use Unicode code points, so an accented letter or an emoji counts as one. A `publish_date` without a timezone offset is treated as UTC; `new Date()` is deliberately not used for parsing because it reads such values as local time and accepts non-ISO input.

## What gets sent

```json
{
  "title": "...", "slug": "...", "content": "<body_html>",
  "status": "future", "date_gmt": "2027-01-15T09:00:00",
  "categories": [3],
  "meta": {
    "_yoast_wpseo_title": "<meta_title>",
    "_yoast_wpseo_metadesc": "<meta_description>",
    "_yoast_wpseo_focuskw": "<primary_keyword>"
  }
}
```

`status: "future"` with `date_gmt` makes WordPress schedule the post for the publish date. Category slugs are resolved to term IDs with one `GET /wp-json/wp/v2/categories?slug=...` per distinct category at the start of the run; an allow-listed category that does not exist on the site fails its rows with a clear message instead of letting WordPress file them under "Uncategorized". The SEO mapping lives only in `src/payload.js`, so switching to RankMath or ACF is a one-file change.

## Reliability behavior

- Requests are sequential with a minimum gap between them (`WP_MIN_REQUEST_INTERVAL_MS`, default 500 ms, so at most 2 requests per second).
- Each request has a timeout (`WP_REQUEST_TIMEOUT_MS`, default 15 s).
- Transient failures (5xx, 429, timeouts, network errors) are retried up to `WP_MAX_RETRIES` times (default 3) with exponential backoff (1 s, 2 s, 4 s, capped at 30 s) and jitter. A 429 with `Retry-After` waits for that long instead. 4xx errors are permanent and are not retried.
- A timeout on a POST does not prove the post was not created. Before retrying, the script looks the slug up (`GET /wp-json/wp/v2/posts?slug=...&status=any`); if the post exists it is reported as posted with a warning instead of being created twice.
- Wrong credentials are detected on the first request and abort the posting phase; every valid row is reported as `api_failed` with the 401/403 rather than sending 100 requests that would all fail.
- An unexpected exception while processing a row is caught at the row boundary, logged with the row number, and reported as `api_failed`; it can never appear as `posted`.

## Report

CSV, one line per input row, in input order.

| Column | Meaning |
|---|---|
| `row` | 1-based data row in the input (header not counted) |
| `title`, `slug` | copied from the input |
| `status` | `posted`, `validation_failed` or `api_failed` |
| `reason` | for `validation_failed`: every failed rule, joined by `; ` |
| `http_status` | for `api_failed`: HTTP status, or `n/a` for timeouts and network errors; `201` for posted |
| `message` | for `api_failed`: the WordPress error message or the client's explanation; for posted: the post link |
| `post_id` | WordPress post ID when posted |
| `warnings` | non-blocking notes |

## Assumptions

- All eight columns are required. A post that lacks its meta description is not "ready to push". This is a single constant in `src/validate.js`.
- `meta_title` over 60 characters is a warning, not a rejection, because the task's list of rejection rules does not include it.
- A structurally broken CSV (unreadable, no header, missing or duplicate column, unbalanced quotes) is fatal; there is no meaningful per-row report to produce from a file that cannot be interpreted. A short row is not fatal: its missing cells become validation errors.
- Yoast fields are set through the `meta` object with the mu-plugin above. If the client prefers Yoast's own endpoints or another SEO plugin, `src/payload.js` is the only file to change.

## Productionizing for weekly client use

For weekly client use I would first make the run idempotent across executions: tag every post with an `import_id` meta value derived from the slug and the source file, check it before creating, and keep a small run history so a re-run after a crash never duplicates posts and each week's report can be compared with the last. Secrets would move out of the `.env` file into the team's secret manager (1Password CLI, AWS Secrets Manager or GitHub Actions secrets, depending on where the job runs), with a dedicated Editor user per client site and periodic rotation of the application password. I would add structured JSON logging and post a summary to Slack after every run, with an alert when the `api_failed` count or the retry rate crosses a threshold, because the failure that matters is the quiet one where the job runs but half the posts never land. After creating each post the script would read it back and assert that the Yoast meta, the category and the scheduled date survived, which catches the silent-drop problem that a 201 response hides. A dry-run mode would let the content team validate their CSV themselves before the scheduled run, and per-client settings (base URL, category allow-list, rate limit) would live in a config file per client so onboarding a new site is a config change rather than a code change. The job itself would run from CI or a cron container with the test suite in the pipeline, pinned dependencies, and a staging site as the first stop for any new client. Finally, for larger batches I would add bounded concurrency (two or three workers under the same rate limit) only after confirming with the host what the site can take, since the current sequential design is deliberately the safe default for a live client site.

## Layout

```
publish-articles.js        entry point and exit codes
src/config.js              environment variables and defaults
src/csv-reader.js          CSV parsing, header checks, trimming
src/validate.js            validation rules and the strict ISO 8601 parser
src/payload.js             row -> WordPress request body (Yoast mapping lives here)
src/wp-client.js           HTTP client: auth, pacing, timeouts, retries, reconciliation
src/run.js                 orchestration: validate, resolve categories, post, collect results
src/report.js              CSV report and summary
src/errors.js              FatalError and ApiError
mock/mock-wp-server.js     mock WordPress for local runs and the integration test
wordpress/register-yoast-meta.php   mu-plugin that exposes the Yoast meta keys to REST
tests/                     node:test suites
articles.sample.csv        sample input covering every rule
```
