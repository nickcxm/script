/*
 * Bloomberg paragraph translation for Surge, 2026-10-09.
 * Independently written against a user-provided story JSON response.
 * Only paragraph text is sent to Google's unauthenticated translation endpoint.
 * No Bloomberg headers, cookies, URLs, account data, or persistent storage.
 */
(() => {
  'use strict';

  const STORY_URL = /^https:\/\/cdn-mobapi\.bloomberg\.com\/wssmobile\/v1\/stories\/[A-Z0-9]{14}(?:\?[^#]*)?$/;
  const GOOGLE_URL = 'https://translate.googleapis.com/translate_a/single';
  const LEGACY_PREFIX = '【中文译文】';
  const TRANSLATION_MARKER = '_nickcxmTranslation';
  const SOURCE_COUNT = '_nickcxmSourceParagraphs';
  const MAX_BODY = 1024 * 1024;
  const MAX_COMPONENTS = 500;
  const MAX_REQUESTS = 48;
  const CHUNK_SIZE = 1200;
  const TOTAL_TIMEOUT_MS = 45000;
  const REQUEST_TIMEOUT_MS = 7000;
  const CONCURRENCY = 3;
  const DEFAULTS = Object.freeze({ enabled: true, removeAdConfig: true, debug: false });

  function options(argument) {
    const supplied = typeof argument === 'string' ? JSON.parse(argument || '{}') : argument || {};
    if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied)) throw new Error('Invalid options');
    const result = { ...DEFAULTS };
    for (const key of Object.keys(DEFAULTS)) if (typeof supplied[key] === 'boolean') result[key] = supplied[key];
    return result;
  }

  // Anchor nodes sometimes contain both a text fallback and nested parts.
  // Nested parts take precedence: appending both would duplicate link text.
  // Only follow the explicit parts tree, never security/URL/metadata fields.
  function extractText(parts, depth = 0) {
    if (!Array.isArray(parts) || depth > 20) throw new Error('Unsupported paragraph structure');
    return parts.map(part => {
      if (!part || typeof part !== 'object' || Array.isArray(part)) throw new Error('Invalid paragraph part');
      if (Array.isArray(part.parts) && part.parts.length) return extractText(part.parts, depth + 1);
      return typeof part.text === 'string' ? part.text : '';
    }).join('');
  }

  function isTranslation(component) {
    return component?.role === 'p' && Array.isArray(component.parts) && component.parts.length === 1 &&
      component.parts[0]?.role === 'text' && typeof component.parts[0].text === 'string' &&
      (component[TRANSLATION_MARKER] === true || component.parts[0].text.startsWith(LEGACY_PREFIX));
  }

  function splitText(text) {
    // Prefer sentence/space boundaries; retain every source character.
    // Array.from avoids splitting UTF-16 surrogate pairs in long paragraphs.
    const characters = Array.from(text);
    const chunks = [];
    let position = 0;
    while (position < characters.length) {
      let end = Math.min(position + CHUNK_SIZE, characters.length);
      if (end < characters.length) {
        for (let i = end - 1; i > position + CHUNK_SIZE / 2; i--) {
          if (/\s/.test(characters[i])) { end = i + 1; break; }
        }
      }
      chunks.push(characters.slice(position, end).join(''));
      position = end;
    }
    return chunks;
  }

  function googleRequest(text, timeoutMs) {
    return {
      url: GOOGLE_URL + '?client=gtx&sl=en&tl=zh-CN&dt=t&q=' + encodeURIComponent(text),
      headers: { Accept: 'application/json' },
      timeout: timeoutMs / 1000,
      'auto-redirect': false,
      'auto-cookie': false,
    };
  }

  function parseTranslation(body) {
    const response = JSON.parse(body);
    if (!Array.isArray(response) || !Array.isArray(response[0]) || !response[0].length) throw new Error('Invalid translation response');
    let translated = '';
    for (const sentence of response[0]) {
      if (!Array.isArray(sentence) || typeof sentence[0] !== 'string') throw new Error('Invalid translation sentence');
      translated += sentence[0];
    }
    translated = translated.trim();
    if (!translated || !/[\u3400-\u9fff]/.test(translated)) throw new Error('No Chinese translation');
    return translated;
  }

  function googleTransport(httpClient, schedule = setTimeout) {
    return (text, timeoutMs) => new Promise((resolve, reject) => {
      let settled = false;
      function finish(error, value) {
        if (settled) return;
        settled = true;
        if (error) reject(error); else resolve(value);
      }
      // Surge's HTTP timeout is also set. The timer protects against a callback
      // that never fires, and ignores late callbacks without a second $done.
      schedule(() => finish(new Error('Translation timeout')), timeoutMs);
      try {
        httpClient.get(googleRequest(text, timeoutMs), (error, response, body) => {
          if (settled) return;
          if (error) { finish(new Error('Translation network failure')); return; }
          if (Number(response?.status ?? response?.statusCode) !== 200) {
            finish(new Error('Translation HTTP failure')); return;
          }
          try { finish(null, parseTranslation(body)); }
          catch (_) { finish(new Error('Translation response failure')); }
        });
      } catch (_) { finish(new Error('Translation request failure')); }
    });
  }

  async function translateStory(story, translate, params = DEFAULTS, clock = Date.now) {
    if (!story || typeof story !== 'object' || Array.isArray(story) ||
        !Array.isArray(story.components) || story.components.length > MAX_COMPONENTS) {
      throw new Error('Unsupported story response');
    }
    const started = clock();
    const deadline = started + TOTAL_TIMEOUT_MS;
    const jobs = [];
    const unique = new Map();
    const covered = new Set();
    // A grouped translation covers N consecutive source paragraphs before it.
    // Older paragraph-by-paragraph translations have no count and cover one.
    for (let index = 0; index < story.components.length; index++) {
      const component = story.components[index];
      if (!isTranslation(component)) continue;
      const count = Number.isInteger(component[SOURCE_COUNT]) && component[SOURCE_COUNT] > 0 &&
        component[SOURCE_COUNT] <= MAX_COMPONENTS ? component[SOURCE_COUNT] : 1;
      for (let offset = 1; offset <= count; offset++) {
        const previous = story.components[index - offset];
        if (previous?.role !== 'p' || isTranslation(previous)) break;
        covered.add(index - offset);
      }
    }
    let malformed = 0;
    let requestCount = 0;
    let group = null;
    function flushGroup() {
      if (!group) return;
      const source = group.texts.join('\n\n');
      let job = unique.get(source);
      if (!job) {
        const chunks = splitText(source);
        if (requestCount + chunks.length > MAX_REQUESTS) { group = null; return; }
        requestCount += chunks.length;
        job = { source, chunks, translation: null };
        unique.set(source, job);
      }
      jobs.push({ index: group.end, count: group.texts.length, job });
      group = null;
    }
    for (let index = 0; index < story.components.length; index++) {
      const component = story.components[index];
      // Every non-body component (especially images and webviews) separates
      // runs. Never merge across a skipped/malformed/already translated item.
      if (component?.role !== 'p' || isTranslation(component) || covered.has(index)) {
        flushGroup(); continue;
      }
      let source;
      try { source = extractText(component.parts).trim(); }
      catch (_) { malformed++; flushGroup(); continue; }
      if (!source || !/[A-Za-z]/.test(source)) { flushGroup(); continue; }
      if (!group) group = { texts: [], end: index };
      group.texts.push(source);
      group.end = index;
    }
    flushGroup();
    const pending = Array.from(unique.values());
    let next = 0;
    let failed = malformed;
    let expired = 0;
    let requests = 0;
    async function worker() {
      while (next < pending.length) {
        const job = pending[next++];
        if (clock() >= deadline) { expired++; continue; }
        const translated = [];
        try {
          for (const chunk of job.chunks) {
            const remaining = deadline - clock();
            if (remaining <= 0) throw new Error('Translation deadline');
            requests++;
            const value = await translate(chunk, Math.min(REQUEST_TIMEOUT_MS, remaining));
            if (typeof value !== 'string' || !value.trim()) throw new Error('Empty translation');
            translated.push(value.trim());
          }
          job.translation = translated.join('');
        } catch (_) { failed++; }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pending.length) }, worker));
    const successful = jobs.filter(item => item.job.translation);
    const after = new Map(successful.map(item => [item.index, item]));
    const components = [];
    let labelsRemoved = 0;
    for (let index = 0; index < story.components.length; index++) {
      // Keep the original object and all of its nested links exactly as parsed.
      const original = story.components[index];
      if (isTranslation(original) && original.parts[0].text.startsWith(LEGACY_PREFIX)) {
        components.push({ ...original, [TRANSLATION_MARKER]: true, parts: [{ ...original.parts[0],
          text: original.parts[0].text.slice(LEGACY_PREFIX.length).replace(/^\s*\n?/, '') }] });
        labelsRemoved++;
      } else components.push(original);
      if (after.has(index)) {
        const group = after.get(index);
        components.push({ role: 'p', [TRANSLATION_MARKER]: true, [SOURCE_COUNT]: group.count,
          parts: [{ role: 'text', text: group.job.translation }] });
      }
    }
    let adConfigChanged = false;
    const result = { ...story, components };
    if (params.removeAdConfig) {
      if (Object.prototype.hasOwnProperty.call(result, 'adParams')) { delete result.adParams; adConfigChanged = true; }
      if (typeof result.disableAds === 'boolean' && !result.disableAds) { result.disableAds = true; adConfigChanged = true; }
    }
    // In the provided HAR, webview is related reading, not an advertisement.
    // Images, webviews, article metadata and all unrecognized roles are retained.
    return { story: result, changed: after.size > 0 || adConfigChanged || labelsRemoved > 0,
      stats: { paragraphs: jobs.reduce((sum, item) => sum + item.count, 0), groups: jobs.length,
        translated: successful.reduce((sum, item) => sum + item.count, 0), translatedGroups: after.size,
        requests, failed, expired, adConfigChanged, labelsRemoved } };
  }

  function responseHeaders(headers) {
    const result = { ...headers };
    // The body is now JSON encoded by us, not the original compressed payload.
    // Do not retain stale framing, hashes or cache validators from Bloomberg.
    const remove = new Set(['content-length', 'content-encoding', 'transfer-encoding', 'etag', 'content-md5', 'digest']);
    for (const name of Object.keys(result)) if (remove.has(name.toLowerCase()) || name.toLowerCase() === 'cache-control') delete result[name];
    result['Cache-Control'] = 'no-store';
    return result;
  }

  async function run() {
    let params = DEFAULTS;
    let result = {};
    try {
      params = options(typeof $argument === 'undefined' ? '' : $argument);
      if (params.enabled && $request.method === 'GET' && STORY_URL.test($request.url) &&
          Number($response.status) === 200 && typeof $response.body === 'string' &&
          $response.body.length > 0 && $response.body.length <= MAX_BODY) {
        const contentType = Object.entries($response.headers || {}).find(([name]) => name.toLowerCase() === 'content-type')?.[1] || '';
        if (/\bapplication\/json\b/i.test(contentType)) {
          const original = JSON.parse($response.body);
          const output = await translateStory(original, googleTransport($httpClient), params);
          if (output.changed) result = { body: JSON.stringify(output.story), headers: responseHeaders($response.headers) };
          if (params.debug) console.log('[Bloomberg Translate] ' + JSON.stringify(output.stats));
        }
      }
    } catch (_) {
      if (params.debug) console.log('[Bloomberg Translate] original response retained');
    }
    $done(result);
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { STORY_URL, LEGACY_PREFIX, TRANSLATION_MARKER, SOURCE_COUNT, options, extractText, splitText, googleRequest, parseTranslation,
      googleTransport, translateStory, responseHeaders, run, TOTAL_TIMEOUT_MS };
  }
  if (typeof $done === 'function') run();
})();
