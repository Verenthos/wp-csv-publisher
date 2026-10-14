import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildPostPayload, toWordPressGmtDate, YOAST_META_KEYS } from '../src/payload.js';
import { validFields } from './helpers.js';

describe('buildPostPayload', () => {
  test('maps every column to the WordPress / Yoast field it belongs to', () => {
    const payload = buildPostPayload(validFields(), { categoryId: 7, publishDate: new Date('2027-01-01T10:00:00Z') });
    assert.deepEqual(payload, {
      title: 'A valid title',
      slug: 'a-valid-title',
      content: '<p>Hello</p>',
      status: 'future',
      date_gmt: '2027-01-01T10:00:00',
      categories: [7],
      meta: {
        [YOAST_META_KEYS.seoTitle]: 'A valid SEO title',
        [YOAST_META_KEYS.metaDescription]: 'A valid meta description.',
        [YOAST_META_KEYS.focusKeyword]: 'valid',
      },
    });
  });

  test('uses the documented Yoast meta keys', () => {
    assert.equal(YOAST_META_KEYS.seoTitle, '_yoast_wpseo_title');
    assert.equal(YOAST_META_KEYS.metaDescription, '_yoast_wpseo_metadesc');
  });

  test('date_gmt is UTC without offset, so +02:00 input becomes 08:30', () => {
    assert.equal(toWordPressGmtDate(new Date('2027-03-01T08:30:00+02:00')), '2027-03-01T06:30:00');
  });
});
