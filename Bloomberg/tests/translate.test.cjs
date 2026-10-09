'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const api = require('../bloomberg.response.js');
const source = fs.readFileSync(path.join(__dirname, '../bloomberg.response.js'), 'utf8');
function bodyComponents(story) { return story.components.filter(item => !item?.[api.INFO_MARKER]); }
function translatedText(component) { return component.parts[0].text.replace(/\n\n（翻译：谷歌）$/, ''); }
const REQUEST_URL = 'https://cdn-mobapi.bloomberg.com/wssmobile/v1/stories/TMM9Y6T3BZM200?updatedAt=test&contentCliff=false';
function paragraph(text) { return { role: 'p', parts: [{ role: 'text', text }] }; }
function fixture() {
  return { title: 'Original title', aiSummary: ['Original summary'], premium: true, isMetered: true,
    disableAds: false, adParams: { dfpTarget: { language: 'English' } },
    components: [paragraph('The company postponed its IPO.'),
      { role: 'p', parts: [{ role: 'text', text: 'Read ' }, { role: 'anchor', text: 'more', parts: [{ role: 'text', text: 'more' }], links: { self: { href: '/related' } } }, { role: 'text', text: ' here.' }] },
      { role: 'webview', html: '<table><tr><td>Related stories</td></tr></table>' },
      { role: 'image', imageURLs: { default: 'https://example.test/image' }, caption: 'Original caption' },
      { role: 'unknown', metadata: { keep: true } }] };
}
async function execute({ story = fixture(), url = REQUEST_URL, method = 'GET', status = 200,
  body = JSON.stringify(story), contentType = 'application/json', argument = '{}',
  get = (_, callback) => callback(null, { status: 200 }, '[[["中文翻译","source"]],null,"en"]') } = {}) {
  let called = 0, result;
  const requests = [];
  const logs = [];
  let resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });
  const callbacks = [];
  const context = { console: { log(value) { logs.push(value); } },
    setTimeout(callback) { callbacks.push(callback); },
    $request: { url, method, headers: { Cookie: 'SECRET_COOKIE', Authorization: 'SECRET_AUTH', 'X-Device-ID': 'SECRET_DEVICE' } },
    $response: { status, body, headers: { 'Content-Type': contentType, 'Content-Encoding': 'gzip', 'Content-Length': '12', ETag: 'old-tag', 'Cache-Control': 'public', 'X-Other': 'keep' } },
    $argument: argument,
    $persistentStore: new Proxy({}, { get() { throw new Error('Storage forbidden'); } }),
    $httpClient: { get(options, callback) { requests.push(options); get(options, callback); } },
    $done(value) { called++; result = value; resolveDone(); } };
  vm.runInNewContext(source, context, { timeout: 2000 });
  await done;
  assert.equal(called, 1);
  for (const callback of callbacks) callback();
  await Promise.resolve(); assert.equal(called, 1);
  return { result, requests, logs };
}

