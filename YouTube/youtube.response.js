/*
 * YouTube Local for Surge — readable local implementation, 2026-10-09.
 * Protocol definitions and feature behavior researched from Maasea/sgmodule.
 * This is a new implementation, not the upstream bundle. See NOTICE / LICENSE.
 * No fetch, remote code, persistent cache, or third-party playback service.
 */
(() => {
  'use strict';
  // Protocol field numbers observed in Maasea/sgmodule; see NOTICE.
  const SCHEMAS = {
    component_Label: {
      1: ["runs", "component_Run"],
    },
    component_Run: {
      1: ["text", "string"],
    },
    component_ResponseContext: {
      6: ["serviceTrackingParams", "component_ServiceTrackingParam"],
    },
    component_ServiceTrackingParam: {
      1: ["service", "int"],
      2: ["params", "component_Param"],
    },
    component_Param: {
      1: ["key", "string"],
      2: ["value", "string"],
    },
    response_browse_Browse: {
      1: ["responseContext", "component_ResponseContext"],
      9: ["content", "response_browse_Content"],
      10: ["onResponseReceivedAction", "response_browse_Content"],
    },
    response_browse_Content: {
      58173949: ["singleColumnResultsRenderer", "response_browse_SingleColumnResultsRenderer"],
      153515154: ["elementRenderer", "response_browse_ElementRenderer"],
      49399797: ["sectionListRenderer", "response_browse_SectionListRenderer"],
    },
    response_browse_SingleColumnResultsRenderer: {
      1: ["tabs", "response_browse_BrowseTabSupportedRenderer"],
    },
    response_browse_BrowseTabSupportedRenderer: {
      58174010: ["tabRenderer", "response_browse_TabRenderer"],
    },
    response_browse_TabRenderer: {
      4: ["content", "response_browse_Content"],
    },
    response_browse_SectionListRenderer: {
      1: ["sectionListSupportedRenderers", "response_browse_SectionListSupportedRenderer"],
    },
    response_browse_SectionListSupportedRenderer: {
      50195462: ["itemSectionRenderer", "response_browse_ItemSectionRenderer"],
      51845067: ["shelfRenderer", "response_browse_ShelfRenderer"],
      221496734: ["musicDescriptionShelfRenderer", "response_browse_MusicDescriptionShelfRenderer"],
    },
    response_browse_ItemSectionRenderer: {
      1: ["richItemContents", "response_browse_RichItemContent"],
    },
    response_browse_RichItemContent: {
      153515154: ["videoWithContextRenderer", "response_browse_ElementRenderer"],
    },
    response_browse_ElementRenderer: {
      172660663: ["videoRendererContent", "response_browse_VideoRendererContent"],
    },
    response_browse_VideoRendererContent: {
      1: ["videoInfo", "response_browse_VideoInfo"],
      2: ["renderInfo", "response_browse_RenderInfo"],
    },
    response_browse_VideoInfo: {
      168777401: ["videoContext", "response_browse_VideoContext"],
    },
    response_browse_VideoContext: {
      5: ["videoContent", "response_browse_VideoContent"],
    },
    response_browse_VideoContent: {
      465160965: ["timedLyricsRender", "response_browse_TimedLyricsRender"],
    },
    response_browse_TimedLyricsRender: {
      4: ["timedLyricsContent", "response_browse_TimedLyricsContent"],
    },
    response_browse_TimedLyricsContent: {
      1: ["runs", "component_Run"],
      2: ["footerLabel", "string"],
    },
    response_browse_RenderInfo: {
      183314536: ["layoutRender", "response_browse_LayoutRender"],
    },
    response_browse_LayoutRender: {
      1: ["eml", "string"],
    },
    response_browse_ShelfRenderer: {
      5: ["richSectionContent", "response_browse_RichSectionContent"],
    },
    response_browse_RichSectionContent: {
      51431404: ["reelShelfRenderer", "response_browse_ReelShelfRenderer"],
    },
    response_browse_ReelShelfRenderer: {
      1: ["richItemContents", "response_browse_RichItemContent"],
    },
    response_browse_MusicDescriptionShelfRenderer: {
      3: ["description", "component_Label"],
      10: ["footer", "component_Label"],
    },
    response_next_Next: {
      7: ["content", "response_next_Content"],
      8: ["onResponseReceivedAction", "response_browse_Content"],
    },
    response_next_Content: {
      51779735: ["nextResult", "response_next_NextResult"],
    },
    response_next_NextResult: {
      1: ["content", "response_browse_Content"],
    },
    response_search_Search: {
      4: ["content", "response_browse_Content"],
      7: ["onResponseReceivedCommand", "response_search_OnResponseReceivedCommand"],
    },
    response_search_OnResponseReceivedCommand: {
      50195462: ["itemSectionRenderer", "response_browse_ItemSectionRenderer"],
      49399797: ["appendContinuationItemsAction", "response_browse_SectionListRenderer"],
    },
    response_shorts_Shorts: {
      2: ["entries", "response_shorts_Entry"],
    },
    response_shorts_Entry: {
      1: ["command", "response_shorts_Command"],
    },
    response_shorts_Command: {
      139608561: ["reelWatchEndpoint", "response_shorts_ReelWatchEndpoint"],
    },
    response_shorts_ReelWatchEndpoint: {
      8: ["overlay", "response_shorts_Overlay"],
      16: ["adClientParams", "response_shorts_AdClientParams"],
    },
    response_shorts_AdClientParams: {
      1: ["isAd", "bool"],
    },
    response_shorts_Overlay: {
      139970731: ["reelPlayerOverlayRenderer", "response_shorts_ReelPlayerOverlayRenderer"],
    },
    response_shorts_ReelPlayerOverlayRenderer: {
      12: ["style", "int"],
    },
    response_guide_Guide: {
      4: ["labelItems", "response_guide_Item"],
      6: ["iconItems", "response_guide_Item"],
    },
    response_guide_Item: {
      117866661: ["guideSectionRenderer", "response_guide_GuideSectionRenderer"],
    },
    response_guide_GuideSectionRenderer: {
      1: ["rendererItems", "response_guide_RendererItem"],
    },
    response_guide_RendererItem: {
      318370163: ["iconRender", "response_guide_guideEntryRenderer"],
      117501096: ["labelRender", "response_guide_guideEntryRenderer"],
    },
    response_guide_guideEntryRenderer: {
      1: ["browseId", "string"],
    },
    response_player_Player: {
      7: ["adPlacements", "response_player_AdPlacement"],
      2: ["playabilityStatus", "response_player_PlayabilityStatus"],
      9: ["playbackTracking", "response_player_PlaybackTracking"],
      10: ["captions", "response_player_Captions"],
      68: ["adSlots", "response_player_AdSlot"],
    },
    response_player_AdPlacement: {
      84813246: ["adPlacementRenderer", "response_player_AdPlacementRenderer"],
    },
    response_player_AdPlacementRenderer: {
      4: ["params", "string"],
    },
    response_player_PlayabilityStatus: {
      21: ["pictureInPictureRender", "response_player_PictureInPictureSupportedRenderer"],
      11: ["backgroundPlayerRender", "response_player_BackgroundSupportedRenderer"],
    },
    response_player_PictureInPictureSupportedRenderer: {
      151635310: ["pictureInPictureAbility", "response_player_PictureInPictureAbility"],
    },
    response_player_BackgroundSupportedRenderer: {
      64657230: ["backgroundAbility", "response_player_BackgroundAbility"],
    },
    response_player_PictureInPictureAbility: {
      1: ["active", "bool"],
      4: ["f4", "int"],
      6: ["f6", "int"],
      8: ["f8", "int"],
    },
    response_player_BackgroundAbility: {
      1: ["active", "bool"],
    },
    response_player_PlaybackTracking: {
      1: ["videostatsPlaybackUrl", "response_player_Tracking"],
      2: ["videostatsDelayplayUrl", "response_player_Tracking"],
      3: ["videostatsWatchtimeUrl", "response_player_Tracking"],
      4: ["ptrackingUrl", "response_player_Tracking"],
      5: ["qoeUrl", "response_player_Tracking"],
      13: ["atrUrl", "response_player_Tracking"],
      15: ["videostatsEngageUrl", "response_player_Tracking"],
      18: ["pageadViewthroughconversion", "response_player_Tracking"],
    },
    response_player_Tracking: {
      1: ["baseUrl", "string"],
    },
    response_player_Captions: {
      51621377: ["playerCaptionsTrackListRenderer", "response_player_PlayerCaptionsTrackListRenderer"],
    },
    response_player_PlayerCaptionsTrackListRenderer: {
      1: ["captionTracks", "response_player_CaptionTrack"],
      2: ["audioTracks", "response_player_AudioTrack"],
      3: ["translationLanguages", "response_player_TranslationLanguage"],
      4: ["defaultAudioTrackIndex", "int"],
      6: ["defaultCaptionTrackIndex", "int"],
    },
    response_player_CaptionTrack: {
      1: ["baseUrl", "string"],
      2: ["name", "component_Label"],
      3: ["vssId", "string"],
      4: ["languageCode", "string"],
      5: ["kind", "string"],
      6: ["rtl", "bool"],
      7: ["isTranslatable", "bool"],
    },
    response_player_AudioTrack: {
      2: ["captionTrackIndices", "int"],
      3: ["defaultCaptionTrackIndex", "int"],
      4: ["forcedCaptionTrackIndex", "int"],
      5: ["visibility", "int"],
      6: ["hasDefaultTrack", "bool"],
      7: ["hasForcedTrack", "bool"],
      8: ["audioTrackId", "string"],
      11: ["captionsInitialState", "int"],
    },
    response_player_TranslationLanguage: {
      1: ["languageCode", "string"],
      2: ["languageName", "component_Label"],
    },
    response_player_AdSlot: {
      424701016: ["render", "response_player_AdSlot_Render"],
    },
    response_player_AdSlot_Render: {
    },
    response_setting_Setting: {
      6: ["settingItems", "response_setting_SettingItem"],
      7: ["CollectionItems", "response_setting_SettingItem"],
    },
    response_setting_SettingItem: {
      88478200: ["backgroundPlayBackSettingRenderer", "response_setting_BackgroundPlayBackSettingRenderer"],
      66930374: ["settingCategoryCollectionRenderer", "response_setting_SettingCategoryCollectionRenderer"],
    },
    response_setting_BackgroundPlayBackSettingRenderer: {
      1: ["name", "component_Label"],
      2: ["backgroundPlayback", "bool"],
      3: ["download", "bool"],
      5: ["trackingParams", "bytes"],
      9: ["downloadQualitySelection", "bool"],
      10: ["smartDownload", "bool"],
      14: ["icon", "response_setting_Icon"],
    },
    response_setting_SettingCategoryCollectionRenderer: {
      2: ["name", "component_Label"],
      3: ["subSettings", "response_setting_SubSetting"],
      4: ["categoryId", "int"],
      5: ["icon", "response_setting_Icon"],
    },
    response_setting_Icon: {
      1: ["iconType", "int"],
    },
    response_setting_SubSetting: {
      61331416: ["settingBooleanRenderer", "response_setting_SettingBooleanRenderer"],
    },
    response_setting_SettingBooleanRenderer: {
      2: ["title", "component_Label"],
      3: ["description", "component_Label"],
      5: ["enableServiceEndpoint", "response_setting_ServiceEndpoint"],
      6: ["disableServiceEndpoint", "response_setting_ServiceEndpoint"],
      15: ["itemId", "int"],
    },
    response_setting_ServiceEndpoint: {
      81212182: ["setClientSettingEndpoint", "response_setting_SetClientSettingEndpoint"],
    },
    response_setting_SetClientSettingEndpoint: {
      1: ["settingData", "response_setting_SettingData"],
    },
    response_setting_SettingData: {
      1: ["clientSettingEnum", "response_setting_ClientSettingEnum"],
      3: ["boolValue", "bool"],
    },
    response_setting_ClientSettingEnum: {
      1: ["item", "int"],
    },
    response_watch_Watch: {
      1: ["contents", "response_watch_Content"],
    },
    response_watch_Content: {
      2: ["player", "response_player_Player"],
      3: ["next", "response_next_Next"],
    },
  };

  const DEFAULTS = Object.freeze({
    blockUpload: true,
    blockImmersive: true,
    blockShorts: false,
    captionLang: 'off',
    enablePlayback: true,
    debug: false,
  });
  const ROUTES = {
    browse: 'response_browse_Browse',
    next: 'response_next_Next',
    player: 'response_player_Player',
    search: 'response_search_Search',
    'reel/reel_watch_sequence': 'response_shorts_Shorts',
    guide: 'response_guide_Guide',
    'account/get_setting': 'response_setting_Setting',
    get_watch: 'response_watch_Watch',
  };
  const LANGUAGES = {
    de: 'Deutsch', ru: 'Русский', fr: 'Français', fil: 'Filipino',
    ko: '한국어', ja: '日本語', en: 'English', vi: 'Tiếng Việt',
    'zh-Hant': '中文（繁體）', 'zh-Hans': '中文（简体）',
  };
  const MAX_BODY = 16 * 1024 * 1024;
  const MAX_FIELDS = 200000;
  const MAX_DEPTH = 64;

  function options(argument) {
    const supplied = typeof argument === 'string' ? JSON.parse(argument || '{}') : argument || {};
    const result = { ...DEFAULTS };
    for (const key of Object.keys(DEFAULTS)) {
      if (key === 'captionLang') continue;
      if (typeof supplied[key] === 'boolean') result[key] = supplied[key];
    }
    if (typeof supplied.captionLang === 'string' && /^(off|[a-z]{2,3}(?:-[A-Za-z]{2,8})?)$/.test(supplied.captionLang)) {
      result.captionLang = supplied.captionLang;
    }
    return result;
  }

  function bytes(value) {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    throw new Error('Expected a binary body');
  }

  // Varints for field tags, lengths and small integers. Large/unknown scalar
  // values are skipped and preserved as raw bytes, never rounded to JS numbers.
  function readVarint(data, cursor, numeric = true) {
    let value = 0;
    let factor = 1;
    for (let count = 0; count < 10; count++) {
      if (cursor.pos >= data.length) throw new Error('Truncated varint');
      const byte = data[cursor.pos++];
      if (count === 9 && byte > 1) throw new Error('Invalid 64-bit varint');
      if (numeric) {
        value += (byte & 127) * factor;
        if (!Number.isSafeInteger(value)) throw new Error('Integer out of range');
      }
      if (!(byte & 128)) return value;
      factor *= 128;
    }
    throw new Error('Invalid varint');
  }

  function varint(value) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid unsigned integer');
    const result = [];
    do {
      const low = value % 128;
      value = Math.floor(value / 128);
      result.push(low + (value ? 128 : 0));
    } while (value);
    return new Uint8Array(result);
  }

  function concat(parts) {
    let size = 0;
    for (const part of parts) size += part.length;
    if (size > MAX_BODY) throw new Error('Encoded body exceeds limit');
    const result = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) { result.set(part, offset); offset += part.length; }
    return result;
  }

  // Decode only message fields listed in SCHEMAS. Strings and unknown fields
  // are never guessed to be nested protobufs. Preserve ordering and raw values.
  function decode(input, type, depth = 0, budget = { fields: 0 }) {
    const data = bytes(input);
    if (data.length > MAX_BODY || depth > MAX_DEPTH) throw new Error('Protobuf limit exceeded');
    const schema = SCHEMAS[type];
    if (!schema) throw new Error('Unknown schema: ' + type);
    const node = { type, fields: [] };
    const cursor = { pos: 0 };
    while (cursor.pos < data.length) {
      if (++budget.fields > MAX_FIELDS) throw new Error('Too many protobuf fields');
      const start = cursor.pos;
      const tag = readVarint(data, cursor);
      const number = Math.floor(tag / 8);
      const wire = tag % 8;
      if (!number || number > 536870911) throw new Error('Invalid field number');
      let begin = cursor.pos;
      if (wire === 0) readVarint(data, cursor, false);
      else if (wire === 1) cursor.pos += 8;
      else if (wire === 5) cursor.pos += 4;
      else if (wire === 2) {
        const length = readVarint(data, cursor);
        begin = cursor.pos;
        cursor.pos += length;
      } else throw new Error('Unsupported wire type');
      if (cursor.pos > data.length) throw new Error('Truncated protobuf field');
      const field = { number, wire, raw: data.subarray(start, cursor.pos), data: data.subarray(begin, cursor.pos) };
      const definition = schema[number];
      if (definition && SCHEMAS[definition[1]]) {
        if (wire !== 2) throw new Error('Message wire type changed');
        field.child = decode(field.data, definition[1], depth + 1, budget);
      }
      node.fields.push(field);
    }
    return node;
  }

  function encode(node) {
    return concat(node.fields.map(field => {
      if (!field.child && field.raw) return field.raw;
      const value = field.child ? encode(field.child) : field.data;
      if (field.child && field.raw && same(value, field.data)) return field.raw;
      const tag = varint(field.number * 8 + field.wire);
      return field.wire === 2 ? concat([tag, varint(value.length), value]) : concat([tag, value]);
    }));
  }

  function all(node, number) { return node.fields.filter(field => field.number === number); }
  function child(node, number) { return all(node, number).find(field => field.child)?.child; }
  function integer(node, number, fallback = 0) {
    const field = all(node, number).find(item => item.wire === 0);
    return field ? readVarint(field.data, { pos: 0 }) : fallback;
  }
  function text(node, number) {
    const field = all(node, number).find(item => item.wire === 2 && !item.child);
    if (!field) return '';
    // URI conversion works in Surge's JS runtime without TextDecoder polyfills.
    let encoded = '';
    for (const byte of field.data) encoded += '%' + byte.toString(16).padStart(2, '0');
    return decodeURIComponent(encoded);
  }
  function utf8(value) {
    const encoded = encodeURIComponent(value);
    const result = [];
    for (let i = 0; i < encoded.length; i++) {
      if (encoded[i] === '%') { result.push(parseInt(encoded.slice(i + 1, i + 3), 16)); i += 2; }
      else result.push(encoded.charCodeAt(i));
    }
    return new Uint8Array(result);
  }
  function drop(node, number) { node.fields = node.fields.filter(field => field.number !== number); }
  function set(node, number, value, kind = 'int') {
    drop(node, number);
    if (kind === 'message') node.fields.push({ number, wire: 2, child: value });
    else node.fields.push({ number, wire: kind === 'string' || kind === 'bytes' ? 2 : 0,
      data: kind === 'string' ? utf8(value) : kind === 'bytes' ? value : varint(Number(value)) });
  }
  function make(type) { return { type, fields: [] }; }
  function add(node, number, value) { node.fields.push({ number, wire: 2, child: value }); }
  function walk(node, visit) {
    visit(node);
    for (const field of node.fields) if (field.child) walk(field.child, visit);
  }
  function hasAscii(data, value) {
    outer: for (let i = 0; i <= data.length - value.length; i++) {
      for (let j = 0; j < value.length; j++) if (data[i + j] !== value.charCodeAt(j)) continue outer;
      return true;
    }
    return false;
  }

  function adContent(item, params) {
    // Match the upstream pagead heuristic only in unknown rich-item payloads
    // and the specific videoContent location; do not classify all text as ads.
    for (const field of item.fields) {
      if (!SCHEMAS[item.type][field.number] && field.data.length >= 1000 && hasAscii(field.data, 'pagead')) return true;
    }
    let blocked = false;
    walk(item, node => {
      if (node.type === 'response_browse_LayoutRender') {
        const layout = text(node, 1).split('|')[0];
        if (layout === 'inline_injection_entrypoint_layout.eml' ||
            (params.blockShorts && /shorts(?!_pivot_item)/.test(layout))) blocked = true;
      }
      if (node.type === 'response_browse_VideoContent') {
        for (const field of node.fields) {
          if (!SCHEMAS[node.type][field.number] && field.data.length >= 1000 && hasAscii(field.data, 'pagead')) blocked = true;
        }
      }
    });
    return blocked;
  }

  function filterFeed(node, params) {
    walk(node, current => {
      if (current.type === 'response_browse_ItemSectionRenderer' || current.type === 'response_browse_ReelShelfRenderer') {
        current.fields = current.fields.filter(field => field.number !== 1 || !field.child || !adContent(field.child, params));
      }
      if (params.blockShorts && current.type === 'response_browse_SectionListRenderer') {
        current.fields = current.fields.filter(field => {
          if (field.number !== 1 || !field.child) return true;
          let reelShelf = false;
          walk(field.child, nested => { if (nested.type === 'response_browse_ReelShelfRenderer') reelShelf = true; });
          return !reelShelf;
        });
      }
    });
  }

  function label(value) {
    const run = make('component_Run'); set(run, 1, value, 'string');
    const result = make('component_Label'); add(result, 1, run); return result;
  }

  function translateCaptions(player, language) {
    if (language === 'off') return;
    const list = child(child(player, 10) || make('response_player_Captions'), 51621377);
    if (!list) return;
    const tracks = all(list, 1).map(field => field.child).filter(Boolean);
    if (!tracks.length) return;
    let index = tracks.findIndex(track => text(track, 4) === language);
    for (const track of tracks) set(track, 7, true);
    if (index === -1) {
      const source = tracks.find(track => text(track, 4) === 'en' && text(track, 1)) || tracks.find(track => text(track, 1));
      if (!source) return;
      const base = text(source, 1);
      // Copy the original URL's other signed parameters without reserializing it.
      const translated = /([?&])tlang=[^&#]*/.test(base)
        ? base.replace(/([?&])tlang=[^&#]*/, '$1tlang=' + encodeURIComponent(language))
        : base + (base.includes('?') ? '&' : '?') + 'tlang=' + encodeURIComponent(language);
      const track = make('response_player_CaptionTrack');
      set(track, 1, translated, 'string'); set(track, 2, label('@Local (' + language + ')'), 'message');
      set(track, 3, '.' + language, 'string'); set(track, 4, language, 'string'); set(track, 7, true);
      index = tracks.length; add(list, 1, track);
    }
    for (const audio of all(list, 2).map(field => field.child).filter(Boolean)) {
      const indices = [];
      for (const field of all(audio, 2)) {
        if (field.wire === 0) indices.push(readVarint(field.data, { pos: 0 }));
        else if (field.wire === 2) {
          const cursor = { pos: 0 };
          while (cursor.pos < field.data.length) indices.push(readVarint(field.data, cursor));
        } else throw new Error('Caption index wire type changed');
      }
      if (!indices.includes(index)) indices.push(index);
      set(audio, 2, concat(indices.map(varint)), 'bytes');
      set(audio, 3, index); set(audio, 11, 3);
    }
    const present = new Set(all(list, 3).map(field => field.child).filter(Boolean).map(item => text(item, 1)));
    for (const [code, name] of Object.entries({ ...LANGUAGES, [language]: LANGUAGES[language] || language })) {
      if (present.has(code)) continue;
      const item = make('response_player_TranslationLanguage');
      set(item, 1, code, 'string'); set(item, 2, label(name), 'message'); add(list, 3, item);
    }
  }

  function processPlayer(player, params) {
    drop(player, 7); drop(player, 68);
    const tracking = child(player, 9); if (tracking) drop(tracking, 18);
    const status = child(player, 2);
    if (params.enablePlayback && status) {
      const ability = make('response_player_PictureInPictureAbility');
      set(ability, 1, true); set(ability, 4, 0); set(ability, 6, 0); set(ability, 8, 1);
      const pip = make('response_player_PictureInPictureSupportedRenderer'); add(pip, 151635310, ability);
      set(status, 21, pip, 'message');
      const background = make('response_player_BackgroundSupportedRenderer');
      const active = make('response_player_BackgroundAbility'); set(active, 1, true); add(background, 64657230, active);
      set(status, 11, background, 'message');
    }
    translateCaptions(player, params.captionLang);
  }

  function processGuide(guide, params) {
    const hidden = new Set(['SPunlimited']);
    if (params.blockUpload) hidden.add('FEuploads');
    if (params.blockImmersive) hidden.add('FEmusic_immersive');
    if (params.blockShorts) hidden.add('FEshorts');
    walk(guide, node => {
      if (node.type !== 'response_guide_GuideSectionRenderer') return;
      node.fields = node.fields.filter(field => {
        if (field.number !== 1 || !field.child) return true;
        const entry = child(field.child, 318370163) || child(field.child, 117501096);
        return !entry || !hidden.has(text(entry, 1));
      });
    });
  }

  function settingEndpoint(enabled) {
    const item = make('response_setting_ClientSettingEnum'); set(item, 1, 151);
    const data = make('response_setting_SettingData'); add(data, 1, item); set(data, 3, enabled);
    const command = make('response_setting_SetClientSettingEndpoint'); add(command, 1, data);
    const endpoint = make('response_setting_ServiceEndpoint'); add(endpoint, 81212182, command); return endpoint;
  }

  function processSettings(settings, params) {
    if (!params.enablePlayback) return;
    walk(settings, node => {
      if (node.type !== 'response_setting_SettingCategoryCollectionRenderer' || integer(node, 4) !== 10135) return;
      const exists = all(node, 3).some(field => {
        const toggle = field.child && child(field.child, 61331416);
        const endpoint = toggle && child(toggle, 5);
        const command = endpoint && child(endpoint, 81212182);
        const data = command && child(command, 1);
        const item = data && child(data, 1);
        return item && integer(item, 1) === 151;
      });
      if (exists) return;
      const toggle = make('response_setting_SettingBooleanRenderer'); set(toggle, 15, 0);
      set(toggle, 5, settingEndpoint(true), 'message'); set(toggle, 6, settingEndpoint(false), 'message');
      const sub = make('response_setting_SubSetting'); add(sub, 61331416, toggle); add(node, 3, sub);
    });
    if (all(settings, 6).some(field => field.child && child(field.child, 88478200))) return;
    const background = make('response_setting_BackgroundPlayBackSettingRenderer');
    // These are UI capability flags, not a server-side subscription or download grant.
    for (const number of [2, 3, 9, 10]) set(background, number, true);
    const icon = make('response_setting_Icon'); set(icon, 1, 1093); add(background, 14, icon);
    const item = make('response_setting_SettingItem'); add(item, 88478200, background); add(settings, 6, item);
  }

  function transform(node, route, params) {
    if (route === 'player') processPlayer(node, params);
    else if (route === 'guide') processGuide(node, params);
    else if (route === 'account/get_setting') processSettings(node, params);
    else if (route === 'reel/reel_watch_sequence') {
      node.fields = node.fields.filter(field => {
        if (field.number !== 2 || !field.child) return true;
        const command = child(field.child, 1);
        const endpoint = command && child(command, 139608561);
        const ad = endpoint && child(endpoint, 16);
        return !ad || integer(ad, 1) !== 1;
      });
    } else if (route === 'get_watch') {
      for (const field of all(node, 1)) {
        if (!field.child) continue;
        const player = child(field.child, 2); if (player) processPlayer(player, params);
        const next = child(field.child, 3); if (next) filterFeed(next, params);
      }
    } else filterFeed(node, params);
    return node;
  }

  function same(a, b) { return a.length === b.length && a.every((value, index) => value === b[index]); }
  function run() {
    let params = DEFAULTS;
    let result = {};
    try {
      params = options(typeof $argument === 'undefined' ? '' : $argument);
      const match = /^https:\/\/youtubei\.googleapis\.com\/youtubei\/v1\/([^?]+)(?:\?.*)?$/.exec($request.url);
      const route = match && match[1];
      if (ROUTES[route] && $response.status === 200 && $response.body != null) {
        const original = bytes($response.body);
        if (original.length) {
          const node = decode(original, ROUTES[route]);
          const changed = encode(transform(node, route, params));
          if (!same(original, changed)) result = { body: changed };
          if (params.debug) console.log('[YouTube Local] ' + route + ': ' + original.length + ' -> ' + changed.length + ' bytes');
        }
      }
    } catch (error) {
      // Logs contain only the failure category, never URLs, tokens or bodies.
      if (params.debug) console.log('[YouTube Local] passthrough: ' + error.message);
    }
    $done(result);
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { SCHEMAS, ROUTES, options, decode, encode, transform, make, set, add, child, all, text, integer, bytes, varint, concat, run };
  }
  if (typeof $done === 'function') run();
})();
