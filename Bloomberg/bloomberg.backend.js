/* Bloomberg adapter: mini translation/cache/archive first, independent device-side Google fallback. */
(() => {
  'use strict';
  const VERSION = '20261026-direct-google-1';
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
    if (providers.includes('google')) notices.push('翻译服务：' + providers.map(value => value === 'google' && result.directFallback ? 'Google（设备直连备用）' : names[value] || value).join('、') + (result.cacheHit ? '（缓存）' : ''));
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

  const TOTAL_BUDGET_MS = 55000;
  const HEALTH_TIMEOUT_MS = 1200;
  const BACKEND_TIMEOUT_MS = 34000;
  const GOOGLE_BUDGET_MS = 18000;

  function networkMessage(error, service) {
    const message = String(error || '');
    if (/timeout|timed.?out|超时/i.test(message)) return service + '请求超时。';
    if (/permission|denied|not permitted|权限/i.test(message)) return service + '请求被权限或网络策略阻止。';
    return service + '网络请求失败。';
  }

  function jsonRequest(httpClient, method, request, timeoutMs, service) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, value) => { if (settled) return; settled = true; error ? reject(error) : resolve(value); };
      setTimeout(() => finish(new Error(service + '请求超时。')), timeoutMs);
      try {
        // No policy override: respect LAN/Ponte/VPN rules just like other requests.
        httpClient[method]({ ...request, timeout: timeoutMs / 1000, 'auto-cookie': false, 'auto-redirect': false }, (error, response, body) => {
          if (settled) return;
          if (error) return finish(new Error(networkMessage(error, service)));
          const status = Number(response?.status ?? response?.statusCode);
          if (status !== 200) return finish(new Error(service + '返回 HTTP ' + (status || 0) + '。'));
          try { finish(null, JSON.parse(body)); }
          catch (_) { finish(new Error(service + '返回的数据无法解析。')); }
        });
      } catch (error) { finish(new Error(networkMessage(error, service))); }
    });
  }

  function backend(httpClient, base, payload, timeoutMs = BACKEND_TIMEOUT_MS) {
    return jsonRequest(httpClient, 'post', { url: base + '/api/translate',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }, timeoutMs, 'mini 文章翻译接口');
  }

  function markerNumber(value) {
    return Number(value.replace(/\s/g, '').replace(/[０-９]/g, digit => String(digit.charCodeAt(0) - 65296)));
  }

  function alignGoogle(text, ids) {
    text = text.trim();
    if (!text.replace(new RegExp(MARKER.source, 'g'), '').trim()) throw new Error('Google 备用返回了空译文。');
    const matches = Array.from(text.matchAll(new RegExp(MARKER.source, 'g')));
    const valid = matches.every(item => ids.includes(markerNumber(item[1]))) &&
      new Set(matches.map(item => markerNumber(item[1]))).size === matches.length;
    const merged = () => ({ mode: 'merged', pieces: [{ ids, text }] });
    if (!text) throw new Error('Google returned empty translation');
    if (!matches.length || !valid) return merged();
    const before = text.slice(0, matches[0].index).trim();
    if (matches.length === ids.length && !before) {
      const pieces = matches.map((item, i) => ({ ids: [markerNumber(item[1])],
        text: text.slice(item.index + item[0].length, matches[i + 1]?.index ?? text.length).trim() }));
      if (pieces.some(piece => !piece.text)) return merged();
      return { mode: 'exact', pieces };
    }
    const positions = matches.map(item => ids.indexOf(markerNumber(item[1])));
    if (positions.some((value, i) => i && value <= positions[i - 1])) return merged();
    if (positions[0] === 0 && before) return merged();
    if (positions[0] > 0 && !before) return merged();
    const pieces = [];
    if (before) pieces.push({ ids: ids.slice(0, positions[0]), text: before });
    for (let i = 0; i < matches.length; i++) {
      const content = text.slice(matches[i].index + matches[i][0].length, matches[i + 1]?.index ?? text.length).trim();
      if (!content) return merged();
      pieces.push({ ids: ids.slice(positions[i], positions[i + 1] ?? ids.length), text: content });
    }
    return { mode: 'partial', pieces };
  }

  function googleBatches(segments) {
    const batches = [];
    let pending = [], size = 0;
    for (const item of segments) {
      const head = '【' + item.id + '】';
      const characters = Array.from(item.text.replace(/[\r\n]+/g, ' '));
      const limit = 1200 - head.length;
      for (let offset = 0; offset < characters.length;) {
        let end = Math.min(characters.length, offset + limit);
        if (end < characters.length) for (let i = end - 1; i > offset + limit / 2; i--) {
          if (/\s/.test(characters[i])) { end = i + 1; break; }
        }
        const text = characters.slice(offset, end).join(''); offset = end;
        const entry = { id: item.id, text: head + text };
        const length = Array.from(entry.text).length;
        if (pending.length && (size + 1 + length > 1200 || pending.some(value => value.id === item.id))) {
          batches.push(pending); pending = []; size = 0;
        }
        size += (pending.length ? 1 : 0) + length; pending.push(entry);
      }
    }
    if (pending.length) batches.push(pending);
    return batches;
  }

  function validateResult(result, payload) {
    if (!result || !Array.isArray(result.translations) || result.translations.length > 1000 ||
        !Array.isArray(result.warnings) || !result.warnings.every(x => typeof x === 'string') ||
        !Array.isArray(result.providers) || !result.providers.every(x => ['apple', 'baidu', 'google', 'mixed'].includes(x)) ||
        typeof result.titleTranslation !== 'string') throw new Error('mini 返回的翻译结果格式不正确。');
    const expected = new Set([0, ...payload.paragraphs.map(x => x.id)]);
    for (const piece of result.translations) if (!Array.isArray(piece.ids) || !piece.ids.length ||
        new Set(piece.ids).size !== piece.ids.length || !piece.ids.every(id => Number.isInteger(id) && expected.has(id)) ||
        typeof piece.text !== 'string' || !piece.text.trim()) throw new Error('mini 返回的段落对应关系不正确。');
    return result;
  }

  async function directGoogle(httpClient, segments, deadline) {
    const batches = googleBatches(segments), results = [], warnings = [];
    const expected = new Map(), successes = new Map();
    for (const batch of batches) for (const item of batch) expected.set(item.id, (expected.get(item.id) || 0) + 1);
    if (batches.length > 48) warnings.push('设备端 Google 备用达到批次上限，部分内容保留原文。');
    let next = 0;
    async function worker() {
      while (next < Math.min(48, batches.length)) {
        const index = next++, batch = batches[index];
        const remaining = deadline - Date.now();
        if (remaining <= 0) { warnings.push('设备端 Google 备用超过时间预算。'); break; }
        try {
          const query = batch.map(x => x.text).join('\n');
          const raw = await jsonRequest(httpClient, 'get', {
            url: 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh-CN&dt=t&q=' + encodeURIComponent(query),
            headers: { Accept: 'application/json' }
          }, Math.min(7000, remaining), '设备端 Google 备用');
          if (!Array.isArray(raw?.[0]) || !raw[0].length || raw[0].some(x => !Array.isArray(x) || typeof x[0] !== 'string')) throw new Error('设备端 Google 备用响应无法解析。');
          const translated = raw[0].map(x => x[0]).join('').trim();
          if (!/[\u3400-\u9fff]/.test(translated)) throw new Error('设备端 Google 备用未返回中文译文。');
          const pieces = alignGoogle(translated, batch.map(x => x.id)).pieces;
          results[index] = pieces;
          const covered = new Set(pieces.flatMap(x => x.ids));
          for (const item of batch) if (covered.has(item.id)) successes.set(item.id, (successes.get(item.id) || 0) + 1);
        } catch (error) { warnings.push(error.message || '设备端 Google 备用失败。'); }
      }
    }
    await Promise.all(Array.from({ length: Math.min(3, batches.length) }, () => worker()));
    const grouped = new Map();
    for (const pieces of results) for (const piece of pieces || []) {
      // Only retain a split paragraph after every fragment succeeds.
      if (!piece.ids.every(id => successes.get(id) === expected.get(id))) continue;
      const key = piece.ids.join(',');
      if (grouped.has(key)) grouped.get(key).text += piece.text;
      else grouped.set(key, { ...piece, provider: 'google' });
    }
    return { translations: Array.from(grouped.values()), warnings: Array.from(new Set(warnings)) };
  }

  async function translateWithFallback(httpClient, base, payload) {
    const deadline = Date.now() + TOTAL_BUDGET_MS;
    let result, reason;
    try {
      if (!/^https?:\/\/[A-Za-z0-9.:-]+$/.test(base)) throw new Error('mini 翻译服务地址设置不正确。');
      const health = await jsonRequest(httpClient, 'get', { url: base + '/health', headers: { Accept: 'application/json' } }, HEALTH_TIMEOUT_MS, 'mini 连接检查');
      if (health?.ok !== true) throw new Error('mini 服务健康检查未通过。');
      result = validateResult(await backend(httpClient, base, payload, Math.min(BACKEND_TIMEOUT_MS, deadline - Date.now())), payload);
    } catch (error) {
      reason = error.message || 'mini 翻译服务不可用。';
      result = { translations: [], titleTranslation: '', providers: [], warnings: [], complete: false, cacheHit: false };
    }
    const covered = new Set(result.translations.flatMap(piece => piece.ids));
    if (result.titleTranslation.trim()) covered.add(0);
    const missing = [{ id: 0, text: payload.article.title }, ...payload.paragraphs].filter(item => !covered.has(item.id));
    if (!missing.length) return { ...result, complete: true };
    const rescue = await directGoogle(httpClient, missing, Math.min(deadline, Date.now() + GOOGLE_BUDGET_MS));
    const translations = [...result.translations, ...rescue.translations];
    const allCovered = new Set(translations.flatMap(piece => piece.ids));
    if (result.titleTranslation.trim()) allCovered.add(0);
    return { ...result, translations, titleTranslation: result.titleTranslation || rescue.translations.find(piece => piece.ids.length === 1 && piece.ids[0] === 0)?.text || '',
      providers: Array.from(new Set([...result.providers, ...(rescue.translations.length ? ['google'] : [])])),
      warnings: Array.from(new Set([...result.warnings, reason || 'mini 未完整翻译本文，已尝试用设备端 Google 补全缺失段落。',
        '设备直连 Google 的用量和译文未回传 mini，无法计入其统计与存档。', ...rescue.warnings])),
      cacheHit: false, directFallback: true, complete: missing.every(item => allCovered.has(item.id)) };
  }

  async function run() {
    let done = {}, story, params;
    try {
      params = JSON.parse(typeof $argument === 'string' && $argument ? $argument : '{}');
      if (params.enabled === false || $request.method !== 'GET' || !STORY.test($request.url) || Number($response.status) !== 200 || typeof $response.body !== 'string' || $response.body.length > 1048576) return $done({});
      const kind = Object.entries($response.headers || {}).find(([key]) => key.toLowerCase() === 'content-type')?.[1] || '';
      if (!/\bapplication\/json\b/i.test(kind)) return $done({});
      const base = typeof params.backendUrl === 'string' ? params.backendUrl.replace(/\/+$/, '') : 'http://192.168.50.71:18746';
      story = JSON.parse($response.body);
      const payload = prepare(story, $request.url);
      if (!payload.paragraphs.length) return $done({});
      const result = await translateWithFallback($httpClient, base, payload);
      done = { body: JSON.stringify(render(story, result, { removeAdConfig: params.removeAdConfig !== false })), headers: headers($response.headers) };
      if (params.debug) console.log('[Bloomberg Backend] ' + JSON.stringify({ version: VERSION, cacheHit: result.cacheHit, providers: result.providers, paragraphs: payload.paragraphs.length }));
    } catch (error) {
      if (Array.isArray(story?.components)) done = { body: JSON.stringify(failure(story, '翻译提示：' + (error.message || '后端翻译失败，已保留原文。'))), headers: headers($response.headers) };
    }
    $done(done);
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { VERSION, STORY, prepare, render, textOf, sourceParts, headers, failure, backend, googleBatches, alignGoogle, directGoogle, validateResult, translateWithFallback, TOTAL_BUDGET_MS, HEALTH_TIMEOUT_MS, BACKEND_TIMEOUT_MS, run };
  if (typeof $done === 'function') run();
})();
