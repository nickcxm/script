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
async function execute({offline=false,data=response(),requestUrl=url,body=JSON.stringify(fixture())}={}){
 const posts=[],logs=[],timers=[];let called=0;let done;
 const completed=new Promise(resolve=>{done=resolve;});
 vm.runInNewContext(script,{$request:{url:requestUrl,method:'GET',headers:{Cookie:'PRIVATE_COOKIE',Authorization:'PRIVATE_AUTH'}},$response:{status:200,body,headers:{'Content-Type':'application/json',ETag:'old'}},$argument:JSON.stringify({backendUrl:'http://192.168.50.71:18746'}),$httpClient:{post(req,cb){posts.push(req);cb(offline?'offline':null,{status:200},JSON.stringify(data));},get(){assert.fail('no direct provider request');}},$persistentStore:new Proxy({},{get(){throw Error('no storage');}}),console:{log(text){logs.push(text);}},setTimeout(fn){timers.push(fn);},$done(value){called++;done(value);}});
 const value=await completed;for(const timer of timers)timer();await Promise.resolve();assert.equal(called,1);return{value,posts,logs};
}
test('one backend request per article, direct routing and clean independent headers',async()=>{
 const result=await execute();assert.equal(result.posts.length,1);assert.equal(result.posts[0].url,'http://192.168.50.71:18746/api/translate');assert.equal(result.posts[0].policy,'DIRECT');
 assert.deepEqual(Object.keys(result.posts[0].headers),['Content-Type']);assert.ok(!JSON.stringify(result.posts).includes('PRIVATE_'));assert.equal(JSON.parse(result.value.body).title,'Markets rally\n市场上涨');assert.equal(result.value.headers.ETag,undefined);
});
test('backend offline keeps original text and images, adds one actionable error',async()=>{
 const result=await execute({offline:true});const story=JSON.parse(result.value.body);assert.equal(story.title,fixture().title);assert.deepEqual(story.components[0],fixture().components[0]);assert.match(result.value.body,/无法连接 mini/);assert.equal(result.posts.length,1);
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
