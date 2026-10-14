import { readFileSync } from 'node:fs';
import { parse } from 'csv-parse/sync';
import { FatalError } from './errors.js';

/**
 * Reads articles.csv into plain objects, one per data row.
 *
 * A real CSV parser is used (csv-parse) because body_html contains commas, quotes and
 * newlines; splitting on commas would corrupt it. Structural problems with the file
 * (unreadable, no header, missing or duplicate columns, unbalanced quotes) are fatal:
 * there is no meaningful per-row report to produce from a file we cannot interpret.
 * Problems with individual values are NOT handled here; validate.js reports those per row.
 */

export const EXPECTED_COLUMNS = [
  'title',
  'slug',
  'meta_title',
  'meta_description',
  'body_html',
  'primary_keyword',
  'publish_date',
  'category',
];

/**
 * @param {string} filePath
 * @returns {Array<{ row: number, fields: Record<string, string> }>}
 *   `row` is the 1-based data row number (the header is not counted).
 */
export function readArticlesCsv(filePath) {
  let text;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new FatalError(`Cannot read CSV file "${filePath}": ${error.message}`);
  }

  if (text.trim() === '') {
    throw new FatalError(`CSV file "${filePath}" is empty (no header row)`);
  }

  let records;
  try {
    records = parse(text, {
      bom: true, // tolerate a UTF-8 byte-order mark from Excel exports
      columns: checkHeader,
      skip_empty_lines: true,
      relax_column_count: true, // short rows become "missing field" validation errors, not a crash
    });
  } catch (error) {
    if (error instanceof FatalError) throw error;
    throw new FatalError(`CSV file "${filePath}" is malformed: ${error.message}`);
  }

  return records.map((record, index) => ({
    row: index + 1,
    fields: normalizeRecord(record),
  }));
}

/** Validates the header row once; csv-parse calls this with the raw header names. */
function checkHeader(headerCells) {
  const names = headerCells.map((name) => String(name ?? '').trim());

  const duplicates = names.filter((name, i) => name !== '' && names.indexOf(name) !== i);
  if (duplicates.length > 0) {
    throw new FatalError(`CSV header has duplicate columns: ${unique(duplicates).join(', ')}`);
  }

  const missing = EXPECTED_COLUMNS.filter((name) => !names.includes(name));
  if (missing.length > 0) {
    throw new FatalError(`CSV header is missing required columns: ${missing.join(', ')}`);
  }

  return names;
}

/**
 * Deliberate normalization: every cell is trimmed and absent cells become ''.
 * Trimming is safe here because leading/trailing whitespace is never meaningful in
 * any of these columns, and it lets validation treat "   " the same as "".
 */
function normalizeRecord(record) {
  const fields = {};
  for (const name of EXPECTED_COLUMNS) {
    const value = record[name];
    fields[name] = value === undefined || value === null ? '' : String(value).trim();
  }
  return fields;
}

function unique(values) {
  return [...new Set(values)];
}
