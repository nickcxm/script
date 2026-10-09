'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const api = require('../bloomberg.response.js');
const source = fs.readFileSync(path.join(__dirname, '../bloomberg.response.js'), 'utf8');
const REQUEST_URL = 'https://cdn-mobapi.bloomberg.com/wssmobile/v1/stories/TMM9Y6T3BZM200?updatedAt=test';
const p = text => ({ role: 'p', parts: [{ role: 'text', text }] });
function fixture() {
  return { title: 'Untouched title', aiSummary: ['Untouched summary'], premium: true, isMetered: true, disableAds: false, adParams: { dfpTarget: { key: 'keep private' } },
    components: [p('First paragraph.'), { role: 'p', parts: [{ role: 'text', text: 'Read ' }, { role: 'anchor', text: 'more', parts: [{ role: 'text', text: 'more' }], links: { self: { href: '/related' } }, security: { text: 'DO NOT SEND' } }, { role: 'text', text: ' here.' }] },
      { role: 'image', caption: 'Untouched image caption', imageURLs: { default: 'https://example.test/image' } },
      p('Third paragraph.'), { role: 'webview', html: '<table>Untouched related reading</table>' }] };
}
function ids(text) { return [...text.matchAll(/【\s*(?:p\s*)?(\d+)\s*】/g)].map(match => Number(match[1])); }
const translated = async text => ids(text).map(id => api.marker(id) + '中文段落' + id + '。').join('\n\n');
function originals(story) { return story.components.filter(item => !item[api.TRANSLATION_MARKER] && !item[api.INFO_MARKER]); }
function withoutNumbers(component) {
  if (component.role !== 'p' || !component[api.PARAGRAPH_ID]) return component;
  const result = { ...component, parts: component.parts.slice(1) }; delete result[api.PARAGRAPH_ID]; return result;
}
function assertOriginals(result, expected) { assert.deepEqual(originals(result).map(withoutNumbers), expected.components); }
async function execute({ story = fixture(), url = REQUEST_URL, method = 'GET', status = 200, body = JSON.stringify(story), contentType = 'application/json', argument = '{}', get } = {}) {
  let result, called = 0, resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });
  const requests = [], timers = [], logs = [];
  vm.runInNewContext(source, {
    console: { log(value) { logs.push(value); } }, setTimeout(callback) { timers.push(callback); },
    $request: { url, method, headers: { Cookie: 'SECRET_COOKIE', Authorization: 'SECRET_AUTH' } },
    $response: { status, body, headers: { 'Content-Type': contentType, 'Content-Encoding': 'gzip', 'Content-Length': '100', ETag: 'old', 'Cache-Control': 'public', 'X-Other': 'keep' } }, $argument: argument,
    $persistentStore: new Proxy({}, { get() { throw Error('Forbidden storage'); } }),
    $httpClient: { get(options, callback) {
      requests.push(options);
      if (get) return get(options, callback);
      const q = new URL(options.url).searchParams.get('q');
      callback(null, { status: 200 }, JSON.stringify([[...ids(q).map(id => [api.marker(id) + '中文段落' + id + '。', 'original'])], null, 'en']));
    } },
    $done(value) { called++; result = value; resolveDone(); },
  }, { timeout: 2000 });
  await done; assert.equal(called, 1);
  for (const callback of timers) callback();
  await Promise.resolve(); assert.equal(called, 1);
  return { result, requests, logs };
}

