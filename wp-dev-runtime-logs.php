<?php
/**
 * Plugin Name: WP Dev Runtime Logs
 * Plugin URI:  https://huedev.com/wp-dev-runtime-logs
 * Description: Monitor development logs and performance easily — a lightweight tool for developers, testers, and managers.
 * Version:     1.0
 * Author:      HueDev
 * Author URI:  https://huedev.com
 * License:     GPLv2 or later
 * License URI: https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain: wp-dev-runtime-logs
 * Domain Path: /languages
 */


// Exit if accessed directly.
if ( ! defined( 'ABSPATH' ) ) {
    exit;
}

class WP_Dev_Runtime_Logs {

    // holds queued messages from PHP during the request
    protected static $queued_messages = array();

    public static function init() {
        // enqueue only in admin screens
        add_action( 'admin_enqueue_scripts', array( __CLASS__, 'enqueue_script' ), 1 );
        add_action( 'admin_footer', array( __CLASS__, 'print_queued_logs' ), 9999 );
    }

    // Enqueue the injected script so it loads on every admin page.
    public static function enqueue_script( $hook ) {
        $handle = 'wp-wpdevruntimelogs-injected-admin';
        $src = plugin_dir_url( __FILE__ ) . 'assets/injected.js';

        // Load in footer of admin page to ensure admin DOM exists (set $in_footer true)
        // Note: admin_enqueue_scripts provides $hook but we load on all admin pages by default
        wp_enqueue_script( $handle, $src, array(), '1.1', true );
        wp_enqueue_style(
            'wpdevruntimelogs-style',
            plugin_dir_url(__FILE__) . 'assets/css/wpdevruntimelogs.css',
            array(),
            '1.0'
        );
        // Optional tiny inline flag before script runs
        $flag = 'window.__wpdevruntimelogs_injected_by_wp_admin = true;';
        wp_add_inline_script( $handle, $flag, 'before' );
    }

    // Called by other PHP code (admin-side) to queue a message to be logged in the browser console
    public static function add_log( $text ) {
        if ( ! is_scalar( $text ) ) {
            $text = wp_json_encode( $text );
        }
        self::$queued_messages[] = (string) $text;
    }

    // Print inline JS in admin footer that calls window.wpdevruntimelogs.log(...) for each queued message.
    public static function print_queued_logs() {
        if ( empty( self::$queued_messages ) ) {
            return;
        }

        // Prepare JS array safely
        $messages_json = wp_json_encode( array_values( self::$queued_messages ) );
        // Inline script: iterate messages and call window.wpdevruntimelogs.log when available.
        // If wpdevruntimelogs not available yet, queue calls with a short retry (non-blocking).
        $js = <<<JSCODE
(function(){
  try {
    var msgs = $messages_json;
    function dispatch() {
      try {
        if (window.wpdevruntimelogs && typeof window.wpdevruntimelogs.log === 'function') {
          msgs.forEach(function(m){ try{ window.wpdevruntimelogs.log(String(m)); }catch(e){} });
        } else {
          // retry once after small delay - in case injected.js wasn't parsed yet
          setTimeout(function(){
            if (window.wpdevruntimelogs && typeof window.wpdevruntimelogs.log === 'function') {
              msgs.forEach(function(m){ try{ window.wpdevruntimelogs.log(String(m)); }catch(e){} });
            } else {
              // fallback: print to console directly
              msgs.forEach(function(m){ try{ console.log('[wpdevruntimelogs fallback] ' + String(m)); }catch(e){} });
            }
          }, 250);
        }
      } catch(e) {
        try { console.log('[wpdevruntimelogs print error]', e); } catch(err) {}
      }
    }
    dispatch();
  } catch(err) { try { console.log('[wpdevruntimelogs print error outer]', err); } catch(e) {} }
})();
JSCODE;

        echo "<script type=\"text/javascript\">{$js}</script>\n";
        // clear queued messages for this request
        self::$queued_messages = array();
    }
}

// Initialize plugin
WP_Dev_Runtime_Logs::init();

/**
 * Procedural helper, so other plugin/theme admin PHP can call:
 * wpdevruntimelogs_add_log_admin('my message');
 */
function wpdevruntimelogs_add_log_admin( $text ) {
    WP_Dev_Runtime_Logs::add_log( $text );
}
