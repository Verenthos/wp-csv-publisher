/**
 * Row validation. Pure functions, no I/O, no network: the same input always gives the
 * same result, which keeps the rules easy to test and keeps invalid rows away from the API.
 *
 * Every rule runs and every failure is collected, so the content team sees all the
 * problems with a row at once instead of fixing them one at a time.
 */

export const TITLE_MAX_CHARS = 60;
export const META_DESCRIPTION_MAX_CHARS = 160;
export const META_TITLE_RECOMMENDED_MAX_CHARS = 60; // "should be" in the spec: warning only
export const CATEGORY_ALLOW_LIST = Object.freeze(['blog', 'guides', 'news']);

// Lowercase letters, digits and hyphens only, as the spec describes the slug.
export const SLUG_PATTERN = /^[a-z0-9-]+$/;

// All columns are required: the content team supplies every one of them and a post
// missing, say, its meta description is not "ready to push". Change this list if the
// client decides some SEO columns are optional.
export const REQUIRED_FIELDS = Object.freeze([
  'title',
  'slug',
  'meta_title',
  'meta_description',
  'body_html',
  'primary_keyword',
  'publish_date',
  'category',
]);

/**
 * @param {Record<string, string>} fields  Trimmed cell values from csv-reader.js
 * @param {object} [options]
 * @param {Date} [options.now]  Injected clock so "in the past" is testable
 * @returns {{ errors: string[], warnings: string[], publishDate: Date | null }}
 */
export function validateArticle(fields, { now = new Date() } = {}) {
  const errors = [];
  const warnings = [];

  for (const name of REQUIRED_FIELDS) {
    if (isBlank(fields[name])) errors.push(`missing required field: ${name}`);
  }

  if (!isBlank(fields.slug) && !SLUG_PATTERN.test(fields.slug)) {
    errors.push('slug contains invalid characters (allowed: a-z, 0-9, -)');
  }

  const titleLength = charCount(fields.title);
  if (titleLength > TITLE_MAX_CHARS) {
    errors.push(`title exceeds ${TITLE_MAX_CHARS} characters (${titleLength})`);
  }

  const metaDescriptionLength = charCount(fields.meta_description);
  if (metaDescriptionLength > META_DESCRIPTION_MAX_CHARS) {
    errors.push(`meta_description exceeds ${META_DESCRIPTION_MAX_CHARS} characters (${metaDescriptionLength})`);
  }

  const metaTitleLength = charCount(fields.meta_title);
  if (metaTitleLength > META_TITLE_RECOMMENDED_MAX_CHARS) {
    warnings.push(`meta_title is longer than the recommended ${META_TITLE_RECOMMENDED_MAX_CHARS} characters (${metaTitleLength})`);
  }

  let publishDate = null;
  if (!isBlank(fields.publish_date)) {
    publishDate = parseIso8601(fields.publish_date);
    if (publishDate === null) {
      errors.push('publish_date is not a valid ISO 8601 date');
    } else if (publishDate.getTime() < now.getTime()) {
      errors.push('publish_date is in the past');
    }
  }

  if (!isBlank(fields.category) && !CATEGORY_ALLOW_LIST.includes(fields.category)) {
    errors.push(`category "${fields.category}" is not in the allow-list (${CATEGORY_ALLOW_LIST.join(', ')})`);
  }

  return { errors, warnings, publishDate: errors.length === 0 ? publishDate : null };
}

function isBlank(value) {
  return value === undefined || value === null || String(value).trim() === '';
}

/** Counts Unicode code points, so an emoji or an accented letter counts as one character. */
export function charCount(value) {
  return Array.from(String(value ?? '')).length;
}

const ISO_8601_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * Strict ISO 8601 parser. `new Date(string)` is deliberately avoided because its
 * behavior varies: it accepts non-ISO input, treats "2026-02-30" leniently in some
 * engines, and reads a date-time without offset as *local* time, which would make
 * "in the past" depend on the machine the script runs on.
 *
 * Accepted: YYYY-MM-DD, or YYYY-MM-DDTHH:mm[:ss[.sss]][Z|±HH:mm].
 * Assumption: a value without an offset is UTC. Date-only means 00:00:00 UTC.
 *
 * @returns {Date | null}
 */
export function parseIso8601(value) {
  const match = ISO_8601_PATTERN.exec(String(value).trim());
  if (!match) return null;

  const [, y, mo, d, h = '0', mi = '0', s = '0', ms = '0', offset = 'Z'] = match;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = Number(s);
  const millisecond = Number(ms.padEnd(3, '0'));

  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;

  const utcMillis = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
  return new Date(utcMillis - offsetToMillis(offset));
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** "+02:00" → 7_200_000. The offset is subtracted because 10:00+02:00 is 08:00 UTC. */
function offsetToMillis(offset) {
  if (offset === 'Z') return 0;
  const sign = offset.startsWith('-') ? -1 : 1;
  const digits = offset.slice(1).replace(':', '');
  const hours = Number(digits.slice(0, 2));
  const minutes = Number(digits.slice(2, 4));
  return sign * (hours * 60 + minutes) * 60_000;
}
