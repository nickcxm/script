/*
 * Baidu Maps minimal component-update experiment — 20261010-minimal-1.
 * Written against two user-provided HAR responses. Local JSON filtering only.
 * Does not read credentials/location, make network calls, or persist data.
 * Filtering update manifests does not guarantee removal of cached/native UI.
 */
(() => {
  'use strict';
  const VERSION = '20261010-minimal-1';
  const DEFAULTS = Object.freeze({ enabled: true, hideFeed: true, hideAI: true,
    hideLocalServices: true, hideGoldMall: true, debug: false });
  const ROUTES = {
    cloud: /^https:\/\/mbd\.baidu\.com\/ccs\/v1\/start\/confsync(?:\?[^#]*)?$/,
    packages: /^https:\/\/newclient\.map\.baidu\.com\/client\/imap\/dl\/s\/UpdateInfo\.php(?:\?[^#]*)?$/,
  };
  const PACKAGE_GROUPS = {
    hideFeed: ['aihomenearbycontent', 'commicroDetail', 'nearbycontent', 'nearbybraavos', 'surround'],
    hideAI: ['agent', 'mapAgent'],
    hideLocalServices: ['cater', 'hotel', 'hotelChanel', 'movie', 'scenery'],
    hideGoldMall: ['goldMall'],
  };
  const FEED_ENTRY = 'bdmap.mapclient.feed';
  const FEED_DEPENDENCY = 'bdmap.mapclient.feed__CLOTHOPROD__HomeFeed';
  function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
  function options(argument) {
    const input = typeof argument === 'string' ? JSON.parse(argument || '{}') : argument || {};
    if (!record(input)) throw new Error('Invalid options');
    const result = { ...DEFAULTS };
    for (const name of Object.keys(DEFAULTS)) if (typeof input[name] === 'boolean') result[name] = input[name];
    return result;
  }
  function parameter(url, name) {
    const match = new RegExp('[?&]' + name + '=([^&#]*)').exec(url);
    return match ? decodeURIComponent(match[1].replace(/\+/g, ' ')) : null;
  }
  function route(request) {
    if (request.method === 'POST' && ROUTES.cloud.test(request.url) && parameter(request.url, 'appname') === 'bdmap') return 'cloud';
    if (request.method === 'GET' && ROUTES.packages.test(request.url) &&
        parameter(request.url, 'qt') === 'upv' && parameter(request.url, 'cate') === 'components') return 'packages';
    return null;
  }
  function transform(body, kind, params = DEFAULTS) {
    const stats = { version: VERSION, route: kind, removedPackages: [], removedFeedEntry: false, removedFeedDependency: false };
    if (!params.enabled || !record(body)) return { body, changed: false, stats };
    if (kind === 'packages') {
      if (!record(body.result) || body.result.error !== 0 || !record(body.packages)) return { body, changed: false, stats };
      const packages = { ...body.packages };
      for (const [option, names] of Object.entries(PACKAGE_GROUPS)) {
        if (!params[option]) continue;
        for (const name of names) {
          const key = 'map.iphone.baidu.' + name;
          if (Object.prototype.hasOwnProperty.call(packages, key)) {
            delete packages[key]; stats.removedPackages.push(name);
          }
        }
      }
      return { body: stats.removedPackages.length ? { ...body, packages } : body,
        changed: stats.removedPackages.length > 0, stats };
    }
    if (kind === 'cloud' && params.hideFeed && body.errno === 0) {
      const talos = body.data?.service?.dpm?.talos;
      if (!record(talos) || !record(talos.mainentrance) || !record(talos.dependencies)) return { body, changed: false, stats };
      const mainentrance = { ...talos.mainentrance }, dependencies = { ...talos.dependencies };
      if (Object.prototype.hasOwnProperty.call(mainentrance, FEED_ENTRY)) { delete mainentrance[FEED_ENTRY]; stats.removedFeedEntry = true; }
      if (Object.prototype.hasOwnProperty.call(dependencies, FEED_DEPENDENCY)) { delete dependencies[FEED_DEPENDENCY]; stats.removedFeedDependency = true; }
      const changed = stats.removedFeedEntry || stats.removedFeedDependency;
      if (!changed) return { body, changed: false, stats };
      // Keep shared frameworks and the entire rtBus subtree intact, including
      // its signed metadata and walking/cycling/bus/navigation dependencies.
      return { body: { ...body, data: { ...body.data, service: { ...body.data.service,
        dpm: { ...body.data.service.dpm, talos: { ...talos, mainentrance, dependencies } } } } }, changed, stats };
    }
    return { body, changed: false, stats };
  }
  function responseHeaders(headers) {
    const result = { ...headers };
    for (const name of Object.keys(result)) {
      if (['content-length', 'content-encoding', 'transfer-encoding', 'etag', 'content-md5', 'digest', 'cache-control'].includes(name.toLowerCase())) delete result[name];
    }
    result['Cache-Control'] = 'no-store';
    return result;
  }
  function run() {
    let params = DEFAULTS, result = {};
    try {
      params = options(typeof $argument === 'undefined' ? '' : $argument);
      const kind = params.enabled ? route($request) : null;
      const contentType = Object.entries($response.headers || {}).find(([name]) => name.toLowerCase() === 'content-type')?.[1] || '';
      if (kind && $response.status === 200 && typeof $response.body === 'string' &&
          $response.body.length <= 1048576 && /\bapplication\/json\b/i.test(contentType)) {
        const output = transform(JSON.parse($response.body), kind, params);
        if (output.changed) result = { body: JSON.stringify(output.body), headers: responseHeaders($response.headers) };
        if (params.debug) console.log('[BaiduMap Minimal] ' + JSON.stringify(output.stats));
      }
    } catch (_) {
      if (params.debug) console.log('[BaiduMap Minimal] original response retained');
    }
    $done(result);
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { VERSION, DEFAULTS, PACKAGE_GROUPS, options, route, transform, responseHeaders, run };
  if (typeof $done === 'function') run();
})();
