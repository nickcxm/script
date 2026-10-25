/* Bloomberg response adapter. Translation, caching and archiving run on the user's mini. */
(() => {
  'use strict';
  const VERSION = '20261025-backend-1';
  const STORY = /^https:\/\/cdn-mobapi\.bloomberg\.com\/wssmobile\/v1\/stories\/([A-Z0-9]{14})(?:\?[^#]*)?$/;
  const NUMBER = '_nickcxmParagraphId';
  const TRANSLATION = '_nickcxmTranslation';
  const INFO = '_nickcxmTranslationInfo';
  const SOURCES = '_nickcxmSourceIds';
  const INLINE = '_nickcxmInlineSourceIds';
  const MARKER = /[【\[［]\s*(?:[pPＰｐ]\s*)?([0-9０-９](?:[ \t]*[0-9０-９])*)\s*[】\]］]/g;

  function textOf(parts, depth = 0) {
    if (!Array.isArray(parts) || depth > 20) throw new Error('Unsupported paragraph');
    return parts.map(part => {
      if (!part || typeof part !== 'object') throw new Error('Unsupported part');
      if (Array.isArray(part.parts) && part.parts.length) return textOf(part.parts, depth + 1);
      return typeof part.text === 'string' ? part.text : '';
    }).join('');
  }

  function sourceParts(component) {
    let parts = (component.parts || []).filter(part => !part[TRANSLATION]);
    if (component[NUMBER] && parts[0]?.role === 'text' &&
        /^(?:\d+\.\s*|【(?:p)?\d+】\s*)$/.test(parts[0].text || '')) parts = parts.slice(1);
    return parts;
  }

  function prepare(story, requestUrl) {
    if (!story || !Array.isArray(story.components) || story.components.length > 500 || typeof story.title !== 'string') throw new Error('Unsupported article');
    const match = STORY.exec(requestUrl);
    if (!match) throw new Error('Unsupported URL');
    const paragraphs = [];
    let id = 0;
    for (const component of story.components) {
      if (component?.[INFO] || component?.[TRANSLATION] || component?.role !== 'p') continue;
      id++;
      const text = textOf(sourceParts(component)).trim();
      if (text) paragraphs.push({ id, text });
    }
    const title = story._nickcxmTitleTranslated ? story.title.split('\n')[0] : story.title;
    // Only a canonical public article URL or the exact known API path is sent.
    const canonical = typeof story.longURL === 'string' && /^https:\/\/(?:www\.)?bloomberg\.com\//.test(story.longURL) ? story.longURL.split(/[?#]/)[0] : requestUrl.split('?')[0];
    return { article: { id: match[1], title, url: canonical,
      updatedAt: ['number', 'string'].includes(typeof story.updatedAt) ? String(story.updatedAt) : '',
      publishedAt: ['number', 'string'].includes(typeof story.published) ? String(story.published) : '' }, paragraphs };
  }

  function render(story, result, params) {
    if (!Array.isArray(result.translations) || result.translations.length > 1000 || !Array.isArray(result.warnings)) throw new Error('Invalid backend response');
    const components = [];
    const positions = new Map();
    let id = 0;
    for (const original of story.components) {
      if (original?.[INFO] || original?.[TRANSLATION]) continue;
      if (original?.role !== 'p') { components.push(original); continue; }
      id++;
      const component = { ...original, [NUMBER]: id,
        parts: [{ role: 'text', text: id + '. ' }, ...sourceParts(original)] };
      delete component[INLINE];
      positions.set(id, components.length); components.push(component);
    }
    for (const piece of result.translations) {
      if (!Array.isArray(piece.ids) || !piece.ids.length || !piece.ids.every(value => Number.isInteger(value) && value >= 0 && value <= id) || typeof piece.text !== 'string' || !piece.text.trim()) throw new Error('Invalid translation mapping');
      if (piece.ids.length === 1 && piece.ids[0] === 0) continue;
      const bodyIds = piece.ids.filter(value => positions.has(value));
      if (!bodyIds.length) continue;
      const index = positions.get(Math.max(...bodyIds));
      // Exact paragraphs use decimal numbers; unresolved groups retain their range.
      const translation = piece.text.replace(MARKER, (_, number) => Number(number.replace(/\s/g, '').replace(/[０-９]/g, digit => String(digit.charCodeAt(0) - 65296))) + '. ');
      components[index].parts.push({ role: 'text', text: '\n' + piece.ids.map(value => value + '.').join(' ') + ' ' + translation,
        [TRANSLATION]: true, [SOURCES]: piece.ids });
      components[index][INLINE] = [...(components[index][INLINE] || []), ...bodyIds];
    }
    const output = { ...story, components };
    const englishTitle = story._nickcxmTitleTranslated ? story.title.split('\n')[0] : story.title;
    if (typeof result.titleTranslation === 'string' && result.titleTranslation.trim()) {
      output.title = englishTitle + '\n' + result.titleTranslation.trim(); output._nickcxmTitleTranslated = true;
    }
    const names = { apple: 'Apple 本机翻译', baidu: '百度', google: 'Google', mixed: '混合' };
    const providers = Array.isArray(result.providers) ? result.providers : [];
    const notices = [];
    if (providers.includes('google')) notices.push('翻译服务：' + providers.map(value => names[value] || value).join('、') + (result.cacheHit ? '（缓存）' : ''));
    if (result.warnings.length) notices.push('翻译提示：' + result.warnings.filter(value => typeof value === 'string').join(' '));
    if (result.complete === false) notices.push('部分内容未能翻译，已保留原文。');
    const first = components.findIndex(value => value?.role === 'p');
    if (notices.length && first !== -1) components.splice(first + 1, 0, { role: 'p', [INFO]: 'notice', parts: [{ role: 'text', text: notices.join('\n') }] });
    if (params.removeAdConfig) {
      delete output.adParams;
      if (typeof output.disableAds === 'boolean') output.disableAds = true;
    }
    return output;
  }

  function headers(original) {
    const result = {};
    for (const [key, value] of Object.entries(original || {})) if (!/^(?:content-length|content-encoding|transfer-encoding|etag|content-md5|digest|cache-control)$/i.test(key)) result[key] = value;
    result['Cache-Control'] = 'no-store';
    return result;
  }

  function failure(story, message) {
    const first = story.components.findIndex(value => value?.role === 'p' && !value[TRANSLATION] && !value[INFO]);
    if (first < 0) return story;
    const components = story.components.filter(value => !value?.[INFO]);
    const index = components.findIndex(value => value?.role === 'p' && !value[TRANSLATION]);
    components.splice(index + 1, 0, { role: 'p', [INFO]: 'notice', parts: [{ role: 'text', text: message }] });
    return { ...story, components };
  }

  function backend(httpClient, base, payload) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, value) => { if (settled) return; settled = true; error ? reject(error) : resolve(value); };
      // One timer per article; compatible with Surge's default JS engine.
      setTimeout(() => finish(new Error('翻译服务超时，已保留原文。')), 50000);
      try {
        httpClient.post({ url: base + '/api/translate', policy: 'DIRECT', timeout: 49,
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), 'auto-cookie': false, 'auto-redirect': false }, (error, response, body) => {
          if (error) return finish(new Error('无法连接 mini 翻译服务，已保留原文。'));
          try {
            const value = JSON.parse(body);
            if (Number(response?.status ?? response?.statusCode) !== 200) return finish(new Error(typeof value.message === 'string' ? value.message : '翻译服务暂不可用，已保留原文。'));
            finish(null, value);
          } catch (_) { finish(new Error('翻译服务返回的数据无法解析，已保留原文。')); }
        });
      } catch (_) { finish(new Error('无法连接 mini 翻译服务，已保留原文。')); }
    });
  }

  async function run() {
    let done = {}, story, params;
    try {
      params = JSON.parse(typeof $argument === 'string' && $argument ? $argument : '{}');
      if (params.enabled === false || $request.method !== 'GET' || !STORY.test($request.url) || Number($response.status) !== 200 || typeof $response.body !== 'string' || $response.body.length > 1048576) return $done({});
      const kind = Object.entries($response.headers || {}).find(([key]) => key.toLowerCase() === 'content-type')?.[1] || '';
      if (!/\bapplication\/json\b/i.test(kind)) return $done({});
      const base = typeof params.backendUrl === 'string' ? params.backendUrl.replace(/\/+$/, '') : 'http://192.168.50.71:18746';
      if (!/^https?:\/\/[A-Za-z0-9.:-]+$/.test(base)) throw new Error('翻译服务地址设置不正确。');
      story = JSON.parse($response.body);
      const payload = prepare(story, $request.url);
      if (!payload.paragraphs.length) return $done({});
      const result = await backend($httpClient, base, payload);
      done = { body: JSON.stringify(render(story, result, { removeAdConfig: params.removeAdConfig !== false })), headers: headers($response.headers) };
      if (params.debug) console.log('[Bloomberg Backend] ' + JSON.stringify({ version: VERSION, cacheHit: result.cacheHit, providers: result.providers, paragraphs: payload.paragraphs.length }));
    } catch (error) {
      if (Array.isArray(story?.components)) done = { body: JSON.stringify(failure(story, '翻译提示：' + (error.message || '后端翻译失败，已保留原文。'))), headers: headers($response.headers) };
    }
    $done(done);
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { VERSION, STORY, prepare, render, textOf, sourceParts, headers, failure, backend, run };
  if (typeof $done === 'function') run();
})();