test('extract nested anchor text exactly once, without translating link/security metadata', () => {
  const parts = fixture().components[1].parts;
  parts[1].security = { text: 'DO NOT SEND', ticker: 'SECRET' };
  assert.equal(api.extractText(parts), 'Read more here.');
});
test('malformed and excessively nested paragraph trees are rejected', () => {
  assert.throws(() => api.extractText([null]));
  let parts = [{ role: 'text', text: 'deep' }];
  for (let i = 0; i < 25; i++) parts = [{ role: 'anchor', parts }];
  assert.throws(() => api.extractText(parts));
});
test('adjacent paragraphs translate as one group; originals, links and other components are unchanged', async () => {
  const original = fixture(), snapshot = JSON.stringify(original), sent = [];
  const output = await api.translateStory(original, async text => { sent.push(text); return '译文：' + text; });
  assert.equal(JSON.stringify(original), snapshot);
  assert.deepEqual(sent, ['The company postponed its IPO.\n\nRead more here.']);
  assert.deepEqual(output.story.components[0], original.components[0]);
  assert.deepEqual(output.story.components[1], original.components[1]);
  assert.equal(translatedText(output.story.components[2]), '译文：The company postponed its IPO.\n\nRead more here.');
  assert.equal(output.story.components[2][api.SOURCE_COUNT], 2);
  assert.deepEqual(output.story.components.slice(3), original.components.slice(2));
  assert.deepEqual(output.story.aiSummary, original.aiSummary);
  assert.equal(output.story.title, original.title); assert.equal(output.story.premium, true); assert.equal(output.story.isMetered, true);
});
test('existing translations are not duplicated or re-sent', async () => {
  const first = await api.translateStory(fixture(), async () => '中文译文');
  let count = 0;
  const second = await api.translateStory(first.story, async () => { count++; return '中文译文'; });
  assert.equal(count, 0); assert.equal(second.changed, false); assert.deepEqual(second.story, first.story);
});
test('translation failure is isolated to a group separated by an image', async () => {
  const story = fixture();
  story.components.splice(1, 0, { role: 'image', caption: 'separator' });
  const output = await api.translateStory(story, async text => { if (text.startsWith('The')) throw Error('failure'); return '了解更多。'; });
  assert.equal(output.stats.translated, 1); assert.equal(output.stats.failed, 1);
  assert.deepEqual(bodyComponents(output.story)[0], story.components[0]);
  assert.deepEqual(bodyComponents(output.story)[1], story.components[1]);
  assert.deepEqual(bodyComponents(output.story)[2], story.components[2]);
  assert.equal(translatedText(bodyComponents(output.story)[3]), '了解更多。');
});
test('empty translations do not replace or append paragraph text', async () => {
  const story = fixture(); const result = await api.translateStory(story, async () => '  ', { removeAdConfig: false });
  assert.equal(result.changed, true); assert.deepEqual(bodyComponents(result.story), story.components);
});
test('ad configuration removal is limited and switchable', async () => {
  const story = fixture();
  const cleaned = await api.translateStory(story, async () => '中文译文');
  assert.equal('adParams' in cleaned.story, false); assert.equal(cleaned.story.disableAds, true);
  assert.ok(cleaned.story.components.some(item => item.role === 'webview'));
  const kept = await api.translateStory(story, async () => '中文译文', { removeAdConfig: false });
  assert.deepEqual(kept.story.adParams, story.adParams); assert.equal(kept.story.disableAds, false);
});
test('unknown schema has no guessed modifications', async () => {
  await assert.rejects(api.translateStory({ body: 'unknown' }, async () => '译文'));
});
test('duplicate paragraph texts translate once within a request', async () => {
  let count = 0; const result = await api.translateStory({ components: [paragraph('Same text.'), paragraph('Same text.')] }, async () => { count++; return '同一段。'; });
  assert.equal(count, 1); assert.equal(result.stats.translated, 2);
});
test('long paragraphs split without losing text or Unicode; partial failures append nothing', async () => {
  const text = ('Long sentence with emoji 😀. ').repeat(120);
  assert.equal(api.splitText(text).join(''), text);
  assert.ok(api.splitText(text).every(part => Array.from(part).length <= 1200));
  let count = 0;
  const result = await api.translateStory({ components: [paragraph(text)] }, async () => { if (++count === 2) throw Error('partial'); return '译文'; });
  assert.equal(result.changed, true); assert.equal(bodyComponents(result.story).length, 1);
});
test('concurrency is bounded to three requests', async () => {
  let active = 0, peak = 0;
  await api.translateStory({ components: Array.from({ length: 10 }, (_, i) => [paragraph('Paragraph ' + i), { role: 'image' }]).flat() }, async () => {
    active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 2)); active--; return '中文译文';
  });
  assert.equal(peak, 3);
});
test('total deadline stops queued work', async () => {
  let now = 0, called = 0;
  const result = await api.translateStory({ components: Array.from({ length: 10 }, (_, i) => [paragraph('Paragraph ' + i), { role: 'image' }]).flat() }, async () => {
    called++; now += api.TOTAL_TIMEOUT_MS; return '中文译文';
  }, { removeAdConfig: false }, () => now);
  assert.equal(called, 1); assert.equal(result.stats.translated, 1); assert.equal(result.stats.expired, 9);
});
test('translation request count cannot exceed Surge timer limits', async () => {
  let calls = 0;
  await api.translateStory({ components: Array.from({ length: 100 }, (_, i) => [paragraph('Paragraph ' + i), { role: 'image' }]).flat() }, async () => { calls++; return '译文'; });
  assert.equal(calls, 48);
});
test('Google parser concatenates sentences and rejects rate-limit/non-JSON/non-Chinese data', () => {
  assert.equal(api.parseTranslation('[[["第一句。","First."],["第二句。","Second."]],null,"en"]'), '第一句。第二句。');
  for (const bad of ['<html>blocked</html>', '{}', '[[]]', '[[[null,"source"]]]', '[[["English only","source"]]]']) assert.throws(() => api.parseTranslation(bad));
});
test('Google transport sends only source text, no incoming credentials and no redirects/cookies', async () => {
  const { result, requests, logs } = await execute({ argument: '{"debug":true}' });
  assert.ok(result.body); assert.equal(requests.length, 1);
  for (const request of requests) {
    const target = new URL(request.url); assert.equal(target.origin, 'https://translate.googleapis.com');
    assert.equal(target.pathname, '/translate_a/single'); assert.equal(target.searchParams.get('tl'), 'zh-CN');
    assert.equal(request['auto-redirect'], false); assert.equal(request['auto-cookie'], false);
    assert.deepEqual(Object.keys(request.headers), ['Accept']);
    assert.equal(JSON.stringify(request).includes('SECRET'), false);
    assert.equal(JSON.stringify(request).includes('bloomberg'), false);
  }
  assert.equal(logs.some(line => line.includes('SECRET') || line.includes('The company')), false);
  assert.equal(result.headers['Content-Encoding'], undefined); assert.equal(result.headers['Content-Length'], undefined);
  assert.equal(result.headers.ETag, undefined); assert.equal(result.headers['Cache-Control'], 'no-store'); assert.equal(result.headers['X-Other'], 'keep');
});
test('network failure and rate limit preserve all original paragraphs', async () => {
  for (const get of [(_, cb) => cb('failure', null, null), (_, cb) => cb(null, { status: 429 }, '{}'), (_, cb) => cb(null, { status: 200 }, '<html>blocked</html>')]) {
    const { result } = await execute({ argument: '{"removeAdConfig":false}', get });
    const output = JSON.parse(result.body);
    assert.deepEqual(bodyComponents(output), fixture().components);
    assert.equal(output.components[1][api.INFO_MARKER], 'notice');
  }
});
test('timeout rejects and late callbacks are ignored', async () => {
  let callback, timeout;
  const transport = api.googleTransport({ get(_, cb) { callback = cb; } }, cb => { timeout = cb; });
  const promise = transport('Test text', 10); const rejection = assert.rejects(promise, /timeout/);
  timeout(); await rejection; callback(null, { status: 200 }, '[[["迟到译文"]]]');
});
test('runtime skips unrelated endpoints, wrong content types/statuses and invalid arguments', async () => {
  for (const override of [
    { url: 'https://mobapi.bloomberg.com/wssmobile/v1/stories/TMM9Y6T3BZM200' },
    { url: 'https://cdn-mobapi.bloomberg.com/wssmobile/v1/stories/find?url=x' },
    { url: 'https://cdn-mobapi.bloomberg.com/wssmobile/v1/stories' },
    { url: REQUEST_URL.replace('stories/', 'security/') }, { method: 'POST' }, { status: 304 },
    { contentType: 'text/html' }, { body: '{broken' }, { argument: '{broken' }, { argument: '{"enabled":false}' },
  ]) {
    const { result, requests } = await execute(override);
    assert.equal(Object.keys(result).length, 0); assert.equal(requests.length, 0);
  }
});
test('malformed paragraph is retained while other paragraphs translate', async () => {
  const malformed = { role: 'p', parts: [null] };
  const result = await api.translateStory({ components: [malformed, paragraph('Valid text.')] }, async () => '有效文字。');
  assert.equal(result.stats.failed, 1); assert.deepEqual(result.story.components[0], malformed); assert.equal(result.stats.translated, 1);
});
test('module scope and parameter rendering match runtime behavior', () => {
  const module = fs.readFileSync(path.join(__dirname, '../Bloomberg.Translate.sgmodule'), 'utf8');
  const line = module.split('\n').find(line => line.startsWith('nickcxm.'));
  assert.match(line, /script-path=https:\/\/raw\.githubusercontent\.com\/nickcxm\/script\/[a-f0-9]{40}\/Bloomberg\/bloomberg\.response\.js/);
  const regex = new RegExp(line.match(/pattern=(.*?), requires-body/)[1]);
  assert.ok(regex.test(REQUEST_URL)); assert.ok(regex.test(REQUEST_URL.split('?')[0]));
  assert.equal(regex.test('https://cdn-mobapi.bloomberg.com/wssmobile/v1/stories/find'), false);
  const values = Object.fromEntries(module.match(/^#!arguments=(.*)$/m)[1].split(',').map(item => item.split(':')));
  const argument = line.match(/argument="(.*)"$/)[1].replace(/\{\{\{(.*?)\}\}\}/g, (_, name) => values[name]);
  assert.deepEqual(JSON.parse(argument), { enabled: true, removeAdConfig: true, debug: false });
});


test('legacy labels are removed without retranslating original paragraphs', async () => {
  const original = paragraph('Original English text.');
  const translated = paragraph(api.LEGACY_PREFIX + '\n已有中文。');
  let calls = 0;
  const output = await api.translateStory({ components: [original, translated] }, async () => { calls++; return '不应请求'; });
  assert.equal(calls, 0); assert.equal(output.changed, true); assert.equal(output.stats.labelsRemoved, 1);
  assert.deepEqual(output.story.components[0], original);
  assert.equal(output.story.components[1].parts[0].text, '已有中文。');
  assert.equal(output.story.components[1][api.TRANSLATION_MARKER], true);
  const second = await api.translateStory(output.story, async () => { calls++; return '不应请求'; });
  assert.equal(calls, 0); assert.equal(second.changed, false);
});

test('split plain-text parts are merged into exactly one paragraph translation request', async () => {
  const parts = ['The listing of ', 'Firmus Grid Ltd.', ' was poised to be the next beat of ', 'Oliver Curtis', '’s comeback story.'].map(text => ({ role: 'text', text }));
  const original = { role: 'p', parts }; const sent = [];
  const result = await api.translateStory({ components: [original] }, async text => { sent.push(text); return '完整段落译文。'; });
  assert.deepEqual(sent, ['The listing of Firmus Grid Ltd. was poised to be the next beat of Oliver Curtis’s comeback story.']);
  assert.equal(result.story.components.length, 2); assert.deepEqual(result.story.components[0], original);
  assert.equal(translatedText(result.story.components[1]), '完整段落译文。');
  assert.equal(result.story.components[1][api.TRANSLATION_MARKER], true);
});


test('images and all non-body components split groups and remain untranslated', async () => {
  const separators = [{ role: 'image', caption: 'Do not translate caption' },
    { role: 'webview', html: '<p>Do not translate embedded HTML</p>' },
    { role: 'heading', text: 'Do not translate heading' }, { role: 'unknown', text: 'Do not translate unknown' }];
  const components = [];
  for (let i = 0; i < separators.length; i++) components.push(paragraph('Body A ' + i), paragraph('Body B ' + i), separators[i]);
  const original = { title: 'Do not translate title', summary: 'Do not translate summary', aiSummary: ['Do not translate AI summary'], components };
  const sent = [];
  const output = await api.translateStory(original, async text => { sent.push(text); return '正文合并译文。'; });
  assert.deepEqual(sent.sort(), separators.map((_, i) => 'Body A ' + i + '\n\nBody B ' + i).sort());
  assert.equal(output.stats.paragraphs, 8); assert.equal(output.stats.groups, 4); assert.equal(output.stats.requests, 4);
  for (let i = 0; i < separators.length; i++) {
    assert.deepEqual(output.story.components[i * 4], components[i * 3]);
    assert.deepEqual(output.story.components[i * 4 + 1], components[i * 3 + 1]);
    assert.equal(output.story.components[i * 4 + 2][api.SOURCE_COUNT], 2);
    assert.deepEqual(output.story.components[i * 4 + 3], separators[i]);
  }
});

test('an unsuccessful chunk leaves the entire grouped original intact', async () => {
  const original = { components: [paragraph('First long paragraph. '.repeat(60)), paragraph('Second long paragraph. '.repeat(60))] };
  let calls = 0;
  const output = await api.translateStory(original, async () => { if (++calls === 2) throw Error('failure'); return '部分译文。'; });
  assert.deepEqual(bodyComponents(output.story), original.components); assert.equal(output.changed, true);
});

test('grouped translations are idempotent, including repeated source paragraphs', async () => {
  const original = { components: [paragraph('Same text.'), paragraph('Same text.'), paragraph('Final text.'), { role: 'image' }, paragraph('More text.')] };
  const first = await api.translateStory(original, async () => '合并后的中文。');
  assert.equal(first.stats.translated, 4); assert.equal(first.stats.translatedGroups, 2);
  assert.equal(first.story.components[3][api.SOURCE_COUNT], 3);
  let calls = 0;
  const second = await api.translateStory(first.story, async () => { calls++; return '不应重复翻译。'; });
  assert.equal(calls, 0); assert.equal(second.changed, false); assert.deepEqual(second.story, first.story);
});

test('legacy individual translations do not cause earlier groups to be skipped', async () => {
  const old = paragraph('旧版中文。'); old[api.TRANSLATION_MARKER] = true;
  const original = { components: [paragraph('New text.'), paragraph('Already translated.'), old, paragraph('Other new text.')] };
  const sent = [];
  const result = await api.translateStory(original, async text => { sent.push(text); return '新译文。'; });
  assert.deepEqual(sent.sort(), ['New text.', 'Other new text.'].sort());
  assert.equal(result.stats.translated, 2);
});


test('every translated block ends with the Google provider label', async () => {
  const original = { components: [paragraph('First block.'), { role: 'image' }, paragraph('Second block.')] };
  const result = await api.translateStory(original, async () => '中文正文。');
  const translations = result.story.components.filter(item => item[api.TRANSLATION_MARKER]);
  assert.equal(translations.length, 2);
  for (const component of translations) assert.equal(component.parts[0].text, '中文正文。\n\n（翻译：谷歌）');
  assert.equal(result.stats.provider, 'google');
});
test('failure notices do not become translated body text on retry', async () => {
  const original = { components: [paragraph('First block.'), { role: 'image' }, paragraph('Second block.')] };
  const first = await api.translateStory(original, async () => { throw Error('failed'); });
  assert.equal(first.story.components[1][api.INFO_MARKER], 'notice');
  const sent = [];
  const second = await api.translateStory(first.story, async text => { sent.push(text); return '重试成功。'; });
  assert.deepEqual(sent.sort(), ['First block.', 'Second block.'].sort());
  assert.equal(second.story.components.some(item => item[api.INFO_MARKER]), false);
});
test('module has no AI settings and runtime requests only Google', async () => {
  const moduleText = fs.readFileSync(path.join(__dirname, '../Bloomberg.Translate.sgmodule'), 'utf8');
  assert.equal(/AI地址|AIToken|AI模型|智谱密钥/.test(moduleText), false);
  const { requests } = await execute();
  assert.ok(requests.length > 0); assert.ok(requests.every(item => item.url.startsWith('https://translate.googleapis.com/translate_a/single?')));
});
