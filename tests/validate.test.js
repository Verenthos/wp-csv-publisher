import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validateArticle, parseIso8601, charCount, REQUIRED_FIELDS } from '../src/validate.js';
import { validFields, NOW } from './helpers.js';

const validate = (overrides) => validateArticle(validFields(overrides), { now: NOW });

describe('validateArticle: required fields', () => {
  test('a fully valid row has no errors and a parsed publish date', () => {
    const result = validate();
    assert.deepEqual(result.errors, []);
    assert.equal(result.publishDate.toISOString(), '2027-01-01T10:00:00.000Z');
  });

  for (const field of REQUIRED_FIELDS) {
    test(`empty ${field} is reported as missing`, () => {
      const { errors } = validate({ [field]: '' });
      assert.ok(errors.includes(`missing required field: ${field}`), errors.join(' | '));
    });
  }

  test('whitespace-only value counts as missing', () => {
    const { errors } = validate({ title: '   ' });
    assert.ok(errors.includes('missing required field: title'));
  });

  test('absent column (undefined) counts as missing', () => {
    const fields = validFields();
    delete fields.meta_description;
    const { errors } = validateArticle(fields, { now: NOW });
    assert.ok(errors.includes('missing required field: meta_description'));
  });
});

describe('validateArticle: slug', () => {
  for (const slug of ['Upper-Case', 'has space', 'under_score', 'with.dot', 'slash/x', 'accént', 'emoji-\u{1F600}', 'trailing!']) {
    test(`rejects "${slug}"`, () => {
      const { errors } = validate({ slug });
      assert.ok(errors.some((e) => e.startsWith('slug contains invalid characters')), errors.join(' | '));
    });
  }

  for (const slug of ['simple', 'with-hyphens-123', '2026-roundup']) {
    test(`accepts "${slug}"`, () => {
      assert.deepEqual(validate({ slug }).errors, []);
    });
  }
});

describe('validateArticle: length limits', () => {
  test('title of exactly 60 characters is valid', () => {
    assert.deepEqual(validate({ title: 'x'.repeat(60) }).errors, []);
  });

  test('title of 61 characters fails with the count', () => {
    const { errors } = validate({ title: 'x'.repeat(61) });
    assert.deepEqual(errors, ['title exceeds 60 characters (61)']);
  });

  test('meta_description of exactly 160 characters is valid', () => {
    assert.deepEqual(validate({ meta_description: 'x'.repeat(160) }).errors, []);
  });

  test('meta_description of 161 characters fails with the count', () => {
    const { errors } = validate({ meta_description: 'x'.repeat(161) });
    assert.deepEqual(errors, ['meta_description exceeds 160 characters (161)']);
  });

  test('length is counted in code points, so 60 emoji is still 60 characters', () => {
    assert.deepEqual(validate({ title: '\u{1F600}'.repeat(60) }).errors, []);
    assert.equal(charCount('\u{1F600}\u{1F600}'), 2);
  });

  test('meta_title over 60 is a warning, not an error', () => {
    const result = validate({ meta_title: 'x'.repeat(61) });
    assert.deepEqual(result.errors, []);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /meta_title is longer than the recommended 60/);
  });
});

describe('validateArticle: publish_date', () => {
  test('one second in the past is rejected', () => {
    const { errors } = validate({ publish_date: '2026-10-14T11:59:59Z' });
    assert.deepEqual(errors, ['publish_date is in the past']);
  });

  test('exactly now is accepted (not in the past)', () => {
    assert.deepEqual(validate({ publish_date: '2026-10-14T12:00:00Z' }).errors, []);
  });

  test('offset is applied: 13:30+02:00 is 11:30Z, which is in the past', () => {
    const { errors } = validate({ publish_date: '2026-10-14T13:30:00+02:00' });
    assert.deepEqual(errors, ['publish_date is in the past']);
  });

  test('date-only in the future is accepted as midnight UTC', () => {
    const result = validate({ publish_date: '2026-10-15' });
    assert.deepEqual(result.errors, []);
    assert.equal(result.publishDate.toISOString(), '2026-10-15T00:00:00.000Z');
  });

  for (const bad of ['not-a-date', '2026-02-30', '2026-13-01', '2026-10-14T25:00:00Z', '14/10/2026', '2026-10-14T10:00:00 UTC', '']) {
    test(`"${bad}" is not accepted as valid`, () => {
      const { errors } = validate({ publish_date: bad });
      assert.ok(
        errors.includes('publish_date is not a valid ISO 8601 date') || errors.includes('missing required field: publish_date'),
        errors.join(' | '),
      );
    });
  }

  test('publishDate is null when the row has any error', () => {
    assert.equal(validate({ category: 'nope' }).publishDate, null);
  });
});

describe('validateArticle: category', () => {
  for (const category of ['blog', 'guides', 'news']) {
    test(`accepts "${category}"`, () => assert.deepEqual(validate({ category }).errors, []));
  }

  for (const category of ['Blog', 'blogs', 'press-releases', 'news ']) {
    test(`rejects "${category}" (exact match only)`, () => {
      const { errors } = validate({ category });
      assert.ok(errors.some((e) => e.includes('is not in the allow-list')), errors.join(' | '));
    });
  }
});

describe('validateArticle: multiple failures', () => {
  test('all failing rules are reported together', () => {
    const { errors } = validate({ title: 'x'.repeat(70), slug: 'BAD', body_html: '', publish_date: 'nope', category: 'sports' });
    assert.equal(errors.length, 5, errors.join(' | '));
  });
});

describe('parseIso8601', () => {
  test('parses milliseconds and negative offsets', () => {
    assert.equal(parseIso8601('2027-01-01T10:00:00.5-03:00').toISOString(), '2027-01-01T13:00:00.500Z');
  });

  test('accepts offsets without a colon', () => {
    assert.equal(parseIso8601('2027-01-01T10:00+0100').toISOString(), '2027-01-01T09:00:00.000Z');
  });

  test('leap day is valid only in leap years', () => {
    assert.ok(parseIso8601('2028-02-29'));
    assert.equal(parseIso8601('2027-02-29'), null);
  });
});
