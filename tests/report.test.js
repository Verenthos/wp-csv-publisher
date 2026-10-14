import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from 'csv-parse/sync';
import { writeReport, summarize, REPORT_COLUMNS } from '../src/report.js';
import { FatalError } from '../src/errors.js';

const dir = mkdtempSync(join(tmpdir(), 'wp-report-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const results = [
  { row: 1, title: 'Ok', slug: 'ok', status: 'posted', httpStatus: 201, message: 'https://s/ok/', postId: 10, warnings: [] },
  { row: 2, title: 'Bad, "quoted"', slug: 'bad', status: 'validation_failed', reason: 'title exceeds 60 characters (70); slug contains invalid characters (allowed: a-z, 0-9, -)', warnings: ['meta_title is longer than the recommended 60 characters (65)'] },
  { row: 3, title: 'Api', slug: 'api', status: 'api_failed', httpStatus: 503, message: 'down (gave up after 4 attempts)', warnings: [] },
];

describe('writeReport', () => {
  test('writes one line per result with the documented columns, escaping commas and quotes', () => {
    const path = join(dir, 'report.csv');
    writeReport(path, results);
    const rows = parse(readFileSync(path, 'utf8'), { columns: true });

    assert.equal(rows.length, 3);
    assert.deepEqual(Object.keys(rows[0]), REPORT_COLUMNS);
    assert.deepEqual(rows[0], { row: '1', title: 'Ok', slug: 'ok', status: 'posted', reason: '', http_status: '201', message: 'https://s/ok/', post_id: '10', warnings: '' });
    assert.equal(rows[1].title, 'Bad, "quoted"');
    assert.match(rows[1].reason, /title exceeds 60.*; slug contains/);
    assert.equal(rows[2].http_status, '503');
    assert.match(rows[2].message, /gave up after 4 attempts/);
  });

  test('an empty run still produces a header-only report', () => {
    const path = join(dir, 'empty.csv');
    writeReport(path, []);
    assert.equal(readFileSync(path, 'utf8').trim(), REPORT_COLUMNS.join(','));
  });

  test('an unwritable path is a FatalError with the path in the message', () => {
    const path = join(dir, 'missing-dir', 'report.csv');
    assert.throws(() => writeReport(path, results), (e) => e instanceof FatalError && e.message.includes(path));
  });
});

describe('summarize', () => {
  test('counts each status', () => {
    assert.deepEqual(summarize(results), { total: 3, posted: 1, validation_failed: 1, api_failed: 1 });
    assert.deepEqual(summarize([]), { total: 0, posted: 0, validation_failed: 0, api_failed: 0 });
  });
});
