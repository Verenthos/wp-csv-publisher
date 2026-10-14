/**
 * Builds the JSON body for POST /wp-json/wp/v2/posts from a validated row.
 *
 * The SEO mapping lives here and nowhere else, so switching from Yoast to RankMath or
 * ACF is a change to this one file.
 *
 * Yoast SEO stores its per-post fields as post meta under `_yoast_wpseo_*` keys. Keys that
 * start with an underscore are "protected" in WordPress: the REST API ignores them unless the
 * site registers them with `register_post_meta(..., ['show_in_rest' => true])`. The
 * wordpress/register-yoast-meta.php mu-plugin in this repo does exactly that. Without it the
 * request still returns 201, but the SEO fields are silently dropped, which is why the README
 * tells the operator to verify one post before running the whole file.
 */

export const YOAST_META_KEYS = Object.freeze({
  seoTitle: '_yoast_wpseo_title',
  metaDescription: '_yoast_wpseo_metadesc',
  focusKeyword: '_yoast_wpseo_focuskw',
});

/**
 * @param {Record<string, string>} fields       Validated, trimmed row values
 * @param {object} options
 * @param {number} options.categoryId           WordPress term ID resolved from the category slug
 * @param {Date} options.publishDate            Parsed publish_date (already checked to be in the future)
 */
export function buildPostPayload(fields, { categoryId, publishDate }) {
  return {
    title: fields.title,
    slug: fields.slug,
    content: fields.body_html,
    // "future" + date_gmt makes WordPress schedule the post instead of publishing it now.
    status: 'future',
    date_gmt: toWordPressGmtDate(publishDate),
    categories: [categoryId],
    meta: {
      [YOAST_META_KEYS.seoTitle]: fields.meta_title,
      [YOAST_META_KEYS.metaDescription]: fields.meta_description,
      [YOAST_META_KEYS.focusKeyword]: fields.primary_keyword,
    },
  };
}

/** WordPress expects date_gmt as "YYYY-MM-DDTHH:mm:ss" with no offset suffix. */
export function toWordPressGmtDate(date) {
  return date.toISOString().slice(0, 19);
}
