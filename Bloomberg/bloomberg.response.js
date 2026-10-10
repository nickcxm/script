/*
 * Bloomberg Baidu-primary / Google-backup body translation for Surge — 20261010-baidu-error-details-1.
 * Independently written against a user-provided story JSON response.
 * Only paragraph text is sent to the selected translation provider.
 * No Bloomberg headers, cookies, URLs, account data, or persistent storage.
 */
(() => {
  'use strict';

  const VERSION = '20261010-baidu-error-details-1';
  const INFO_MARKER = '_nickcxmTranslationInfo';
  const STORY_URL = /^https:\/\/cdn-mobapi\.bloomberg\.com\/wssmobile\/v1\/stories\/[A-Z0-9]{14}(?:\?[^#]*)?$/;
  const GOOGLE_URL = 'https://translate.googleapis.com/translate_a/single';
  const LEGACY_PREFIX = '【中文译文】';
  const TRANSLATION_MARKER = '_nickcxmTranslation';
  const SOURCE_COUNT = '_nickcxmSourceParagraphs';
  const PARAGRAPH_ID = '_nickcxmParagraphId';
  const SOURCE_IDS = '_nickcxmSourceIds';
  const MAX_BODY = 1024 * 1024;
  const MAX_COMPONENTS = 500;
  const MAX_REQUESTS = 48;
  const CHUNK_SIZE = 1200;
  const TOTAL_TIMEOUT_MS = 45000;
  const REQUEST_TIMEOUT_MS = 7000;
  const CONCURRENCY = 3;
  const DEFAULTS = Object.freeze({ enabled: true, removeAdConfig: true, debug: false, provider: 'baidu', baiduAppId: '', baiduKey: '' });

  function options(argument) {
    const supplied = typeof argument === 'string' ? JSON.parse(argument || '{}') : argument || {};
    if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied)) throw new Error('Invalid options');
    const result = { ...DEFAULTS };
    for (const key of Object.keys(DEFAULTS)) if (typeof supplied[key] === 'boolean') result[key] = supplied[key];
    if (typeof supplied.provider === 'string') result.provider = supplied.provider.trim().toLowerCase();
    if (!['baidu', 'google'].includes(result.provider)) throw new Error('Invalid provider');
    for (const key of ['baiduAppId', 'baiduKey']) if (typeof supplied[key] === 'string') {
      const value = supplied[key].trim(); result[key] = value === 'UNSET' ? '' : value;
    }
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

  function splitText(text, limit = CHUNK_SIZE) {
    // Prefer sentence/space boundaries; retain every source character.
    // Array.from avoids splitting UTF-16 surrogate pairs in long paragraphs.
    const characters = Array.from(text);
    const chunks = [];
    let position = 0;
    while (position < characters.length) {
      let end = Math.min(position + limit, characters.length);
      if (end < characters.length) {
        for (let i = end - 1; i > position + limit / 2; i--) {
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
      schedule(() => finish(Object.assign(new Error('Translation timeout'), { code: 'timeout' })), timeoutMs);
      try {
        httpClient.get(googleRequest(text, timeoutMs), (error, response, body) => {
          if (settled) return;
          if (error) { finish(Object.assign(new Error('Translation network failure'), { code: 'network' })); return; }
          if (Number(response?.status ?? response?.statusCode) !== 200) {
            finish(Object.assign(new Error('Translation HTTP failure'), { code: 'http', status: Number(response?.status ?? response?.statusCode) || 0 })); return;
          }
          try { finish(null, parseTranslation(body)); }
          catch (_) { finish(Object.assign(new Error('Translation response failure'), { code: 'response' })); }
        });
      } catch (_) { finish(new Error('Translation request failure')); }
    });
  }

  const BAIDU_URL = 'https://fanyi-api.baidu.com/api/trans/vip/translate';
  const BAIDU_INTERVAL_MS = 150; // Up to ~7 starts/sec per script, below advanced 10 QPS.

  function utf8Bytes(value) {
    const encoded = encodeURIComponent(value);
    const result = [];
    for (let i = 0; i < encoded.length; i++) {
      if (encoded[i] === '%') { result.push(parseInt(encoded.slice(i + 1, i + 3), 16)); i += 2; }
      else result.push(encoded.charCodeAt(i));
    }
    return result;
  }

  // Local RFC 1321 MD5 for Baidu's official signing protocol. No runtime dependency.
  function md5(value) {
    const input = utf8Bytes(value), length = input.length;
    const data = new Uint8Array(Math.ceil((length + 9) / 64) * 64);
    data.set(input); data[length] = 128;
    const bits = length * 8;
    for (let i = 0; i < 8; i++) data[data.length - 8 + i] = Math.floor(bits / Math.pow(256, i)) & 255;
    const shifts = [7,12,17,22, 5,9,14,20, 4,11,16,23, 6,10,15,21];
    const constants = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0);
    let a0 = 0x67452301, b0 = 0xefcdab89 | 0, c0 = 0x98badcfe | 0, d0 = 0x10325476;
    for (let offset = 0; offset < data.length; offset += 64) {
      const words = Array.from({ length: 16 }, (_, i) => {
        const at = offset + i * 4;
        return data[at] | data[at + 1] << 8 | data[at + 2] << 16 | data[at + 3] << 24;
      });
      let a = a0, b = b0, c = c0, d = d0;
      for (let i = 0; i < 64; i++) {
        const round = Math.floor(i / 16);
        const f = round === 0 ? (b & c) | (~b & d) : round === 1 ? (d & b) | (~d & c) : round === 2 ? b ^ c ^ d : c ^ (b | ~d);
        const g = round === 0 ? i : round === 1 ? (5 * i + 1) % 16 : round === 2 ? (3 * i + 5) % 16 : 7 * i % 16;
        const x = (a + f + constants[i] + words[g]) | 0, shift = shifts[round * 4 + i % 4];
        const rotated = x << shift | x >>> (32 - shift);
        a = d; d = c; c = b; b = (b + rotated) | 0;
      }
      a0 = (a0 + a) | 0; b0 = (b0 + b) | 0; c0 = (c0 + c) | 0; d0 = (d0 + d) | 0;
    }
    return [a0,b0,c0,d0].map(word => [0,8,16,24].map(shift => ((word >>> shift) & 255).toString(16).padStart(2,'0')).join('')).join('');
  }

  function baiduRequest(text, params, timeoutMs, salt = String(Date.now()) + String(Math.floor(Math.random() * 1000000))) {
    if (!params.baiduAppId || !params.baiduKey) throw Object.assign(new Error('missing Baidu credentials'), { code: 'baidu', baiduCode: 'missing' });
    if (!/^\d{5,30}$/.test(params.baiduAppId) || params.baiduKey.length > 512 || /[\r\n]/.test(params.baiduKey)) {
      throw Object.assign(new Error('invalid Baidu credentials'), { code: 'baidu', baiduCode: 'config' });
    }
    if (Array.from(text).length > 6000 || utf8Bytes(text).length > 6000) throw Object.assign(new Error('Baidu query too long'), { code: 'baidu', baiduCode: 'length' });
    const fields = { q: text, from: 'en', to: 'zh', appid: params.baiduAppId, salt,
      sign: md5(params.baiduAppId + text + salt + params.baiduKey) };
    return { url: BAIDU_URL, headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: Object.entries(fields).map(([key, value]) => encodeURIComponent(key) + '=' + encodeURIComponent(value)).join('&'),
      timeout: timeoutMs / 1000, 'auto-cookie': false, 'auto-redirect': false };
  }

  function safeBaiduMessage(value, params = {}) {
    let message = typeof value === 'string' ? value : '百度未提供 error_msg';
    for (const field of ['baiduKey', 'baiduAppId']) {
      const secret = params[field];
      if (typeof secret !== 'string' || !secret || secret === 'UNSET') continue;
      for (const form of new Set([secret, encodeURIComponent(secret)])) message = message.split(form).join('[已隐藏]');
    }
    return message.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
  }

  function parseBaidu(body, params = {}) {
    let response;
    try { response = JSON.parse(body); } catch (_) { throw Object.assign(new Error('invalid Baidu JSON'), { code: 'baidu', baiduCode: 'response' }); }
    if (response.error_code && String(response.error_code) !== '52000') {
      const code = /^\d{1,8}$/.test(String(response.error_code)) ? String(response.error_code) : 'unknown';
      throw Object.assign(new Error('Baidu error'), { code: 'baidu', baiduCode: code, baiduMessage: safeBaiduMessage(response.error_msg, params) });
    }
    if (!Array.isArray(response.trans_result) || !response.trans_result.length ||
        response.trans_result.some(item => typeof item?.dst !== 'string' || !item.dst.trim())) {
      throw Object.assign(new Error('invalid Baidu result'), { code: 'baidu', baiduCode: 'response' });
    }
    return response.trans_result.map(item => item.dst).join('\n\n').trim();
  }

  function baiduTransport(httpClient, params, schedule = setTimeout, clock = Date.now) {
    let nextStart = 0;
    let unavailable = null;
    return async (text, timeoutMs) => {
      if (unavailable) throw unavailable;
      // Validate credentials before reserving a time slot. Only timestamps are
      // retained in this run; neither credentials nor article text are stored.
      const deadline = clock() + timeoutMs;
      try { baiduRequest(text, params, timeoutMs, 'validation'); }
      catch (error) { unavailable = error; throw error; }
      const wait = Math.max(0, nextStart - clock());
      nextStart = Math.max(nextStart, clock()) + BAIDU_INTERVAL_MS;
      if (wait >= timeoutMs) throw Object.assign(new Error('Baidu scheduling timeout'), { code: 'timeout', provider: 'baidu' });
      if (wait) await new Promise(resolve => schedule(resolve, wait));
      if (unavailable) throw unavailable;
      const remaining = deadline - clock();
      if (remaining <= 0) throw Object.assign(new Error('Baidu timeout'), { code: 'timeout', provider: 'baidu' });
      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error, result) => {
          if (settled) return; settled = true;
          if (error) {
            error.provider = 'baidu';
            unavailable = error; // Circuit breaker for this run; no automatic primary retries.
            reject(error);
          } else resolve(result);
        };
        schedule(() => finish(Object.assign(new Error('Baidu timeout'), { code: 'timeout' })), remaining);
        try {
          httpClient.post(baiduRequest(text, params, remaining), (error, response, body) => {
            if (settled) return;
            if (error) { finish(Object.assign(new Error('Baidu network failure'), { code: 'network' })); return; }
            const status = Number(response?.status ?? response?.statusCode);
            if (status !== 200) {
              try { parseBaidu(body, params); } catch (error) {
                if (/^\d+$/.test(error.baiduCode || '')) { error.httpStatus = status; finish(error); return; }
              }
              finish(Object.assign(new Error('Baidu HTTP failure'), { code: 'http', status: status || 0 })); return;
            }
            try { finish(null, parseBaidu(body, params)); } catch (error) { finish(error); }
          });
        } catch (_) { finish(Object.assign(new Error('Baidu network failure'), { code: 'network' })); }
      });
    };
  }

  function limitConcurrency(translate, maximum) {
    const queue = [];
    let active = 0;
    function drain() {
      while (active < maximum && queue.length) {
        const item = queue.shift();
        const remaining = item.deadline - Date.now();
        if (remaining <= 0) { item.reject(Object.assign(new Error('Fallback queue timeout'), { code: 'timeout' })); continue; }
        active++;
        Promise.resolve().then(() => translate(item.text, remaining)).then(item.resolve, item.reject).finally(() => { active--; drain(); });
      }
    }
    return (text, timeoutMs) => new Promise((resolve, reject) => {
      queue.push({ text, deadline: Date.now() + timeoutMs, resolve, reject }); drain();
    });
  }

  function primaryWithFallback(primary, google, onFallback) {
    return async (text, timeoutMs) => {
      const start = Date.now();
      try { return await primary(text, Math.max(1, Math.min(4500, timeoutMs - 1500))); }
      catch (error) {
        onFallback(error);
        const remaining = timeoutMs - (Date.now() - start);
        if (remaining <= 0) throw Object.assign(new Error('Fallback timeout'), { code: 'timeout' });
        return google(text, remaining);
      }
    };
  }

  function marker(id) { return '【' + id + '】'; }
  const MARKERS = /[【\[［]\s*(?:[pPＰｐ]\s*)?([0-9０-９](?:[ \t]*[0-9０-９])*)\s*[】\]］]/g;
  function markerNumber(value) {
    return Number(value.replace(/\s/g, '').replace(/[０-９]/g, digit => String(digit.charCodeAt(0) - 65296)));
  }

  function cleanLegacy(text) {
    return text.replace(/^【中文译文】\s*/, '').replace(/\s*（翻译：谷歌）\s*$/, '').trim();
  }

  // Return safe correspondence ranges, not a guessed one-to-one mapping.
  // Full numbered output maps by ID, even if its order differs. Missing
  // numbers merge only the unresolved consecutive range. Invalid numbering
  // preserves the whole batch translation as a merged block.
  function alignTranslation(text, ids) {
    text = cleanLegacy(text);
    const matches = Array.from(text.matchAll(new RegExp(MARKERS.source, 'g')));
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

  function displayTranslation(piece) {
    // Already merged raw output may contain valid or damaged markers. Keep
    // it verbatim for manual checking, and add the known source range above.
    return piece.ids.map(marker).join('') + '\n' + piece.text;
  }

  function numberedParagraph(component, id) {
    const prefix = marker(id);
    if (component[PARAGRAPH_ID] === id && component.parts?.[0]?.role === 'text' &&
        component.parts[0].text === prefix + ' ') return component;
    if (component[PARAGRAPH_ID] === id && component.parts?.[0]?.role === 'text' &&
        component.parts[0].text === '【p' + id + '】 ') {
      return { ...component, parts: [{ ...component.parts[0], text: prefix + ' ' }, ...component.parts.slice(1)] };
    }
    const parts = Array.isArray(component.parts) ? component.parts : [];
    return { ...component, [PARAGRAPH_ID]: id, parts: [{ role: 'text', text: prefix + ' ' }, ...parts] };
  }

  function readableError(error) {
    if (error?.code === 'baidu') {
      const messages = { missing: '未配置百度 APP ID 或密钥。', config: '百度 APP ID 或密钥格式不正确。', length: '百度翻译文本超过长度限制。',
        '52003': '百度服务未授权，请检查 APP ID 和服务开通状态。', '54001': '百度签名错误，请检查密钥。', '54003': '百度访问频率受限。',
        '54004': '百度账户余额不足。', '58002': '百度翻译服务已关闭。', '58003': '百度出口 IP 被限制。', '90107': '百度认证未生效。' };
      const summary = messages[error.baiduCode] || '百度翻译错误。';
      if (/^\d+$/.test(error.baiduCode || '')) return summary + ' [error_code=' + error.baiduCode +
        '; error_msg=' + (error.baiduMessage || '百度未提供 error_msg') + (error.httpStatus ? '; HTTP=' + error.httpStatus : '') + ']';
      return summary;
    }
    if (error?.provider === 'baidu') {
      if (error.code === 'http') return '百度翻译返回 HTTP ' + error.status + '。';
      return error.code === 'timeout' ? '百度翻译超时。' : '百度翻译网络请求失败。';
    }
    if (error?.code === 'http') return 'Google 翻译返回 HTTP ' + error.status + '。';
    if (error?.code === 'timeout') return 'Google 翻译超时。';
    if (error?.code === 'network') return 'Google 翻译网络请求失败。';
    if (error?.code === 'response') return 'Google 翻译返回的数据无法解析。';
    if (error?.code === 'limit') return '本篇文章超过翻译请求数量限制。';
    return 'Google 翻译失败或正文结构无法解析。';
  }

  async function translateStory(story, translate, params = DEFAULTS, clock = Date.now) {
    if (!story || typeof story !== 'object' || Array.isArray(story) ||
        !Array.isArray(story.components) || story.components.length > MAX_COMPONENTS) throw new Error('Unsupported story response');
    const before = JSON.stringify(story);
    const source = story.components.filter(item => !item?.[INFO_MARKER]);
    const components = [];
    const entries = new Map();
    let id = 0;
    for (const original of source) {
      if (original?.role === 'p' && !isTranslation(original)) {
        id++;
        const component = numberedParagraph(original, id);
        components.push(component);
        entries.set(id, { id, index: components.length - 1, component });
      } else if (isTranslation(original)) {
        // Old grouped output has no reliable paragraph-level mapping: retain
        // it with its source numbers, remove only its obsolete visible labels.
        const count = Number.isInteger(original[SOURCE_COUNT]) && original[SOURCE_COUNT] > 0 ? original[SOURCE_COUNT] : 1;
        const ids = Array.isArray(original[SOURCE_IDS]) ? original[SOURCE_IDS] : Array.from({ length: Math.min(count, id) }, (_, i) => id - Math.min(count, id) + i + 1);
        const content = cleanLegacy(original.parts[0].text);
        const prefix = ids.map(marker).join('');
        const numbered = content.startsWith(prefix) ? content : prefix + '\n' + content;
        components.push({ ...original, [SOURCE_IDS]: ids, parts: [{ ...original.parts[0], text: numbered }] });
      } else components.push(original);
    }
    const covered = new Set();
    for (const component of components) if (isTranslation(component)) {
      for (const number of component[SOURCE_IDS] || []) if (entries.has(number)) covered.add(number);
    }
    const deadline = clock() + TOTAL_TIMEOUT_MS;
    const tasks = [];
    const errors = new Set();
    let batch = [];
    let batchSize = 0;
    let reserved = 0;
    function enqueue(task) {
      const size = task.chunks.length;
      if (reserved + size > MAX_REQUESTS) { errors.add(readableError({ code: 'limit' })); return; }
      reserved += size; tasks.push(task);
    }
    function flush() {
      if (batch.length) enqueue({ entries: batch, chunks: [batch.map(entry => marker(entry.id) + entry.source).join('\n\n')], long: false });
      batch = []; batchSize = 0;
    }
    for (let index = 0; index < components.length; index++) {
      const component = components[index];
      if (component?.role !== 'p' || isTranslation(component) || covered.has(component[PARAGRAPH_ID])) { flush(); continue; }
      const entry = entries.get(component[PARAGRAPH_ID]);
      try {
        const parts = component.parts.slice(1); // Skip our visible source number.
        entry.source = extractText(parts).trim();
      } catch (_) { flush(); errors.add(readableError(null)); continue; }
      if (!entry.source || !/[A-Za-z]/.test(entry.source)) { flush(); continue; }
      const length = Array.from(marker(entry.id) + entry.source).length;
      if (length > CHUNK_SIZE) {
        flush();
        enqueue({ entries: [entry], chunks: splitText(entry.source, CHUNK_SIZE - 32).map(chunk => marker(entry.id) + chunk), long: true });
        continue;
      }
      if (batch.length && batchSize + 2 + length > CHUNK_SIZE) flush();
      batchSize += (batch.length ? 2 : 0) + length;
      batch.push(entry);
    }
    flush();
    let next = 0, requests = 0, failed = 0;
    const placements = [];
    const modes = { exact: 0, partial: 0, merged: 0 };
    async function worker() {
      while (next < tasks.length) {
        const task = tasks[next++];
        const ids = task.entries.map(entry => entry.id);
        try {
          const results = [];
          for (const chunk of task.chunks) {
            const remaining = deadline - clock();
            if (remaining <= 0) { const error = new Error('timeout'); error.code = 'timeout'; throw error; }
            requests++;
            const translated = await translate(chunk, Math.min(REQUEST_TIMEOUT_MS, remaining));
            results.push(alignTranslation(translated, ids));
          }
          let result;
          if (task.long) {
            const content = results.map(item => item.pieces.map(piece => piece.text).join('')).join('');
            result = { mode: results.every(item => item.mode === 'exact') ? 'exact' : 'merged', pieces: [{ ids, text: content }] };
          } else result = results[0];
          modes[result.mode]++;
          for (const piece of result.pieces) {
            const end = entries.get(piece.ids[piece.ids.length - 1]);
            placements.push({ index: end.index, piece });
          }
        } catch (error) { failed++; errors.add(readableError(error)); }
      }
    }
    await Promise.all(Array.from({ length: Math.min(params.workerConcurrency || CONCURRENCY, tasks.length) }, worker));
    const after = new Map(placements.map(item => [item.index, item.piece]));
    const output = [];
    for (let index = 0; index < components.length; index++) {
      output.push(components[index]);
      if (after.has(index)) {
        const piece = after.get(index);
        output.push({ role: 'p', [TRANSLATION_MARKER]: true, [SOURCE_COUNT]: piece.ids.length, [SOURCE_IDS]: piece.ids,
          parts: [{ role: 'text', text: displayTranslation(piece) }] });
      }
    }
    if (errors.size) {
      const first = output.findIndex(item => item?.role === 'p' && !isTranslation(item));
      if (first !== -1) output.splice(first + 1, 0, { role: 'p', [INFO_MARKER]: 'notice',
        parts: [{ role: 'text', text: '翻译提示：' + Array.from(errors).join(' ') + ' 未成功的正文保留原文。' }] });
    }
    const result = { ...story, components: output };
    let adConfigChanged = false;
    if (params.removeAdConfig) {
      if (Object.prototype.hasOwnProperty.call(result, 'adParams')) { delete result.adParams; adConfigChanged = true; }
      if (typeof result.disableAds === 'boolean' && !result.disableAds) { result.disableAds = true; adConfigChanged = true; }
    }
    return { story: result, changed: JSON.stringify(result) !== before,
      stats: { paragraphs: tasks.reduce((sum, task) => sum + task.entries.length, 0), batches: tasks.length,
        translated: placements.reduce((sum, item) => sum + item.piece.ids.length, 0), translatedBlocks: placements.length,
        requests, failed, modes, adConfigChanged, version: VERSION } };
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
          const providerSuccess = { baidu: 0, google: 0 };
          const countSuccess = (name, translate) => async (text, timeoutMs) => {
            const value = await translate(text, timeoutMs); providerSuccess[name]++; return value;
          };
          const google = countSuccess('google', limitConcurrency(googleTransport($httpClient), CONCURRENCY));
          const fallbackReasons = new Set();
          let fallbackCount = 0;
          const translate = params.provider === 'baidu' ? primaryWithFallback(countSuccess('baidu', baiduTransport($httpClient, params)), google, error => { fallbackCount++; fallbackReasons.add(readableError(error)); }) : google;
          const output = await translateStory(original, translate, { ...params, workerConcurrency: params.provider === 'baidu' ? 6 : CONCURRENCY });
          const notices = output.story.components.filter(item => item?.[INFO_MARKER] === 'notice').map(item => item.parts?.[0]?.text).filter(Boolean);
          output.story.components = output.story.components.filter(item => !item?.[INFO_MARKER]);
          let provider;
          if (providerSuccess.baidu && providerSuccess.google) provider = '百度、Google（部分使用 Google 备用）';
          else if (providerSuccess.baidu) provider = '百度';
          else if (providerSuccess.google) provider = fallbackCount ? 'Google（百度失败后使用备用）' : 'Google';
          else if (output.stats.requests) provider = params.provider === 'baidu' ? '百度 → Google（本次未成功）' : 'Google（本次未成功）';
          else provider = '已有译文（本次未调用翻译接口）';
          if (fallbackReasons.size) notices.unshift('翻译提示：' + Array.from(fallbackReasons).join(' ') + ' 已尝试使用 Google 备用；未成功的内容保留原文。');
          const first = output.story.components.findIndex(item => item?.role === 'p' && !isTranslation(item));
          if (first !== -1) {
            output.story.components.splice(first + 1, 0, { role: 'p', [INFO_MARKER]: 'provider',
              parts: [{ role: 'text', text: '翻译服务：' + provider + (notices.length ? '\n' + notices.join('\n') : '') }] });
            output.changed = true;
          }
          output.stats.provider = params.provider; output.stats.googleFallbacks = fallbackCount;
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
    module.exports = { safeBaiduMessage, readableError, md5, utf8Bytes, baiduRequest, parseBaidu, baiduTransport, primaryWithFallback, limitConcurrency, BAIDU_INTERVAL_MS, VERSION, INFO_MARKER, PARAGRAPH_ID, SOURCE_IDS, marker, alignTranslation, displayTranslation, STORY_URL, LEGACY_PREFIX, TRANSLATION_MARKER, SOURCE_COUNT, options, extractText, splitText, googleRequest, parseTranslation,
      googleTransport, translateStory, responseHeaders, run, TOTAL_TIMEOUT_MS };
  }
  if (typeof $done === 'function') run();
})();
