import { writeFileSync } from 'node:fs';
import { stringify } from 'csv-stringify/sync';
import { FatalError } from './errors.js';

/**
 * Writes the per-row report as CSV: one line per input row, in input order.
 *
 * Columns:
 *   row          1-based data row number in the input file
 *   title, slug  copied from the input so the content team can find the row
 *   status       posted | validation_failed | api_failed
 *   reason       validation_failed: every failed rule, joined by "; "
 *   http_status  api_failed: HTTP status code (or n/a for timeouts/network errors); posted: 201
 *   message      api_failed: error message from WordPress or the client; posted: post link
 *   post_id      posted: the WordPress post ID
 *   warnings     non-blocking notes (e.g. meta_title over the recommended length)
 */

export const REPORT_COLUMNS = ['row', 'title', 'slug', 'status', 'reason', 'http_status', 'message', 'post_id', 'warnings'];

export function toReportRows(results) {
  return results.map((result) => ({
    row: result.row,
    title: result.title,
    slug: result.slug,
    status: result.status,
    reason: result.reason ?? '',
    http_status: result.httpStatus ?? '',
    message: result.message ?? '',
    post_id: result.postId ?? '',
    warnings: (result.warnings ?? []).join('; '),
  }));
}

export function writeReport(filePath, results) {
  const csv = stringify(toReportRows(results), { header: true, columns: REPORT_COLUMNS });
  try {
    writeFileSync(filePath, csv, 'utf8');
  } catch (error) {
    throw new FatalError(`Cannot write report to "${filePath}": ${error.message}`);
  }
}

export function summarize(results) {
  const counts = { posted: 0, validation_failed: 0, api_failed: 0 };
  for (const result of results) counts[result.status] = (counts[result.status] ?? 0) + 1;
  return { total: results.length, ...counts };
}
