'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const api = require('../youtube.response.js');
const request = require('../youtube.request.js');
const { make, set, add, child, all, text, integer, encode, decode, varint, concat } = api;
const defaults = api.options({});
const responseSource = fs.readFileSync(path.join(__dirname, '../youtube.response.js'), 'utf8');
const requestSource = fs.readFileSync(path.join(__dirname, '../youtube.request.js'), 'utf8');
function scalar(number, value) { return concat([varint(number * 8), varint(value)]); }
function unknown(number, payload) { return concat([varint(number * 8 + 2), varint(payload.length), payload]); }
function modify(node, route, options = {}) {
  const input = encode(node);
  return decode(encode(api.transform(decode(input, api.ROUTES[route]), route, api.options(options))), api.ROUTES[route]);
}
function execute(source, globals) {
  let called = 0, result;
  const context = { Uint8Array, ArrayBuffer, console: { log() {} }, ...globals,
    $httpClient: new Proxy({}, { get() { throw new Error('Network access forbidden'); } }),
    $persistentStore: new Proxy({}, { get() { throw new Error('Storage access forbidden'); } }),
    $done(value) { called++; result = value; } };
  vm.runInNewContext(source, context, { timeout: 3000 });
  assert.equal(called, 1); return result;
}
function playerFixture() {
  const player = make(api.ROUTES.player);
  const status = make('response_player_PlayabilityStatus'); add(player, 2, status);
  add(player, 7, make('response_player_AdPlacement')); add(player, 68, make('response_player_AdSlot'));
  const tracking = make('response_player_PlaybackTracking');
  const link = make('response_player_Tracking'); set(link, 1, 'https://example.test/stats', 'string');
  add(tracking, 1, link); add(tracking, 18, link); add(player, 9, tracking);
  player.fields.push({ number: 100, wire: 2, data: Uint8Array.from([0, 255, 1, 128]) });
  return player;
}
function captionFixture() {
  const player = playerFixture();
  const captions = make('response_player_Captions');
  const list = make('response_player_PlayerCaptionsTrackListRenderer');
  const track = make('response_player_CaptionTrack');
  set(track, 1, 'https://www.youtube.com/api/timedtext?signature=keep&tlang=fr', 'string');
  set(track, 4, 'en', 'string'); add(list, 1, track);
  const audio = make('response_player_AudioTrack'); set(audio, 2, concat([varint(0)]), 'bytes'); add(list, 2, audio);
  add(captions, 51621377, list); add(player, 10, captions); return player;
}
function feedFixture() {
  const browse = make(api.ROUTES.browse), content = make('response_browse_Content');
  const sections = make('response_browse_SectionListRenderer');
  const section = make('response_browse_SectionListSupportedRenderer'), items = make('response_browse_ItemSectionRenderer');
  function item(layout) {
    const item = make('response_browse_RichItemContent'), element = make('response_browse_ElementRenderer');
    const video = make('response_browse_VideoRendererContent'), info = make('response_browse_RenderInfo');
    const render = make('response_browse_LayoutRender'); set(render, 1, layout, 'string');
    add(info, 183314536, render); add(video, 2, info); add(element, 172660663, video); add(item, 153515154, element); return item;
  }
  add(items, 1, item('video_layout.eml')); add(items, 1, item('inline_injection_entrypoint_layout.eml'));
  add(items, 1, item('shorts_shelf.eml')); add(items, 1, item('shorts_pivot_item.eml'));
  const opaqueAd = make('response_browse_RichItemContent');
  const data = new Uint8Array(1200); data.set(Buffer.from('pagead'), 150);
  opaqueAd.fields.push({ number: 999, wire: 2, data }); add(items, 1, opaqueAd);
  const opaqueRegular = make('response_browse_RichItemContent');
  opaqueRegular.fields.push({ number: 999, wire: 2, data: new Uint8Array(1200) }); add(items, 1, opaqueRegular);
  add(section, 50195462, items); add(sections, 1, section); add(content, 49399797, sections); add(browse, 9, content); return browse;
}
function richItems(browse) {
  return child(child(child(child(browse, 9), 49399797), 1), 50195462);
}

