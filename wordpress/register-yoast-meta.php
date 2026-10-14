<?php
/**
 * Plugin Name: Register Yoast SEO meta for the REST API
 * Description: Lets POST /wp-json/wp/v2/posts set the Yoast title, meta description and focus keyword through the "meta" field. Drop this file into wp-content/mu-plugins/ on the client site.
 *
 * Why this is needed: Yoast stores its per-post fields as post meta under keys that start
 * with an underscore (_yoast_wpseo_title, ...). WordPress treats such keys as protected and
 * the REST API ignores them unless they are registered with show_in_rest. Without this
 * registration the create request still returns 201 but the SEO fields are silently dropped.
 */

add_action( 'init', function () {
    $keys = array(
        '_yoast_wpseo_title',
        '_yoast_wpseo_metadesc',
        '_yoast_wpseo_focuskw',
    );

    foreach ( $keys as $key ) {
        register_post_meta(
            'post',
            $key,
            array(
                'type'              => 'string',
                'single'            => true,
                'show_in_rest'      => true,
                'sanitize_callback' => 'sanitize_text_field',
                'auth_callback'     => function () {
                    return current_user_can( 'edit_posts' );
                },
            )
        );
    }
} );
