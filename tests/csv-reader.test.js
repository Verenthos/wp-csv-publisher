import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { readArticlesCsv, EXPECTED_COLUMNS } from '../src/csv-reader.js';
import { FatalError } from '../src/errors.js';

const dir = mkdtempSync(join(tmpdir(), 'wp-csv-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const HEADER = EXPECTED_COLUMNS.join(',');

function csvFile(name, content) {
  const path = join(dir, name);
  writeFileSync(path, content, 'utf8');
  return path;
}

describe('readArticlesCsv', () => {
  test('parses the bundled sample: 10 rows, multi-line quoted HTML intact', () => {
    const rows = readArticlesCsv(fileURLToPath(new URL('../articles.sample.csv', import.meta.url)));
    assert.equal(rows.length, 10);
    assert.equal(rows[0].row, 1);
    assert.match(rows[0].fields.body_html, /"quick wins"/);
    assert.match(rows[0].fields.body_html, /\n<ul>/);
    assert.equal(rows[9].fields.body_html, '');
  });

  test('trims every cell and keeps HTML with commas', () => {
    const path = csvFile('trim.csv', `${HEADER}\n"  Title ", slug ,mt,md,"<p>a, b</p>",kw, 2027-01-01 , blog \n`);
    const [row] = readArticlesCsv(path);
    assert.equal(row.fields.title, 'Title');
    assert.equal(row.fields.slug, 'slug');
    assert.equal(row.fields.body_html, '<p>a, b</p>');
    assert.equal(row.fields.category, 'blog');
  });

  test('tolerates a UTF-8 BOM', () => {
    const path = csvFile('bom.csv', `﻿${HEADER}\nT,t,mt,md,b,kw,2027-01-01,blog\n`);
    assert.equal(readArticlesCsv(path)[0].fields.title, 'T');
  });

  test('header only yields zero rows (not an error)', () => {
    assert.deepEqual(readArticlesCsv(csvFile('empty-rows.csv', `${HEADER}\n`)), []);
  });

  test('a short row becomes empty fields, not a crash', () => {
    const [row] = readArticlesCsv(csvFile('short.csv', `${HEADER}\nOnly,two\n`));
    assert.equal(row.fields.title, 'Only');
    assert.equal(row.fields.category, '');
  });

  test('missing required column is fatal and names the columns', () => {
    const path = csvFile('missing-col.csv', 'title,slug\nA,a\n');
    assert.throws(() => readArticlesCsv(path), (e) => e instanceof FatalError && /missing required columns: .*meta_title/.test(e.message));
  });

  test('duplicate header is fatal', () => {
    const path = csvFile('dup-col.csv', `${HEADER},slug\n`);
    assert.throws(() => readArticlesCsv(path), (e) => e instanceof FatalError && /duplicate columns: slug/.test(e.message));
  });

  test('completely empty file is fatal', () => {
    assert.throws(() => readArticlesCsv(csvFile('blank.csv', '\n\n')), (e) => e instanceof FatalError && /no header row/.test(e.message));
  });

  test('unbalanced quotes are fatal (file is malformed)', () => {
    const path = csvFile('bad-quote.csv', `${HEADER}\n"unterminated,slug,mt,md,b,kw,2027-01-01,blog\n`);
    assert.throws(() => readArticlesCsv(path), (e) => e instanceof FatalError && /malformed/.test(e.message));
  });

  test('nonexistent file is fatal with the path', () => {
    assert.throws(() => readArticlesCsv(join(dir, 'nope.csv')), (e) => e instanceof FatalError && /Cannot read CSV file/.test(e.message));
  });
});
