/*
 * YouTube Local for Surge — local initplayback fallback, 2026-10-09.
 * Behavior researched from Maasea/sgmodule; new implementation. See NOTICE.
 * No Worker, client-key collection, request forwarding, or persistent storage.
 */
(() => {
  'use strict';

  function handle(request, argument) {
    const params = typeof argument === 'string' ? JSON.parse(argument || '{}') : argument || {};
    if (params.fallbackInit === false) return {};
    // Stay within the upstream initplayback + ack scope. In particular, do
    // not intercept videoplayback media chunks or arbitrary Google requests.
    if (!/^https:\/\/[\w-]+\.googlevideo\.com\/initplayback(?:\?|$)/.test(request.url) ||
        !/[?&]ack(?:=|&|$)/.test(request.url)) return {};
    // The original script also uses an empty response when no cached Onesie
    // keys are usable. This attempts to make the app fall back to v1/player.
    // It cannot guarantee that every current/future client supports fallback.
    return { response: { status: 200, headers: { 'Content-Type': 'text/plain' }, body: new Uint8Array(0) } };
  }

  function run() {
    let result = {};
    try {
      result = handle($request, typeof $argument === 'undefined' ? '' : $argument);
    } catch (_) {
      // Invalid arguments fail open. Never log request URLs or payloads.
    }
    $done(result);
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { handle, run };
  if (typeof $done === 'function') run();
})();
