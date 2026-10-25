'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const api=require('../bloomberg.response.js');
const params={usageUrl:'http://192.168.50.71:18746',baiduAppId:'12345678',baiduKey:'PRIVATE_SIGNING_KEY'};
function client(allowed=true){const posts=[];return {posts,post(req,cb){posts.push(req);const data=JSON.parse(req.body);cb(null,{status:200},JSON.stringify(req.url.endsWith('/reserve')?{id:data.id,allowed}:{updated:true}));}};}
test('ledger sees metadata only, counted by Unicode characters, before provider call',async()=>{
 const http=client();let invoked=0;const translate=api.trackedTransport('baidu',async text=>{invoked++;assert.equal(http.posts.length,1);return '中文';},http,params);
 assert.equal(await translate('A😀【1】',5000),'中文');assert.equal(invoked,1);
 assert.equal(http.posts[0].policy,'DIRECT');const metadata=JSON.parse(http.posts[0].body);assert.deepEqual(Object.keys(metadata).sort(),['appid','characters','id','provider']);assert.equal(metadata.characters,5);
 assert.equal(JSON.parse(http.posts[1].body).state,'success');assert.ok(!JSON.stringify(http.posts).includes(params.baiduKey));assert.ok(!JSON.stringify(http.posts).includes('A😀'));
});
test('quota blocks physical Baidu calls, breaks circuit and Google fallback is recorded',async()=>{
 const http=client(false);let baidu=0;
 const primary=api.trackedTransport('baidu',async()=>{baidu++;},http,params);
 await assert.rejects(primary('hello',5000),e=>e.code==='quota');await assert.rejects(primary('hello',5000),e=>e.code==='quota');assert.equal(baidu,0);assert.equal(http.posts.length,1);
 const fallbackHttp=client();const google=api.trackedTransport('google',async()=> '中文',fallbackHttp,params);
 const fallback=api.primaryWithFallback(primary,google,()=>{});assert.equal(await fallback('hello',5000),'中文');assert.equal(JSON.parse(fallbackHttp.posts[0].body).appid,'');
});
test('service unavailable fails closed without contacting providers',async()=>{
 let called=0;const http={post(req,cb){cb('offline');}};
 const translate=api.trackedTransport('google',async()=>{called++;},http,params);
 await assert.rejects(translate('hello',3000),e=>e.code==='usage');assert.equal(called,0);
});
test('Baidu requests reserve serially and later queued work is not charged after first failure',async()=>{
 const http=client();let count=0;
 const translate=api.trackedTransport('baidu',async()=>{count++;throw Object.assign(new Error('failure'),{code:'timeout'});},http,params);
 const results=await Promise.allSettled([translate('a',5000),translate('b',5000),translate('c',5000)]);
 assert.ok(results.every(r=>r.status==='rejected'));assert.equal(count,1);assert.equal(http.posts.filter(p=>p.url.endsWith('/reserve')).length,1);assert.equal(JSON.parse(http.posts[1].body).state,'failed');
});
test('failed status reporting never repeats a provider call and timeout errors are safe',async()=>{
 let calls=0;const http=client();const post=http.post;http.post=(req,cb)=>req.url.endsWith('/complete')?cb('offline'):post(req,cb);
 const translate=api.trackedTransport('google',async()=>{calls++;return '中文';},http,params);
 assert.equal(await translate('abc',3000),'中文');assert.equal(calls,1);assert.match(api.readableError({code:'usage'}),/统计服务/);
});
