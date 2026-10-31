'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const api=require('../bloomberg.backend.js');
const script=fs.readFileSync(path.join(__dirname,'../bloomberg.backend.js'),'utf8');
const url='https://cdn-mobapi.bloomberg.com/wssmobile/v1/stories/TMM9Y6T3BZM200?updatedAt=test';
const p=text=>({role:'p',parts:[{role:'text',text}]});
const fixture=()=>({title:'Markets rally',id:'date/slug',longURL:'https://www.bloomberg.com/news/articles/2026-10-25/test?tracking=secret',updatedAt:123,published:100,adParams:{private:'not sent'},disableAds:false,components:[p('First paragraph.'),{role:'image',caption:'Do not translate caption'}, {role:'p',parts:[{role:'anchor',text:'Stock',parts:[{role:'text',text:'Stock'}],links:{self:{href:'SECRET_LINK'}}},{role:'text',text:' rose today.'}]}]});
const response=()=>({key:'a'.repeat(64),cacheHit:false,complete:true,titleTranslation:'市场上涨',providers:['apple'],warnings:[],translations:[{ids:[0],text:'市场上涨',provider:'apple'},{ids:[1],text:'第一段。',provider:'apple'},{ids:[2],text:'股票今天上涨。',provider:'apple'}]});
test('extract complete paragraphs only; no cookies, links, ad config or captions',()=>{
 const payload=api.prepare(fixture(),url);assert.deepEqual(payload.paragraphs,[{id:1,text:'First paragraph.'},{id:2,text:'Stock rose today.'}]);
 assert.equal(payload.article.id,'TMM9Y6T3BZM200');assert.equal(payload.article.url,'https://www.bloomberg.com/news/articles/2026-10-25/test');
 for(const value of ['SECRET_LINK','private','caption'])assert.ok(!JSON.stringify(payload).includes(value));
});
test('render preserves images and anchors, titles bilingual, translations inline',()=>{
 const original=fixture(), snapshot=JSON.stringify(original);const result=api.render(original,response(),{removeAdConfig:true});
 assert.equal(JSON.stringify(original),snapshot);assert.equal(result.title,'Markets rally\n市场上涨');assert.equal(result.components.length,3);assert.deepEqual(result.components[1],original.components[1]);
 assert.equal(result.components[0].parts.at(-1).text,'\n1. 第一段。');assert.deepEqual(result.components[2].parts[1],original.components[2].parts[0]);assert.equal(result.adParams,undefined);assert.equal(result.disableAds,true);
});
test('merged title and body translations remain visible in their numbered range',()=>{
 const result=response();result.titleTranslation='';result.translations=[{ids:[0,1,2],text:'标题与正文合并译文'}];
 const story=api.render(fixture(),result,{removeAdConfig:false});assert.equal(story.title,'Markets rally');assert.equal(story.components[2].parts.at(-1).text,'\n0. 1. 2. 标题与正文合并译文');assert.ok(story.adParams);
});
test('legacy inline output can be safely extracted and rendered again',()=>{
 const once=api.render(fixture(),response(),{});const payload=api.prepare(once,url);assert.equal(payload.article.title,'Markets rally');assert.deepEqual(payload.paragraphs,api.prepare(fixture(),url).paragraphs);
 const twice=api.render(once,response(),{});assert.deepEqual(twice,once);
});
test('fallback provider and failure notices appear once after first paragraph',()=>{
 const data=response();data.providers=['google'];data.cacheHit=true;data.warnings=['Apple 超时。'];
 const story=api.render(fixture(),data,{});assert.equal(story.components.length,4);assert.match(story.components[1].parts[0].text,/Google（缓存）/);assert.match(story.components[1].parts[0].text,/Apple 超时/);
 assert.equal(story.components.filter(x=>x._nickcxmTranslationInfo).length,1);
});
test('unexpected response IDs cannot be applied to unrelated paragraphs',()=>{
 const data=response();data.translations=[{ids:[99],text:'错误译文'}];assert.throws(()=>api.render(fixture(),data,{}));
});
async function execute({offline=false,data=response(),requestUrl=url,body=JSON.stringify(fixture()),healthError=false,googleError=false,post,get,expireTimers=false}={}){
 const posts=[],gets=[],logs=[],timers=[];let called=0;let done;
 const completed=new Promise(resolve=>{done=resolve;});
 vm.runInNewContext(script,{$request:{url:requestUrl,method:'GET',headers:{Cookie:'PRIVATE_COOKIE',Authorization:'PRIVATE_AUTH'}},$response:{status:200,body,headers:{'Content-Type':'application/json',ETag:'old'}},$argument:JSON.stringify({backendUrl:'http://192.168.50.71:18746'}),$httpClient:{post(req,cb){posts.push(req);if(post)return post(req,cb);cb(offline?'offline':null,{status:200},JSON.stringify(data));},get(req,cb){gets.push(req);if(req.url.endsWith('/health'))return cb(healthError?'offline':null,{status:200},JSON.stringify({ok:true}));if(get)return get(req,cb);if(googleError)return cb('offline');const text=new URL(req.url).searchParams.get('q');const ids=[...text.matchAll(/【(\d+)】/g)].map(x=>x[1]);cb(null,{status:200},JSON.stringify([[...ids.map(id=>['【'+id+'】谷歌译文'+id+'。','original'])]]));}},$persistentStore:new Proxy({},{get(){throw Error('no storage');}}),console:{log(text){logs.push(text);}},setTimeout(fn,ms){timers.push({fn,ms});if(expireTimers)queueMicrotask(fn);},$done(value){called++;done(value);}});
 const value=await completed;for(const timer of timers)timer.fn();await Promise.resolve();assert.equal(called,1);return{value,posts,gets,logs,timers};
}
test('backend requests follow profile routing and keep independent headers',async()=>{
 const result=await execute();assert.equal(result.posts.length,1);assert.equal(result.posts[0].url,'http://192.168.50.71:18746/api/translate');assert.equal(result.posts[0].policy,undefined);assert.equal(result.gets.length,1);assert.equal(result.gets[0].policy,undefined);assert.ok(result.gets[0].url.endsWith('/health'));
 assert.deepEqual(Object.keys(result.posts[0].headers),['Content-Type']);assert.ok(!JSON.stringify(result.posts).includes('PRIVATE_'));assert.equal(JSON.parse(result.value.body).title,'Markets rally\n市场上涨');assert.equal(result.value.headers.ETag,undefined);assert.equal(result.posts[0].timeout,34);
});
test('backend offline translates on device via Google, preserving images and anchors',async()=>{
 const result=await execute({offline:true});const story=JSON.parse(result.value.body);assert.match(story.title,/Markets rally\n谷歌/);assert.equal(story.components[0].parts.at(-1).text,'\n1. 谷歌译文1。');assert.deepEqual(story.components.find(x=>x.role==='image'),fixture().components[1]);assert.match(result.value.body,/Google（设备直连备用）/);assert.match(result.value.body,/未回传 mini/);assert.equal(result.posts.length,1);
 const google=result.gets.filter(x=>x.url.includes('translate.googleapis.com'));assert.ok(google.length);for(const req of google){assert.equal(req.policy,undefined);assert.deepEqual(Object.keys(req.headers),['Accept']);assert.ok(!JSON.stringify(req).includes('PRIVATE_'));}
});
test('unreachable health skips article upload and immediately uses Google',async()=>{
 const result=await execute({healthError:true});assert.equal(result.posts.length,0);assert.match(result.value.body,/谷歌译文1/);assert.match(result.value.body,/mini 连接检查网络请求失败/);
});
test('both services failing preserve original text and report Google errors',async()=>{
 const result=await execute({healthError:true,googleError:true});const story=JSON.parse(result.value.body);assert.equal(story.title,fixture().title);assert.equal(story.components[0].parts[1].text,'First paragraph.');assert.ok(!story.components[0].parts.some(x=>x._nickcxmTranslation));assert.match(result.value.body,/Google 备用网络请求失败/);assert.match(result.value.body,/保留原文/);
});
test('malformed backend and HTTP errors trigger the final Google fallback',async()=>{
 for(const post of [(req,cb)=>cb(null,{status:503},'{}'),(req,cb)=>cb(null,{status:200},'not json'),(req,cb)=>cb(null,{status:200},JSON.stringify({...response(),translations:[{ids:[99],text:'坏结果'}]}))]){
  const result=await execute({post});assert.match(result.value.body,/谷歌译文1/);assert.match(result.value.body,/Google（设备直连备用）/);
 }
});
test('backend timeout leaves time for Google and late callbacks cannot finish twice',async()=>{
 let late;const result=await execute({post(req,cb){late=cb;},expireTimers:true});assert.match(result.value.body,/mini 文章翻译接口请求超时/);assert.match(result.value.body,/谷歌译文1/);assert.ok(result.timers.some(x=>x.ms===34000));late(null,{status:200},JSON.stringify(response()));
});
test('partial backend result keeps Apple successes and only translates missing paragraphs',async()=>{
 const data=response();data.translations=data.translations.filter(x=>!x.ids.includes(2));data.complete=false;
 const result=await execute({data});const queries=result.gets.filter(x=>x.url.includes('translate.googleapis.com')).map(x=>new URL(x.url).searchParams.get('q')).join('');assert.ok(queries.includes('【2】'));assert.ok(!queries.includes('【1】'));assert.ok(!queries.includes('【0】'));
 const story=JSON.parse(result.value.body);assert.equal(story.title,'Markets rally\n市场上涨');assert.match(result.value.body,/第一段。/);assert.match(result.value.body,/谷歌译文2/);
});
test('unrelated endpoints and malformed JSON pass through without networking',async()=>{
 const irrelevant=await execute({requestUrl:'https://cdn-mobapi.bloomberg.com/wssmobile/v1/stories/find'});assert.equal(irrelevant.posts.length,0);assert.equal(irrelevant.value.body,undefined);
 const invalid=await execute({body:'null'});assert.equal(invalid.posts.length,0);assert.equal(invalid.value.body,undefined);
});
test('module renders backend-only arguments and contains no device credentials',()=>{
 const module=fs.readFileSync(path.join(__dirname,'../Bloomberg.Translate.sgmodule'),'utf8');
 const values=Object.fromEntries(module.match(/^#!arguments=(.*)$/m)[1].split(',').map(x=>x.split(':')));
 const line=module.split('\n').find(x=>x.startsWith('nickcxm.'));
 const argument=line.match(/argument="(.*)"$/)[1].replace(/\{\{\{(.*?)\}\}\}/g,(_,key)=>values[key]);
 assert.deepEqual(JSON.parse(argument),{enabled:true,removeAdConfig:true,debug:false,backendUrl:'http://192.168.50.71:18746'});assert.match(line,/bloomberg\.backend\.js/);assert.ok(!line.includes('baiduKey'));assert.ok(!line.includes('translate.googleapis.com'));
});


test('Google batches retain complete text, limit characters and separate repeated IDs',()=>{
 const text='A😀 '.repeat(1000);const batches=api.googleBatches([{id:1,text},{id:2,text:'Second paragraph.'}]);
 assert.equal(batches.flat().filter(x=>x.id===1).map(x=>x.text.replace(/^【1】/,'')).join(''),text);
 for(const batch of batches){assert.ok(Array.from(batch.map(x=>x.text).join('\n')).length<=1200);assert.equal(new Set(batch.map(x=>x.id)).size,batch.length);}
});
test('numbered alignment accepts changed symbols and merges only unresolved ranges',()=>{
 assert.deepEqual(api.alignGoogle('[ ２ ]第二段【1】第一段',[1,2]).pieces.map(x=>x.ids),[[2],[1]]);
 assert.deepEqual(api.alignGoogle('【1】前两段【3】第三段',[1,2,3]).pieces.map(x=>x.ids),[[1,2],[3]]);
 assert.deepEqual(api.alignGoogle('无编号译文',[1,2]).pieces[0].ids,[1,2]);
});
test('Google fallback has three in-flight requests maximum and joins long paragraphs',async()=>{
 let active=0,maximum=0;
 const result=await execute({healthError:true,body:JSON.stringify({...fixture(),components:[p('A'.repeat(7000))]}),get(req,cb){active++;maximum=Math.max(maximum,active);const query=new URL(req.url).searchParams.get('q');const ids=[...query.matchAll(/【(\d+)】/g)].map(x=>x[1]);setImmediate(()=>{active--;cb(null,{status:200},JSON.stringify([[...ids.map(id=>['【'+id+'】译文。','original'])]]));});}});
 assert.equal(maximum,3);const story=JSON.parse(result.value.body);assert.equal(story.components[0].parts.filter(x=>x._nickcxmTranslation).length,1);assert.ok(story.components[0].parts.at(-1).text.includes('译文。译文。'));
});
test('a failed fragment cannot be applied as a complete long paragraph',async()=>{
 let requests=0;
 const result=await execute({healthError:true,body:JSON.stringify({...fixture(),components:[p('A'.repeat(2400))]}),get(req,cb){requests++;if(requests===2)return cb('offline');const ids=[...new URL(req.url).searchParams.get('q').matchAll(/【(\d+)】/g)].map(x=>x[1]);cb(null,{status:200},JSON.stringify([[...ids.map(id=>['【'+id+'】译文。','original'])]]));}});
 const story=JSON.parse(result.value.body);assert.ok(!story.components[0].parts.some(x=>x._nickcxmTranslation));assert.match(result.value.body,/部分内容未能翻译/);
});

const v2Url=url.replace('/v1/','/v2/');
const v2Fixture=()=>({id:'TMM9Y6T3BZM200',title:'Markets rally',longUrl:'https://www.bloomberg.com/news/articles/2026-10-25/test?tracking=secret',publishedAt:100,updatedAt:123,premium:true,metered:true,adTargeting:{private:'DO_NOT_SEND_ADS'},adsDisabled:false,footer:{unknown:'keep'},structuredData:{errors:[],formatVersion:2,data:[{type:'paragraph',data:{},content:[{type:'text',value:'First paragraph.'}]},{type:'media',subType:'chart',data:{chart:{type:'image',url:'SECRET_CHART_URL'},identifiers:{id:123}}},{type:'paragraph',data:{},content:[{type:'entity',subType:'person',value:'Stock',content:[{type:'text',value:'Stock'}],data:{person:{id:123},link:{href:'SECRET_PROFILE_URL'}}},{type:'text',value:' rose today.'}]}]}});

test('both exact v1/v2 story URLs match, future versions and list endpoints do not',()=>{
 const module=fs.readFileSync(path.join(__dirname,'../Bloomberg.Translate.sgmodule'),'utf8');
 const line=module.split('\n').find(x=>x.startsWith('nickcxm.'));
 const pattern=new RegExp(line.match(/pattern=(.*?), requires-body/)[1]);
 for(const requestUrl of [url,v2Url,v2Url.split('?')[0]]){assert.ok(api.STORY.test(requestUrl));assert.ok(pattern.test(requestUrl));}
 for(const invalid of [url.replace('/v1/','/v3/'),v2Url.replace('TMM9Y6T3BZM200','find'),v2Url.replace('TMM9Y6T3BZM200','TMM9Y6T3BZM200/related')]){assert.ok(!api.STORY.test(invalid));assert.ok(!pattern.test(invalid));}
});
test('v2 structured content matches v1 payload and metadata without leaking entity data',()=>{
 const payload=api.prepare(v2Fixture(),v2Url);
 assert.deepEqual(payload,api.prepare(fixture(),url));
 assert.ok(!JSON.stringify(payload).includes('SECRET_'));assert.ok(!JSON.stringify(payload).includes('DO_NOT_SEND'));
});
test('v2 renderer appends value text, preserves charts/entity links and leaves access flags alone',()=>{
 const original=v2Fixture(),snapshot=JSON.stringify(original);const result=api.render(original,response(),{removeAdConfig:true});
 assert.equal(JSON.stringify(original),snapshot);assert.equal(result.components,undefined);assert.equal(result.title,'Markets rally\n市场上涨');
 assert.equal(result.structuredData.data.length,3);assert.deepEqual(result.structuredData.data[1],original.structuredData.data[1]);assert.deepEqual(result.structuredData.data[2].content[1],original.structuredData.data[2].content[0]);
 assert.equal(result.structuredData.data[0].content.at(-1).type,'text');assert.equal(result.structuredData.data[0].content.at(-1).value,'\n1. 第一段。');
 assert.deepEqual(result.structuredData.errors,original.structuredData.errors);assert.equal(result.structuredData.formatVersion,2);assert.deepEqual(result.footer,original.footer);assert.equal(result.premium,true);assert.equal(result.metered,true);assert.equal(result.adTargeting,undefined);assert.equal(result.adsDisabled,true);
});
test('v2 rerendering does not duplicate numbers or translate an existing Chinese part',()=>{
 const first=api.render(v2Fixture(),response(),{});assert.deepEqual(api.prepare(first,v2Url),api.prepare(v2Fixture(),v2Url));assert.deepEqual(api.render(first,response(),{}),first);
});
test('v2 backend execution returns a native structuredData response',async()=>{
 const result=await execute({requestUrl:v2Url,body:JSON.stringify(v2Fixture())});const story=JSON.parse(result.value.body);
 assert.equal(result.posts.length,1);assert.equal(JSON.parse(result.posts[0].body).article.id,'TMM9Y6T3BZM200');assert.equal(story.components,undefined);assert.equal(story.structuredData.data[0].content.at(-1).value,'\n1. 第一段。');assert.equal(story.structuredData.data[2].content.at(-1).value,'\n2. 股票今天上涨。');
});
test('v2 final Google fallback and failure notices use native paragraph/content/value nodes',async()=>{
 const result=await execute({requestUrl:v2Url,body:JSON.stringify(v2Fixture()),healthError:true});const story=JSON.parse(result.value.body);
 assert.equal(story.components,undefined);assert.match(story.structuredData.data[0].content.at(-1).value,/谷歌译文1/);
 const notice=story.structuredData.data.find(x=>x._nickcxmTranslationInfo);assert.equal(notice.type,'paragraph');assert.deepEqual(notice.data,{});assert.match(notice.content[0].value,/Google（设备直连备用）/);
 const failed=await execute({requestUrl:v2Url,body:JSON.stringify(v2Fixture()),healthError:true,googleError:true});assert.match(failed.value.body,/保留原文/);assert.equal(JSON.parse(failed.value.body).components,undefined);
});
test('v2 merged translations retain numbering at the last original paragraph',()=>{
 const data=response();data.titleTranslation='';data.translations=[{ids:[0,1,2],text:'合并译文'}];
 const result=api.render(v2Fixture(),data,{removeAdConfig:false});assert.equal(result.title,'Markets rally');assert.equal(result.structuredData.data[2].content.at(-1).value,'\n0. 1. 2. 合并译文');assert.deepEqual(result.adTargeting,v2Fixture().adTargeting);
});