test('every message schema reference exists', () => {
  for (const fields of Object.values(api.SCHEMAS)) for (const [, type] of Object.values(fields)) {
    assert.ok(['string', 'bytes', 'bool', 'int'].includes(type) || api.SCHEMAS[type], type);
  }
});
test('unknown wire values and 64-bit scalars survive byte-for-byte', () => {
  const input = concat([unknown(100, Uint8Array.from([255, 0, 128])), scalar(101, 17),
    Uint8Array.from([...varint(102 * 8), 255,255,255,255,255,255,255,255,255,1]),
    Uint8Array.from([...varint(103 * 8 + 1),1,2,3,4,5,6,7,8]),
    Uint8Array.from([...varint(104 * 8 + 5),1,2,3,4])]);
  assert.deepEqual(encode(decode(input, api.ROUTES.player)), input);
});
test('binary subarray offsets are respected', () => {
  const input = scalar(100, 42), padded = concat([new Uint8Array(7), input, new Uint8Array(3)]);
  assert.deepEqual(encode(decode(padded.subarray(7, padded.length - 3), api.ROUTES.player)), input);
});
test('remove player ads and only advertising tracking; preserve unknown payload', () => {
  const result = modify(playerFixture(), 'player');
  assert.equal(all(result, 7).length, 0); assert.equal(all(result, 68).length, 0);
  assert.equal(all(child(result, 9), 18).length, 0); assert.equal(all(child(result, 9), 1).length, 1);
  assert.deepEqual(all(result, 100)[0].data, Uint8Array.from([0,255,1,128]));
  assert.equal(integer(child(child(child(result, 2), 21), 151635310), 1), 1);
  assert.equal(integer(child(child(child(result, 2), 11), 64657230), 1), 1);
});
test('playback switch leaves ability fields unchanged', () => {
  const result = modify(playerFixture(), 'player', { enablePlayback: false });
  assert.equal(all(child(result, 2), 21).length, 0);
});
test('missing playabilityStatus does not fabricate it or crash', () => {
  const node = make(api.ROUTES.player); add(node, 7, make('response_player_AdPlacement'));
  assert.equal(encode(modify(node, 'player')).length, 0);
});
test('caption off leaves tracks unchanged', () => {
  const node = captionFixture(), result = modify(node, 'player');
  assert.deepEqual(encode(child(node, 10)), encode(child(result, 10)));
});
test('caption translation preserves signature, replaces tlang, updates packed indices', () => {
  const result = modify(captionFixture(), 'player', { captionLang: 'zh-Hans' });
  const list = child(child(result, 10), 51621377), tracks = all(list, 1);
  assert.equal(tracks.length, 2); assert.equal(text(tracks[1].child, 1), 'https://www.youtube.com/api/timedtext?signature=keep&tlang=zh-Hans');
  assert.equal(text(child(child(tracks[1].child, 2), 1), 1), '@Local (zh-Hans)');
  const audio = child(list, 2); assert.deepEqual(all(audio, 2)[0].data, Uint8Array.from([0,1]));
  assert.equal(integer(audio, 3), 1); assert.equal(integer(audio, 11), 3);
});
test('caption translation is idempotent', () => {
  const result = modify(captionFixture(), 'player', { captionLang: 'zh-Hans' });
  assert.deepEqual(encode(modify(result, 'player', { captionLang: 'zh-Hans' })), encode(result));
});
test('feed removes known ads and pagead payloads without number-based persistent classification', () => {
  const result = modify(feedFixture(), 'browse'); assert.equal(all(richItems(result), 1).length, 4);
  assert.equal(all(all(richItems(result), 1).at(-1).child, 999)[0].data.length, 1200);
});
test('Shorts switch filters known Shorts layouts but preserves pivot and regular content', () => {
  const result = modify(feedFixture(), 'browse', { blockShorts: true }); assert.equal(all(richItems(result), 1).length, 3);
});
test('Shorts switch removes a dedicated reel shelf', () => {
  const browse = feedFixture(), sections = child(child(browse, 9), 49399797);
  const section = make('response_browse_SectionListSupportedRenderer'), shelf = make('response_browse_ShelfRenderer');
  const rich = make('response_browse_RichSectionContent'); add(rich, 51431404, make('response_browse_ReelShelfRenderer'));
  add(shelf, 5, rich); add(section, 51845067, shelf); add(sections, 1, section);
  assert.equal(all(child(child(modify(browse, 'browse'), 9), 49399797), 1).length, 2);
  assert.equal(all(child(child(modify(browse, 'browse', { blockShorts: true }), 9), 49399797), 1).length, 1);
});
test('navigation switches remove only selected entries', () => {
  const guide = make(api.ROUTES.guide), item = make('response_guide_Item'), section = make('response_guide_GuideSectionRenderer');
  for (const id of ['FEhome','FEuploads','FEmusic_immersive','FEshorts','SPunlimited']) {
    const renderer = make('response_guide_RendererItem'), entry = make('response_guide_guideEntryRenderer');
    set(entry, 1, id, 'string'); add(renderer, 318370163, entry); add(section, 1, renderer);
  }
  add(item, 117866661, section); add(guide, 6, item);
  const count = node => all(child(child(node, 6), 117866661), 1).length;
  assert.equal(count(modify(guide, 'guide')), 2);
  assert.equal(count(modify(guide, 'guide', { blockShorts: true })), 1);
  assert.equal(count(modify(guide, 'guide', { blockUpload: false, blockImmersive: false })), 4);
});
test('reel ads use isAd flag, keeping unflagged entries', () => {
  const shorts = make(api.ROUTES['reel/reel_watch_sequence']);
  for (const isAd of [true,false]) {
    const entry = make('response_shorts_Entry'), command = make('response_shorts_Command'), endpoint = make('response_shorts_ReelWatchEndpoint');
    const ad = make('response_shorts_AdClientParams'); set(ad, 1, isAd); add(endpoint, 16, ad); add(command, 139608561, endpoint); add(entry, 1, command); add(shorts, 2, entry);
  }
  assert.equal(all(modify(shorts, 'reel/reel_watch_sequence'), 2).length, 1);
});
test('background settings and toggle are idempotent and can be disabled', () => {
  const settings = make(api.ROUTES['account/get_setting']), item = make('response_setting_SettingItem');
  const collection = make('response_setting_SettingCategoryCollectionRenderer'); set(collection, 4, 10135);
  add(item, 66930374, collection); add(settings, 6, item);
  const result = modify(settings, 'account/get_setting'); assert.equal(all(result, 6).length, 2);
  assert.equal(all(child(child(result, 6), 66930374), 3).length, 1);
  assert.deepEqual(encode(modify(result, 'account/get_setting')), encode(result));
  assert.deepEqual(encode(modify(settings, 'account/get_setting', { enablePlayback: false })), encode(settings));
});
test('get_watch processes nested player and next responses', () => {
  const watch = make(api.ROUTES.get_watch), content = make('response_watch_Content'); add(content, 2, playerFixture()); add(watch, 1, content);
  const result = modify(watch, 'get_watch'); assert.equal(all(child(child(result, 1), 2), 7).length, 0);
});
for (const input of [Uint8Array.from([128]), Uint8Array.from([0]), Uint8Array.from([10,255]), Uint8Array.from([11]), Uint8Array.from([10,3,1])]) {
  test('malformed body passes through: ' + Buffer.from(input).toString('hex'), () => {
    const result = execute(responseSource, { $request: { url: 'https://youtubei.googleapis.com/youtubei/v1/player' }, $response: { status: 200, body: input } });
    assert.equal(Object.keys(result).length, 0);
  });
}
test('response runtime modifies binary body with zero network/storage access', () => {
  const result = execute(responseSource, { $request: { url: 'https://youtubei.googleapis.com/youtubei/v1/player?key=test' }, $response: { status: 200, body: encode(playerFixture()) } });
  assert.ok(result.body instanceof Uint8Array); assert.equal(all(decode(result.body, api.ROUTES.player), 7).length, 0);
});
test('wrong hosts, unknown routes and non-200 statuses pass through', () => {
  for (const [url,status] of [['https://example.test/youtubei/v1/player',200],['https://youtubei.googleapis.com/youtubei/v1/config',200],['https://youtubei.googleapis.com/youtubei/v1/player',403]]) {
    assert.equal(Object.keys(execute(responseSource, { $request: { url }, $response: { status, body: encode(playerFixture()) } })).length, 0);
  }
});
test('request fallback is scoped to initplayback ack and respects switch', () => {
  const url = 'https://rr1---sn-test.googlevideo.com/initplayback?foo=bar&ack=1';
  assert.equal(request.handle({ url }, {}).response.status, 200);
  assert.equal(request.handle({ url: 'https://rr1.googlevideo.com/initplayback?ack=1' }, {}).response.status, 200);
  assert.deepEqual(request.handle({ url }, { fallbackInit: false }), {});
  for (const value of ['https://rr1.googlevideo.com/videoplayback?ack=1','https://example.test/initplayback?ack=1','https://rr1.googlevideo.com/initplayback?x=1','https://rr1.googlevideo.com/initplayback?x=ack']) assert.deepEqual(request.handle({ url: value }, {}), {});
});
test('request runtime completes once without network, storage or request-body access', () => {
  const result = execute(requestSource, { $request: { url: 'https://rr1.googlevideo.com/initplayback?ack=1' } });
  assert.equal(result.response.status, 200); assert.equal(result.response.body.length, 0);
  assert.equal(Object.keys(execute(requestSource, { $request: { url: 'https://rr1.googlevideo.com/initplayback?ack=1' }, $argument: '{bad' })).length, 0);
});
test('module parameters render as valid JSON and patterns match intended routes', () => {
  const moduleText = fs.readFileSync(path.join(__dirname, '../YouTube.Local.sgmodule'), 'utf8');
  const values = Object.fromEntries(moduleText.match(/^#!arguments=(.*)$/m)[1].split(',').map(part => part.split(':')));
  for (const line of moduleText.split('\n').filter(line => line.startsWith('nickcxm.'))) {
    const pattern = line.match(/pattern=(.*?), (?:requires-body|script-path)=/)[1], regex = new RegExp(pattern);
    const argument = line.match(/argument="(.*)"$/)[1].replace(/\{\{\{(.*?)\}\}\}/g, (_, name) => values[name]);
    assert.doesNotThrow(() => JSON.parse(argument));
    if (line.includes('type=http-response')) {
      for (const route of Object.keys(api.ROUTES)) assert.ok(regex.test('https://youtubei.googleapis.com/youtubei/v1/' + route));
      assert.equal(regex.test('https://youtubei.googleapis.com/youtubei/v1/playerXYZ'), false);
    } else {
      for (const query of ['?ack=1','?x=1&ack=1','?x=1&ack']) assert.ok(regex.test('https://rr1.googlevideo.com/initplayback' + query));
      assert.equal(regex.test('https://rr1.googlevideo.com/videoplayback?ack=1'), false);
    }
  }
});