test('extract text joins nested anchor text once, excluding link/security metadata', () => {
  assert.equal(api.extractText(fixture().components[1].parts), 'Read more here.');
});
test('invalid and excessive nesting are rejected', () => {
  assert.throws(() => api.extractText([null]));
  let parts = [{ role: 'text', text: 'deep' }];
  for (let i = 0; i < 25; i++) parts = [{ role: 'anchor', parts }];
  assert.throws(() => api.extractText(parts));
});
test('complete markers map one Chinese paragraph after each numbered original', async () => {
  const original = fixture(), snapshot = JSON.stringify(original), sent = [];
  const output = await api.translateStory(original, async text => { sent.push(text); return translated(text); });
  assert.equal(JSON.stringify(original), snapshot); assertOriginals(output.story, original);
  assert.equal(sent.length, 2); assert.deepEqual(ids(sent[0]), [1, 2]); assert.deepEqual(ids(sent[1]), [3]);
  assert.ok(sent[0].includes('Read more here.')); assert.equal(sent.some(text => text.includes('DO NOT SEND')), false);
  assert.equal(output.story.components[0].parts[0].text, api.marker(1) + ' ');
  assert.equal(output.story.components[1].parts[0].text, api.marker(1) + '\n中文段落1。');
  assert.equal(output.story.components[2].parts[0].text, api.marker(2) + ' ');
  assert.equal(output.story.components[3].parts[0].text, api.marker(2) + '\n中文段落2。');
  assert.equal(output.stats.translated, 3); assert.equal(output.stats.modes.exact, 2);
  assert.equal(output.story.title, original.title); assert.deepEqual(output.story.aiSummary, original.aiSummary);
  assert.equal(output.story.premium, true); assert.equal(output.story.isMetered, true);
  assert.equal(JSON.stringify(output.story).includes('翻译：谷歌'), false);
});
test('full output can be returned out of order and still match by number', () => {
  const aligned = api.alignTranslation(api.marker(2) + '第二段。' + api.marker(1) + '第一段。', [1, 2]);
  assert.equal(aligned.mode, 'exact'); assert.deepEqual(aligned.pieces.map(piece => piece.ids), [[2], [1]]);
});
test('partial markers combine unresolved consecutive source ranges without discarding text', () => {
  const output = api.alignTranslation(api.marker(1) + '第一和第二段。' + api.marker(3) + '第三段。', [1, 2, 3]);
  assert.equal(output.mode, 'partial'); assert.deepEqual(output.pieces.map(piece => piece.ids), [[1, 2], [3]]);
  assert.equal(api.displayTranslation(output.pieces[0]), api.marker(1) + api.marker(2) + '\n第一和第二段。');
});
test('text before the first surviving marker maps to missing initial paragraphs', () => {
  const output = api.alignTranslation('前两段译文。' + api.marker(3) + '第三段。', [1, 2, 3]);
  assert.equal(output.mode, 'partial'); assert.deepEqual(output.pieces.map(piece => piece.ids), [[1, 2], [3]]);
});
for (const [name, value] of [
  ['missing markers', '整批中文没有编号。'],
  ['duplicate markers', '【1】第一段。【1】重复编号。'],
  ['unknown marker', '【99】无法确定的中文。'],
  ['partial order mismatch', '【3】第三段。【1】第一段。'],
  ['empty numbered segment', '【1】【2】第二段。'],
]) {
  test(name + ' retains the entire translation as a merged numbered block', () => {
    const output = api.alignTranslation(value, [1, 2, 3]);
    assert.equal(output.mode, 'merged'); assert.deepEqual(output.pieces[0].ids, [1, 2, 3]); assert.equal(output.pieces[0].text, value);
  });
}
test('fallback display does not lose successfully translated batches or move images', async () => {
  const original = fixture();
  const output = await api.translateStory(original, async () => '整批中文译文。');
  assertOriginals(output.story, original);
  assert.equal(output.story.components[2].parts[0].text, api.marker(1) + api.marker(2) + '\n整批中文译文。');
  assert.equal(output.story.components[3].role, 'image'); assert.equal(output.stats.modes.merged, 2);
  assert.equal(output.story.components.some(item => item[api.INFO_MARKER]), false);
});
test('images, related reading, headings and unknown roles all separate request batches', async () => {
  const separators = [{ role: 'image' }, { role: 'webview' }, { role: 'heading' }, { role: 'unknown' }];
  const original = { components: separators.flatMap((separator, i) => [p('Body A ' + i), p('Body B ' + i), separator]) };
  const sent = []; const output = await api.translateStory(original, async text => { sent.push(ids(text)); return translated(text); });
  assert.deepEqual(sent, [[1, 2], [3, 4], [5, 6], [7, 8]]); assertOriginals(output.story, original);
});
test('complete numbered paragraphs are packed without cutting markers or paragraph boundaries', async () => {
  const original = { components: [p('First sentence. '.repeat(45)), p('Second sentence. '.repeat(45)), p('Third paragraph.')] };
  const sent = []; const output = await api.translateStory(original, async text => { sent.push(text); return translated(text); });
  assert.equal(sent.length, 2); assert.deepEqual(sent.map(ids), [[1], [2, 3]]);
  assert.ok(sent.every(text => Array.from(text).length <= 1200)); assert.equal(output.stats.translated, 3);
});
test('long paragraph fragments reuse its number and recombine after the same original', async () => {
  const original = { components: [p('Long text with emoji 😀. '.repeat(140))] };
  const sent = []; const output = await api.translateStory(original, async text => { sent.push(ids(text)); return translated(text); });
  assert.ok(sent.length > 1); assert.ok(sent.every(value => value.length === 1 && value[0] === 1));
  assert.equal(output.story.components.filter(item => item[api.TRANSLATION_MARKER]).length, 1);
  assertOriginals(output.story, original);
  assert.equal(api.splitText('😀'.repeat(1400)).join(''), '😀'.repeat(1400));
});
test('a failed long fragment keeps the numbered original and reports the error', async () => {
  const original = { components: [p('Long paragraph. '.repeat(160))] }; let requests = 0;
  const output = await api.translateStory(original, async text => { if (++requests === 2) throw Error('failure'); return translated(text); });
  assertOriginals(output.story, original); assert.equal(output.story.components.some(item => item[api.TRANSLATION_MARKER]), false);
  assert.equal(output.story.components[1][api.INFO_MARKER], 'notice');
});
test('numbered source and exact/partial/merged translations remain idempotent', async () => {
  for (const translate of [translated, async () => '合并译文。', async text => api.marker(ids(text)[0]) + '部分编号译文。']) {
    const first = await api.translateStory(fixture(), translate); let calls = 0;
    const second = await api.translateStory(first.story, async () => { calls++; return '不应调用'; });
    assert.equal(calls, 0); assert.equal(second.changed, false); assert.deepEqual(second.story, first.story);
  }
});
test('old visible labels are removed and previous grouped translations retain source numbers', async () => {
  const old = { components: [p('First original.'), p('Second original.'),
    { role: 'p', [api.TRANSLATION_MARKER]: true, [api.SOURCE_COUNT]: 2, parts: [{ role: 'text', text: '【中文译文】\n旧版中文。\n\n（翻译：谷歌）' }] }] };
  const output = await api.translateStory(old, async () => { throw Error('should not translate'); });
  const chinese = output.story.components[2]; assert.deepEqual(chinese[api.SOURCE_IDS], [1, 2]);
  assert.equal(chinese.parts[0].text, api.marker(1) + api.marker(2) + '\n旧版中文。');
});
test('translation failure affects only its batch and old notices are not translated on retry', async () => {
  const original = fixture();
  const first = await api.translateStory(original, async text => { if (ids(text)[0] === 1) throw Error('failure'); return translated(text); });
  assertOriginals(first.story, original); assert.equal(first.stats.translated, 1); assert.equal(first.story.components[1][api.INFO_MARKER], 'notice');
  const sent = []; const second = await api.translateStory(first.story, async text => { sent.push(text); return translated(text); });
  assert.equal(sent.length, 1); assert.deepEqual(ids(sent[0]), [1, 2]); assert.equal(sent[0].includes('翻译提示'), false);
  assert.equal(second.story.components.some(item => item[api.INFO_MARKER]), false);
});
test('concurrency and total request count remain bounded', async () => {
  const original = { components: Array.from({ length: 100 }, (_, i) => [p('Paragraph ' + i), { role: 'image' }]).flat() };
  let active = 0, peak = 0, calls = 0;
  const output = await api.translateStory(original, async text => { calls++; active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 1)); active--; return translated(text); });
  assert.equal(calls, 48); assert.equal(peak, 3); assert.equal(output.stats.requests, 48);
  assert.ok(output.story.components.some(item => item[api.INFO_MARKER]));
});
test('deadline stops queued requests without losing original text', async () => {
  let now = 0, calls = 0;
  const original = fixture();
  const output = await api.translateStory(original, async text => { calls++; now += api.TOTAL_TIMEOUT_MS; return translated(text); }, { removeAdConfig: false }, () => now);
  assert.equal(calls, 1); assertOriginals(output.story, original); assert.equal(output.stats.failed, 1);
});
test('ad removal is limited and switchable; metadata and non-body components are retained', async () => {
  const original = fixture();
  const removed = await api.translateStory(original, translated); assert.equal('adParams' in removed.story, false); assert.equal(removed.story.disableAds, true);
  const kept = await api.translateStory(original, translated, { removeAdConfig: false }); assert.deepEqual(kept.story.adParams, original.adParams); assert.equal(kept.story.disableAds, false);
  assertOriginals(removed.story, original);
});
test('Google parser joins sentence fragments and keeps paragraph markers', () => {
  assert.equal(api.parseTranslation('[[["【1】第一句。","first"],["第二句。","second"]],null,"en"]'), '【1】第一句。第二句。');
  for (const body of ['<html>blocked</html>', '{}', '[[]]', '[[[null]]]', '[[["English only"]]]']) assert.throws(() => api.parseTranslation(body));
});
test('runtime sends only numbered body text to Google and completes exactly once', async () => {
  const { result, requests, logs } = await execute({ argument: '{"debug":true}' });
  assert.equal(requests.length, 2); assertOriginals(JSON.parse(result.body), fixture());
  for (const request of requests) {
    const target = new URL(request.url); assert.equal(target.origin, 'https://translate.googleapis.com');
    assert.equal(request['auto-cookie'], false); assert.equal(request['auto-redirect'], false); assert.deepEqual(Object.keys(request.headers), ['Accept']);
    assert.equal(JSON.stringify(request).includes('SECRET'), false); assert.equal(JSON.stringify(request).includes('DO NOT SEND'), false);
  }
  assert.equal(JSON.stringify(logs).includes('SECRET'), false); assert.equal(JSON.stringify(logs).includes('First paragraph'), false);
  assert.equal(result.headers['Content-Length'], undefined); assert.equal(result.headers['Content-Encoding'], undefined); assert.equal(result.headers.ETag, undefined);
  assert.equal(result.headers['Cache-Control'], 'no-store'); assert.equal(result.headers['X-Other'], 'keep');
});
test('HTTP and network failures show a safe error category without server payload or credentials', async () => {
  for (const [get, pattern] of [[(_, cb) => cb(null, { status: 429 }, 'PRIVATE_SERVER_MESSAGE'), /HTTP 429/], [(_, cb) => cb('PRIVATE_ERROR', null, null), /网络/], [(_, cb) => cb(null, { status: 200 }, '<html>bad</html>'), /无法解析/]]) {
    const { result } = await execute({ get }); const output = JSON.parse(result.body); assertOriginals(output, fixture());
    assert.match(output.components[1].parts[0].text, pattern); assert.equal(result.body.includes('PRIVATE_'), false);
  }
});
test('late HTTP callbacks do not resolve twice after timeout', async () => {
  let callback, timeout;
  const transport = api.googleTransport({ get(_, cb) { callback = cb; } }, cb => { timeout = cb; });
  const promise = transport('【1】English', 10); const rejected = assert.rejects(promise, /timeout/);
  timeout(); await rejected; callback(null, { status: 200 }, '[[["【1】迟到中文"]]]');
});
test('unrelated routes, invalid JSON/options and disabled translation pass through', async () => {
  for (const options of [{ url: 'https://mobapi.bloomberg.com/wssmobile/v1/stories/TMM9Y6T3BZM200' }, { url: 'https://cdn-mobapi.bloomberg.com/wssmobile/v1/stories/find' }, { status: 304 }, { contentType: 'text/html' }, { method: 'POST' }, { body: '{bad' }, { argument: '{bad' }, { argument: '{"enabled":false}' }]) {
    const { result, requests } = await execute(options); assert.equal(Object.keys(result).length, 0); assert.equal(requests.length, 0);
  }
});
test('module scope, Google-only settings, pinned URL and parameter rendering remain valid', () => {
  const text = fs.readFileSync(path.join(__dirname, '../Bloomberg.Translate.sgmodule'), 'utf8');
  assert.equal(/AI地址|AIToken|AI模型|智谱密钥/.test(text), false);
  const line = text.split('\n').find(line => line.startsWith('nickcxm.'));
  const regex = new RegExp(line.match(/pattern=(.*?), requires-body/)[1]); assert.ok(regex.test(REQUEST_URL));
  assert.equal(regex.test('https://cdn-mobapi.bloomberg.com/wssmobile/v1/stories/find'), false);
  assert.match(line, /script-path=https:\/\/raw\.githubusercontent\.com\/nickcxm\/script\/[a-f0-9]{40}\//);
  const values = Object.fromEntries(text.match(/^#!arguments=(.*)$/m)[1].split(',').map(item => item.split(':')));
  const argument = line.match(/argument="(.*)"$/)[1].replace(/\{\{\{(.*?)\}\}\}/g, (_, name) => values[name]);
  assert.deepEqual(JSON.parse(argument), { enabled: true, removeAdConfig: true, debug: false });
});


for (const form of ['[1]', '【1】', '【1]', '[1】', '【 1 】', '【1 】', '［１］', '[ １ 】', '【p1】', '[ P 1 ]', '【ｐ１］']) {
  test('marker normalization accepts ' + form, () => {
    const output = api.alignTranslation(form + '中文。', [1]);
    assert.equal(output.mode, 'exact'); assert.deepEqual(output.pieces[0].ids, [1]);
    assert.equal(output.pieces[0].text, '中文。');
  });
}
test('spaces between marker digits normalize without affecting the display number', () => {
  const output = api.alignTranslation('[ 1 0 ]第十段。', [10]);
  assert.equal(output.mode, 'exact'); assert.deepEqual(output.pieces[0].ids, [10]);
  assert.equal(api.displayTranslation(output.pieces[0]), '【10】\n第十段。');
});
test('mixed bracket forms map independently and normalized duplicate ids merge safely', () => {
  const output = api.alignTranslation('[1]第一段。【 ２ ]第二段。［p3】第三段。', [1, 2, 3]);
  assert.equal(output.mode, 'exact'); assert.deepEqual(output.pieces.map(piece => piece.ids), [[1], [2], [3]]);
  const duplicate = api.alignTranslation('[1]第一段。【１】重复。', [1, 2]);
  assert.equal(duplicate.mode, 'merged'); assert.deepEqual(duplicate.pieces[0].ids, [1, 2]);
});
