'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const api = require('../bloomberg.response.js');
const source = fs.readFileSync(path.join(__dirname, '../bloomberg.response.js'), 'utf8');
const REQUEST_URL = 'https://cdn-mobapi.bloomberg.com/wssmobile/v1/stories/TMM9Y6T3BZM200?updatedAt=test';
function googleStory(story, translate, params = {}, clock) { return api.translateStory(story, translate, { removeAdConfig: true, ...params, provider: 'google' }, clock); }
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
async function execute({ story = fixture(), url = REQUEST_URL, method = 'GET', status = 200, body = JSON.stringify(story), contentType = 'application/json', argument = '{"provider":"google"}', get, post } = {}) {
  let result, called = 0, resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });
  const requests = [], timers = [], logs = [];
  vm.runInNewContext(source, {
    console: { log(value) { logs.push(value); } }, setTimeout(callback, ms) { if (ms <= 1200) return setTimeout(callback, ms); timers.push(callback); },
    $request: { url, method, headers: { Cookie: 'SECRET_COOKIE', Authorization: 'SECRET_AUTH' } },
    $response: { status, body, headers: { 'Content-Type': contentType, 'Content-Encoding': 'gzip', 'Content-Length': '100', ETag: 'old', 'Cache-Control': 'public', 'X-Other': 'keep' } }, $argument: argument,
    $persistentStore: new Proxy({}, { get() { throw Error('Forbidden storage'); } }),
    $httpClient: { get(options, callback) {
      requests.push(options);
      if (get) return get(options, callback);
      const q = new URL(options.url).searchParams.get('q');
      callback(null, { status: 200 }, JSON.stringify([[...ids(q).map(id => [api.marker(id) + '中文段落' + id + '。', 'original'])], null, 'en']));
    }, post(options, callback) { requests.push(options); if (post) post(options, callback); else throw Error('Unexpected POST'); } },
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
  const output = await googleStory(original, async text => { sent.push(text); return translated(text); });
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
  const output = await googleStory(original, async () => '整批中文译文。');
  assertOriginals(output.story, original);
  assert.equal(output.story.components[2].parts[0].text, api.marker(1) + api.marker(2) + '\n整批中文译文。');
  assert.equal(output.story.components[3].role, 'image'); assert.equal(output.stats.modes.merged, 2);
  assert.equal(output.story.components.some(item => item[api.INFO_MARKER]), false);
});
test('images, related reading, headings and unknown roles all separate request batches', async () => {
  const separators = [{ role: 'image' }, { role: 'webview' }, { role: 'heading' }, { role: 'unknown' }];
  const original = { components: separators.flatMap((separator, i) => [p('Body A ' + i), p('Body B ' + i), separator]) };
  const sent = []; const output = await googleStory(original, async text => { sent.push(ids(text)); return translated(text); });
  assert.deepEqual(sent, [[1, 2], [3, 4], [5, 6], [7, 8]]); assertOriginals(output.story, original);
});
test('complete numbered paragraphs are packed without cutting markers or paragraph boundaries', async () => {
  const original = { components: [p('First sentence. '.repeat(45)), p('Second sentence. '.repeat(45)), p('Third paragraph.')] };
  const sent = []; const output = await googleStory(original, async text => { sent.push(text); return translated(text); });
  assert.equal(sent.length, 2); assert.deepEqual(sent.map(ids), [[1], [2, 3]]);
  assert.ok(sent.every(text => Array.from(text).length <= 1200)); assert.equal(output.stats.translated, 3);
});
test('long paragraph fragments reuse its number and recombine after the same original', async () => {
  const original = { components: [p('Long text with emoji 😀. '.repeat(140))] };
  const sent = []; const output = await googleStory(original, async text => { sent.push(ids(text)); return translated(text); });
  assert.ok(sent.length > 1); assert.ok(sent.every(value => value.length === 1 && value[0] === 1));
  assert.equal(output.story.components.filter(item => item[api.TRANSLATION_MARKER]).length, 1);
  assertOriginals(output.story, original);
  assert.equal(api.splitText('😀'.repeat(1400)).join(''), '😀'.repeat(1400));
});
test('a failed long fragment keeps the numbered original and reports the error', async () => {
  const original = { components: [p('Long paragraph. '.repeat(160))] }; let requests = 0;
  const output = await googleStory(original, async text => { if (++requests === 2) throw Error('failure'); return translated(text); });
  assertOriginals(output.story, original); assert.equal(output.story.components.some(item => item[api.TRANSLATION_MARKER]), false);
  assert.equal(output.story.components[1][api.INFO_MARKER], 'notice');
});
test('numbered source and exact/partial/merged translations remain idempotent', async () => {
  for (const translate of [translated, async () => '合并译文。', async text => api.marker(ids(text)[0]) + '部分编号译文。']) {
    const first = await googleStory(fixture(), translate); let calls = 0;
    const second = await googleStory(first.story, async () => { calls++; return '不应调用'; });
    assert.equal(calls, 0); assert.equal(second.changed, false); assert.deepEqual(second.story, first.story);
  }
});
test('old visible labels are removed and previous grouped translations retain source numbers', async () => {
  const old = { components: [p('First original.'), p('Second original.'),
    { role: 'p', [api.TRANSLATION_MARKER]: true, [api.SOURCE_COUNT]: 2, parts: [{ role: 'text', text: '【中文译文】\n旧版中文。\n\n（翻译：谷歌）' }] }] };
  const output = await googleStory(old, async () => { throw Error('should not translate'); });
  const chinese = output.story.components[2]; assert.deepEqual(chinese[api.SOURCE_IDS], [1, 2]);
  assert.equal(chinese.parts[0].text, api.marker(1) + api.marker(2) + '\n旧版中文。');
});
test('translation failure affects only its batch and old notices are not translated on retry', async () => {
  const original = fixture();
  const first = await googleStory(original, async text => { if (ids(text)[0] === 1) throw Error('failure'); return translated(text); });
  assertOriginals(first.story, original); assert.equal(first.stats.translated, 1); assert.equal(first.story.components[1][api.INFO_MARKER], 'notice');
  const sent = []; const second = await googleStory(first.story, async text => { sent.push(text); return translated(text); });
  assert.equal(sent.length, 1); assert.deepEqual(ids(sent[0]), [1, 2]); assert.equal(sent[0].includes('翻译提示'), false);
  assert.equal(second.story.components.some(item => item[api.INFO_MARKER]), false);
});
test('concurrency and total request count remain bounded', async () => {
  const original = { components: Array.from({ length: 100 }, (_, i) => [p('Paragraph ' + i), { role: 'image' }]).flat() };
  let active = 0, peak = 0, calls = 0;
  const output = await googleStory(original, async text => { calls++; active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 1)); active--; return translated(text); });
  assert.equal(calls, 48); assert.equal(peak, 3); assert.equal(output.stats.requests, 48);
  assert.ok(output.story.components.some(item => item[api.INFO_MARKER]));
});
test('deadline stops queued requests without losing original text', async () => {
  let now = 0, calls = 0;
  const original = fixture();
  const output = await googleStory(original, async text => { calls++; now += api.TOTAL_TIMEOUT_MS; return translated(text); }, { removeAdConfig: false }, () => now);
  assert.equal(calls, 1); assertOriginals(output.story, original); assert.equal(output.stats.failed, 1);
});
test('ad removal is limited and switchable; metadata and non-body components are retained', async () => {
  const original = fixture();
  const removed = await googleStory(original, translated); assert.equal('adParams' in removed.story, false); assert.equal(removed.story.disableAds, true);
  const kept = await googleStory(original, translated, { removeAdConfig: false }); assert.deepEqual(kept.story.adParams, original.adParams); assert.equal(kept.story.disableAds, false);
  assertOriginals(removed.story, original);
});
test('Google parser joins sentence fragments and keeps paragraph markers', () => {
  assert.equal(api.parseTranslation('[[["【1】第一句。","first"],["第二句。","second"]],null,"en"]'), '【1】第一句。第二句。');
  for (const body of ['<html>blocked</html>', '{}', '[[]]', '[[[null]]]', '[[["English only"]]]']) assert.throws(() => api.parseTranslation(body));
});
test('runtime sends only numbered body text to Google and completes exactly once', async () => {
  const { result, requests, logs } = await execute({ argument: '{"provider":"google","debug":true}' });
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
test('module scope, Baidu credentials, pinned URL and parameter rendering remain valid', () => {
  const text = fs.readFileSync(path.join(__dirname, '../Bloomberg.Translate.sgmodule'), 'utf8');
  assert.equal(/AI地址|AIToken|AI模型|智谱密钥/.test(text), false);
  const line = text.split('\n').find(line => line.startsWith('nickcxm.'));
  const regex = new RegExp(line.match(/pattern=(.*?), requires-body/)[1]); assert.ok(regex.test(REQUEST_URL));
  assert.equal(regex.test('https://cdn-mobapi.bloomberg.com/wssmobile/v1/stories/find'), false);
  assert.match(line, /script-path=https:\/\/raw\.githubusercontent\.com\/nickcxm\/script\/[a-f0-9]{40}\//);
  const values = Object.fromEntries(text.match(/^#!arguments=(.*)$/m)[1].split(',').map(item => item.split(':')));
  const argument = line.match(/argument="(.*)"$/)[1].replace(/\{\{\{(.*?)\}\}\}/g, (_, name) => values[name]);
  assert.deepEqual(JSON.parse(argument), { enabled: true, removeAdConfig: true, debug: false, provider: 'baidu', baiduAppId: 'UNSET', baiduKey: 'UNSET' });
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


test('local MD5 matches standard UTF-8 digests and Baidu documented sign vector', () => {
  const crypto = require('node:crypto');
  for (const value of ['', 'abc', 'hello', '【1】The company’s profit grew 😀', 'a'.repeat(5000)]) {
    assert.equal(api.md5(value), crypto.createHash('md5').update(value,'utf8').digest('hex'));
  }
  assert.equal(api.md5('2015063000000001apple654781234567890'), 'a1a7461d92e5194c5cae3182b5b24de1');
});
test('Baidu signs original UTF-8 query before form encoding and never sends the secret', () => {
  const params = { baiduAppId: '2015063000000001', baiduKey: 'TEST_BAIDU_SECRET' };
  const query = '【1】A + B & C’s profits 😀';
  const request = api.baiduRequest(query, params, 4500, '65478');
  assert.equal(request.url, 'https://fanyi-api.baidu.com/api/trans/vip/translate');
  const form = new URLSearchParams(request.body);
  assert.equal(form.get('q'), query); assert.equal(form.get('appid'), params.baiduAppId);
  assert.equal(form.get('sign'), require('node:crypto').createHash('md5').update(params.baiduAppId+query+'65478'+params.baiduKey).digest('hex'));
  assert.equal(request.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal(JSON.stringify(request).includes(params.baiduKey), false);
  assert.equal(request['auto-cookie'], false); assert.equal(request['auto-redirect'], false);
});
test('Baidu response paragraphs preserve numbers and expose error fields separately', () => {
  assert.equal(api.parseBaidu('{"trans_result":[{"src":"[1]one","dst":"[1]第一段。"},{"src":"[2]two","dst":"【2】第二段。"}]}'), '[1]第一段。\n\n【2】第二段。');
  for (const code of ['52003','54001','54003','54004','58003']) {
    assert.throws(() => api.parseBaidu(JSON.stringify({error_code:code,error_msg:'SECRET_PRIVATE_SERVER_MESSAGE'})), error => error.baiduCode===code && error.baiduMessage==='SECRET_PRIVATE_SERVER_MESSAGE' && !error.message.includes('SECRET'));
  }
  for (const body of ['{}','<html>bad</html>','{"trans_result":[{"dst":null}]}']) assert.throws(() => api.parseBaidu(body));
});
test('Baidu is default but missing credentials use Google with an in-article notice', async () => {
  assert.equal(api.options('').provider, 'baidu');
  const { result, requests } = await execute({ argument: '{}' });
  assert.ok(requests.length > 0); assert.ok(requests.every(request => request.url.startsWith('https://translate.googleapis.com')));
  const story = JSON.parse(result.body); assertOriginals(story, fixture());
  assert.match(story.components[1].parts[0].text, /未配置百度 APP ID 或密钥.*Google 备用/);
});
test('Baidu succeeds without Google and original credentials never reach request headers or logs', async () => {
  const params = { provider: 'baidu', baiduAppId: '2015063000000001', baiduKey: 'TEST_BAIDU_SECRET', debug: true };
  const { result, requests, logs } = await execute({ argument: JSON.stringify(params), post(options, callback) {
    const query = new URLSearchParams(options.body).get('q');
    callback(null, { status:200 }, JSON.stringify({trans_result:ids(query).map(number => ({dst:'【'+number+'】百度中文。'}))}));
  } });
  assert.equal(requests.length,1); assert.ok(requests.every(request => request.url.startsWith('https://fanyi-api.baidu.com')));
  assert.equal(JSON.stringify(requests).includes('TEST_BAIDU_SECRET'),false); assert.equal(JSON.stringify(requests).includes('SECRET_COOKIE'),false);
  assert.equal(JSON.stringify(logs).includes('TEST_BAIDU_SECRET'),false); assertOriginals(JSON.parse(result.body),fixture());
  assert.equal(JSON.parse(result.body).components.filter(item => item[api.INFO_MARKER]).length,0);
});
test('Baidu authentication failure disables subsequent primary attempts and safely uses Google', async () => {
  const { result, requests } = await execute({ argument: JSON.stringify({baiduAppId:'2015063000000001',baiduKey:'TEST_BAIDU_SECRET'}), post(_,cb) {
    cb(null,{status:200},'{"error_code":"54001","error_msg":"SECRET_PRIVATE_SERVER_MESSAGE"}');
  } });
  assert.equal(requests.filter(request=>request.url.startsWith('https://fanyi-api.baidu.com')).length,1);
  assert.equal(requests.filter(request=>request.url.startsWith('https://translate.googleapis.com')).length,1);
  const story=JSON.parse(result.body); assertOriginals(story,fixture());
  assert.match(story.components[1].parts[0].text,/百度签名错误.*Google 备用/);
  assert.equal(result.body.includes('SECRET_PRIVATE_SERVER_MESSAGE'),true); assert.equal(result.body.includes('TEST_BAIDU_SECRET'),false);
});
test('Baidu scheduling spaces request starts and does not postpone forever', async () => {
  let now=0;const started=[];
  const schedule=(callback,ms)=>{ if(ms>1200)return; now+=ms;callback(); };
  const transport=api.baiduTransport({post(_,cb){started.push(now);cb(null,{status:200},'{"trans_result":[{"dst":"【1】中文。"}]}');}},
    {baiduAppId:'2015063000000001',baiduKey:'TEST_KEY'},schedule,()=>now);
  await transport('【1】First.',4500);await transport('【1】Second.',4500);await transport('【1】Third.',4500);
  assert.deepEqual(started,[0,api.BAIDU_INTERVAL_MS,api.BAIDU_INTERVAL_MS*2]);
});
test('fallback never passes primary credentials to Google and retains remaining deadline', async () => {
  let calls=0,remaining=0;
  const translate=api.primaryWithFallback(async()=>{throw Object.assign(Error('failure'),{code:'baidu',baiduCode:'54003'});},async(text,ms)=>{calls++;remaining=ms;return '备用中文。';},()=>{});
  assert.equal(await translate('【1】English.',7000),'备用中文。');assert.equal(calls,1);assert.ok(remaining>0&&remaining<=7000);
});


test('Google backup concurrency is limited independently of Baidu workers', async () => {
  let active=0,peak=0;
  const translate=api.limitConcurrency(async()=>{active++;peak=Math.max(peak,active);await new Promise(resolve=>setTimeout(resolve,2));active--;return '备用中文。';},3);
  const results=await Promise.all(Array.from({length:12},()=>translate('正文',1000)));
  assert.equal(peak,3);assert.equal(results.length,12);
});
test('Baidu byte limits reject oversized UTF-8 input before any network operation', () => {
  const params={baiduAppId:'2015063000000001',baiduKey:'TEST_KEY'};
  assert.throws(()=>api.baiduRequest('😀'.repeat(1600),params,4500),error=>error.baiduCode==='length');
});
test('service network failures stop new Baidu calls and both failures retain original text', async () => {
  const {result,requests}=await execute({argument:JSON.stringify({baiduAppId:'2015063000000001',baiduKey:'TEST_KEY'}),
    post(_,cb){cb('private failure',null,null);},get(_,cb){cb('private failure',null,null);}});
  assert.equal(requests.filter(request=>request.url.startsWith('https://fanyi-api.baidu.com')).length,1);
  const story=JSON.parse(result.body);assertOriginals(story,fixture());assert.equal(story.components.some(item=>item[api.TRANSLATION_MARKER]),false);
  assert.match(story.components[1].parts[0].text,/百度翻译网络请求失败.*Google 备用/);
});


test('provider appears exactly once after the first original paragraph, not on Chinese paragraphs', async () => {
  const {result}=await execute(); const story=JSON.parse(result.body);
  assert.equal(story.components[1][api.INFO_MARKER],'provider'); assert.equal(story.components[1].parts[0].text,'翻译服务：Google');
  assert.equal(story.components.filter(item=>item[api.INFO_MARKER]==='provider').length,1);
  assert.ok(story.components.filter(item=>item[api.TRANSLATION_MARKER]).every(item=>!item.parts[0].text.includes('翻译服务')));
});
test('actual Google backup provider and error reason share the first-paragraph annotation', async () => {
  const {result}=await execute({argument:'{}'});const story=JSON.parse(result.body);
  assert.equal(story.components.filter(item=>item[api.INFO_MARKER]).length,1);
  assert.match(story.components[1].parts[0].text,/翻译服务：Google（百度失败后使用备用）/);
  assert.match(story.components[1].parts[0].text,/未配置百度 APP ID 或密钥/);
});
test('mixed successful primary and backup translations report both providers without per-block labels', async () => {
  let posts=0;
  const mixed={components:[p('First long sentence. '.repeat(65)),{role:'image'},p('Second long sentence. '.repeat(65))]};
  const {result}=await execute({story:mixed,argument:JSON.stringify({baiduAppId:'2015063000000001',baiduKey:'TEST_KEY'}),post(options,cb){
    if(++posts===1){const query=new URLSearchParams(options.body).get('q');cb(null,{status:200},JSON.stringify({trans_result:ids(query).map(id=>({dst:'【'+id+'】百度中文。'}))}));}
    else cb(null,{status:200},'{"error_code":"54003"}');
  }});
  const story=JSON.parse(result.body);assert.match(story.components[1].parts[0].text,/翻译服务：百度、Google/);
  assert.equal(story.components.filter(item=>item[api.INFO_MARKER]).length,1);assertOriginals(story,mixed);
});


test('module parameters have portable names and non-empty defaults', () => {
  const text=fs.readFileSync(path.join(__dirname,'../Bloomberg.Translate.sgmodule'),'utf8');
  const declarations=text.match(/^#!arguments=(.*)$/m)[1].split(',');
  const names=new Set();
  for(const item of declarations){
    const index=item.indexOf(':');assert.ok(index>0&&index<item.length-1);
    const name=item.slice(0,index);assert.match(name,/^[A-Za-z0-9_]+$/);assert.equal(names.has(name),false);names.add(name);
  }
  for(const [,name] of text.matchAll(/\{\{\{([^}]+)\}\}\}/g))assert.ok(names.has(name));
  assert.deepEqual(api.options({baiduAppId:'UNSET',baiduKey:'UNSET'}),api.options(''));
});


test('Baidu error code and original message appear only in the first annotation', async () => {
  const {result}=await execute({argument:JSON.stringify({baiduAppId:'2015063000000001',baiduKey:'TEST_KEY'}),post(_,cb){cb(null,{status:200},'{"error_code":"54003","error_msg":"Access Limit"}');}});
  const story=JSON.parse(result.body);const text=story.components[1].parts[0].text;
  assert.match(text,/error_code=54003; error_msg=Access Limit/);
  assert.equal(story.components.filter(item=>item.parts?.[0]?.text?.includes('error_code=')).length,1);
  assertOriginals(story,fixture());
});
test('API errors on non-200 HTTP retain both service code and HTTP status', async () => {
  const {result}=await execute({argument:JSON.stringify({baiduAppId:'2015063000000001',baiduKey:'TEST_KEY'}),post(_,cb){cb(null,{status:429},'{"error_code":"54003","error_msg":"Access Limit"}');}});
  assert.match(JSON.parse(result.body).components[1].parts[0].text,/error_code=54003; error_msg=Access Limit; HTTP=429/);
});
test('raw and encoded credentials in provider messages are hidden before display', async () => {
  const params={baiduAppId:'2015063000000001',baiduKey:'TEST_KEY+SECRET'};
  const {result,logs}=await execute({argument:JSON.stringify({...params,debug:true}),post(_,cb){cb(null,{status:200},JSON.stringify({error_code:'54001',error_msg:'Invalid key '+params.baiduKey+' encoded '+encodeURIComponent(params.baiduKey)+' app '+params.baiduAppId}));}});
  assert.equal(result.body.includes(params.baiduKey),false);assert.equal(result.body.includes(encodeURIComponent(params.baiduKey)),false);assert.equal(result.body.includes(params.baiduAppId),false);
  assert.ok(result.body.includes('[已隐藏]'));assert.equal(JSON.stringify(logs).includes(params.baiduKey),false);
  assert.ok(api.safeBaiduMessage('x'.repeat(500)).length<=300);
});


test('Baidu under 2000 characters combines body across images and related reading into one request', async () => {
  const original=fixture();const queries=[];
  const output=await api.translateStory(original,async query=>{queries.push(query);return translated(query);},{provider:'baidu',removeAdConfig:true});
  assert.equal(queries.length,1);assert.deepEqual(ids(queries[0]),[0,1,2,3]);
  assert.ok(queries[0].startsWith('【0】'+original.title+'\n【1】'));assert.equal(queries[0].includes('\n\n'),false);
  assertOriginals(output.story,original);assert.equal(output.story.title,original.title+'\n中文段落0。');
  assert.equal(output.story._nickcxmTitleTranslated,true);assert.equal(output.stats.titleTranslated,true);assert.equal(output.stats.translated,3);
  const titles=output.story.components.filter(item=>item[api.TRANSLATION_MARKER]&&item[api.SOURCE_IDS].includes(0));assert.equal(titles.length,0);
  let repeated=0;const second=await api.translateStory(output.story,async()=>{repeated++;return '';},{provider:'baidu',removeAdConfig:true});
  assert.equal(repeated,0);assert.equal(second.changed,false);assert.equal(second.story.title,output.story.title);
});
test('Baidu batches respect both 2000 code points and 5800 UTF-8 bytes', async () => {
  const original={title:'Test title',components:[p('First paragraph. '.repeat(85)),{role:'image'},p('Second paragraph. '.repeat(85)),p('Third paragraph. '.repeat(50))]};
  const queries=[];const output=await api.translateStory(original,async query=>{queries.push(query);return translated(query);},{provider:'baidu'});
  assert.ok(queries.length>1);assert.ok(queries.every(query=>Array.from(query).length<=2000&&api.utf8Bytes(query).length<=5800));
  assert.equal(output.stats.translated,3);assertOriginals(output.story,original);
  const emoji=p('English '+ '😀'.repeat(1500));const parts=[];
  const long=await api.translateStory({components:[emoji]},async query=>{parts.push(query);return translated(query);},{provider:'baidu'});
  assert.ok(parts.every(query=>api.utf8Bytes(query).length<=5800));assert.equal(long.stats.translated,1);
});
test('Baidu uses src ids when dst markers are removed, changed, or incorrect', () => {
  const query='【0】English title\n【1】First body.\n【2】Second body.';
  const result=api.parseBaidu(JSON.stringify({trans_result:[
    {src:'【0】English title',dst:'中文标题'},
    {src:'【1】First body.',dst:'[99]第一段中文。'},
    {src:'【2】Second body.',dst:'第二段中文。'},
  ]}),{},query);
  assert.equal(result,'【0】中文标题\n\n【1】第一段中文。\n\n【2】第二段中文。');
  assert.equal(api.alignTranslation(result,[0,1,2]).mode,'exact');
});
test('Baidu source continuation rows stay with their original paragraph', () => {
  const result=api.parseBaidu(JSON.stringify({trans_result:[{src:'【1】First.',dst:'第一句。'},{src:'Next sentence.',dst:'第二句。'},{src:'【2】Other.',dst:'另一段。'}]}),{},'【1】First. Next sentence.\n【2】Other.');
  assert.equal(result,'【1】第一句。第二句。\n\n【2】另一段。');
});
test('Google-only requests do not translate title or merge across images', async () => {
  const original=fixture();const sent=[];
  const output=await api.translateStory(original,async query=>{sent.push(query);return translated(query);},{provider:'google'});
  assert.equal(sent.length,2);assert.ok(sent.every(query=>!query.includes('【0】')));assert.equal(output.story.title,original.title);
});
test('large Baidu batches are repacked to 1200-character Google backup requests', async () => {
  const original={title:'Example title',components:[p('A sentence about company earnings. '.repeat(24)),{role:'image'},p('Another company announced earnings. '.repeat(23))]};
  const queries=[];
  const {result,requests}=await execute({story:original,argument:JSON.stringify({baiduAppId:'2015063000000001',baiduKey:'TEST_KEY'}),post(_,cb){cb(null,{status:200},'{"error_code":"54003","error_msg":"Access Limit"}');},get(options,cb){
    const query=new URL(options.url).searchParams.get('q');queries.push(query);
    cb(null,{status:200},JSON.stringify([ids(query).map(id=>['【'+id+'】备用译文。','original'])]));
  }});
  assert.equal(requests.filter(request=>request.url.startsWith('https://fanyi-api.baidu.com')).length,1);
  assert.ok(queries.length>1);assert.ok(queries.every(query=>Array.from(query).length<=1200));
  const output=JSON.parse(result.body);assertOriginals(output,original);assert.equal(output.title,original.title+'\n备用译文。');
});


test('Google backup long fragments reassemble without duplicate paragraph numbers', async () => {
  const original={title:'Title',components:[p('Long text about profits. '.repeat(70))]};
  const {result}=await execute({story:original,argument:'{}'});
  const output=JSON.parse(result.body);const translations=output.components.filter(item=>item[api.TRANSLATION_MARKER]);
  assert.equal(translations.length,1);assert.deepEqual(ids(translations[0].parts[0].text),[1]);assertOriginals(output,original);
});


test('Baidu transport has at most one request in flight even when callers start concurrently', async () => {
  let active=0,peak=0,calls=0;
  const schedule=(callback,ms)=>{if(ms<1500)return setTimeout(callback,ms);};
  const transport=api.baiduTransport({post(options,callback){
    active++;calls++;peak=Math.max(peak,active);
    const query=new URLSearchParams(options.body).get('q');
    setTimeout(()=>{active--;callback(null,{status:200},JSON.stringify({trans_result:[{src:query,dst:'中文。'}]}));},10);
  }},{baiduAppId:'2015063000000001',baiduKey:'TEST_KEY'},schedule);
  const results=await Promise.all(Array.from({length:6},(_,i)=>transport('【'+(i+1)+'】English.',4500)));
  assert.equal(peak,1);assert.equal(active,0);assert.equal(calls,6);assert.equal(results.length,6);
});


test('cached Baidu output removes an old provider annotation without adding a new one', async () => {
  const original=fixture();
  const first=await api.translateStory(original,translated,{provider:'baidu',removeAdConfig:true});
  first.story.components.splice(1,0,{role:'p',[api.INFO_MARKER]:'provider',parts:[{role:'text',text:'翻译服务：百度'}]});
  const {result,requests}=await execute({story:first.story,argument:JSON.stringify({provider:'baidu',baiduAppId:'2015063000000001',baiduKey:'TEST_KEY'})});
  assert.equal(requests.length,0);const output=JSON.parse(result.body);
  assert.equal(output.components.some(item=>item[api.INFO_MARKER]),false);assertOriginals(output,original);
});
