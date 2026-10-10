'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const api=require('../baidumap.response.js');
const source=fs.readFileSync(path.join(__dirname,'../baidumap.response.js'),'utf8');
const PACKAGE_URL='https://newclient.map.baidu.com/client/imap/dl/s/UpdateInfo.php?qt=upv&cate=components';
const CLOUD_URL='https://mbd.baidu.com/ccs/v1/start/confsync?appname=bdmap';
const keep=['searchList','startPage','comdetailtmpl','indoordetail','usersystem','websdk'];
function packages(){return {result:{error:0,type:101},other:{unchanged:true},packages:Object.fromEntries([...Object.values(api.PACKAGE_GROUPS).flat(),...keep,'futureUnknown'].map(name=>['map.iphone.baidu.'+name,{version:'1',key:'opaque-key',md5sum:'opaque-hash',force:1}]))};}
function cloud(){return {errno:0,logid:'PRIVATE_LOG_ID',data:{control:{keep:true},service:{dpm:{talos:{mainentrance:{'bdmap.mapclient.feed':{data:{pkg_control:{disable:'0'},sign:'feed-sign'}},'bdmap.pubTravel.rtBus':{data:{sign:'bus-sign',dependencies:{bus:'1',walk:'2',cycle:'3'}}}},dependencies:{'bdmap.mapclient.feed__CLOTHOPROD__HomeFeed':{v:'keep structure'},'bdmap.mapclient.feed__CLOTHOPROD__sanNativeFramework':{v:'shared framework'},'bdmap.pubTravel.rtBus__CLOTHOPROD__BMPTBusLinePage':{v:'bus'},'bdmap.pubTravel.rtBus__CLOTHOPROD__BMPTWalkCycleFrame':{v:'walk'},'bdmap.pubTravel.rtBus__CLOTHOPROD__sanNativeFramework':{v:'shared'},future:{v:'unknown'}}}}},pubparam:{keep:true}}};}
function run({url=PACKAGE_URL,method='GET',body=JSON.stringify(packages()),status=200,type='application/json',argument='{}'}={}){
 let calls=0,result;const logs=[];
 const request={url,method};Object.defineProperty(request,'headers',{get(){throw Error('No credential access');}});Object.defineProperty(request,'body',{get(){throw Error('No request body access');}});
 vm.runInNewContext(source,{$request:request,$response:{status,body,headers:{'Content-Type':type,'Content-Encoding':'gzip','Content-Length':'100',ETag:'old','X-Other':'keep'}},$argument:argument,
 $httpClient:new Proxy({},{get(){throw Error('Network forbidden');}}),$persistentStore:new Proxy({},{get(){throw Error('Storage forbidden');}}),console:{log(value){logs.push(value);}},$done(value){calls++;result=value;}},{timeout:1000});
 assert.equal(calls,1);return {result,logs};
}
test('exact blocked list removes 13 observed packages and preserves core and unknown packages',()=>{
 const input=packages(),snapshot=JSON.stringify(input);const result=api.transform(input,'packages');
 assert.equal(result.stats.removedPackages.length,13);assert.equal(JSON.stringify(input),snapshot);
 assert.deepEqual(Object.keys(result.body.packages),[...keep,'futureUnknown'].map(name=>'map.iphone.baidu.'+name));
 for(const name of keep)assert.deepEqual(result.body.packages['map.iphone.baidu.'+name],input.packages['map.iphone.baidu.'+name]);
 assert.deepEqual(result.body.result,input.result);assert.deepEqual(result.body.other,input.other);
});
test('individual feature groups can be kept without modifying other groups',()=>{
 for(const option of Object.keys(api.PACKAGE_GROUPS)){
  const input=packages();const output=api.transform(input,'packages',{...api.DEFAULTS,[option]:false});
  for(const name of api.PACKAGE_GROUPS[option])assert.deepEqual(output.body.packages['map.iphone.baidu.'+name],input.packages['map.iphone.baidu.'+name]);
 }
});
test('only HomeFeed entrance and dependency are removed; every shared and transit dependency remains',()=>{
 const input=cloud(),snapshot=JSON.stringify(input),before=input.data.service.dpm.talos;
 const result=api.transform(input,'cloud'),after=result.body.data.service.dpm.talos;
 assert.equal(result.stats.removedFeedEntry,true);assert.equal(result.stats.removedFeedDependency,true);
 assert.equal('bdmap.mapclient.feed' in after.mainentrance,false);
 assert.deepEqual(after.mainentrance['bdmap.pubTravel.rtBus'],before.mainentrance['bdmap.pubTravel.rtBus']);
 for(const key of Object.keys(before.dependencies))if(key!=='bdmap.mapclient.feed__CLOTHOPROD__HomeFeed')assert.deepEqual(after.dependencies[key],before.dependencies[key]);
 assert.equal(JSON.stringify(input),snapshot);assert.equal(result.body.logid,input.logid);assert.deepEqual(result.body.data.pubparam,input.data.pubparam);
});
test('disabled filtering and unknown/error schemas pass through',()=>{
 for(const kind of ['cloud','packages'])assert.equal(api.transform(kind==='cloud'?cloud():packages(),kind,{...api.DEFAULTS,enabled:false}).changed,false);
 assert.equal(api.transform(cloud(),'cloud',{...api.DEFAULTS,hideFeed:false}).changed,false);
 for(const body of [null,[],{}, {result:{error:1},packages:{}},{errno:1,data:cloud().data}]){
  assert.equal(api.transform(body,'packages').changed,false);assert.equal(api.transform(body,'cloud').changed,false);
 }
});
test('filtering is idempotent',()=>{
 for(const kind of ['cloud','packages']){const first=api.transform(kind==='cloud'?cloud():packages(),kind);const second=api.transform(first.body,kind);assert.equal(second.changed,false);assert.deepEqual(second.body,first.body);}
});
test('route guards isolate bdmap from other Baidu apps and other update categories',()=>{
 assert.equal(api.route({url:CLOUD_URL,method:'POST'}),'cloud');assert.equal(api.route({url:PACKAGE_URL,method:'GET'}),'packages');
 for(const request of [{url:CLOUD_URL.replace('bdmap','otherapp'),method:'POST'},{url:CLOUD_URL,method:'GET'},{url:PACKAGE_URL,method:'POST'},{url:PACKAGE_URL.replace('components','other'),method:'GET'},{url:PACKAGE_URL.replace('upv','other'),method:'GET'},{url:PACKAGE_URL.replace('newclient.map.baidu.com','example.test'),method:'GET'}])assert.equal(api.route(request),null);
});
test('runtime filters packages without network, storage or request credential/body access',()=>{
 const {result,logs}=run({argument:'{"debug":true}'});assert.ok(result.body);const output=JSON.parse(result.body);assert.equal(Object.keys(output.packages).length,7);
 assert.equal(result.headers.ETag,undefined);assert.equal(result.headers['Content-Encoding'],undefined);assert.equal(result.headers['Content-Length'],undefined);
 assert.equal(result.headers['Cache-Control'],'no-store');assert.equal(result.headers['X-Other'],'keep');assert.equal(JSON.stringify(logs).includes('opaque-key'),false);
});
test('runtime filters cloud and never logs returned private identifiers',()=>{
 const {result,logs}=run({url:CLOUD_URL,method:'POST',body:JSON.stringify(cloud()),argument:'{"debug":true}'});
 assert.ok(result.body);assert.equal(JSON.stringify(logs).includes('PRIVATE_LOG_ID'),false);assert.ok(JSON.parse(result.body).data.service.dpm.talos.mainentrance['bdmap.pubTravel.rtBus']);
});
test('invalid JSON/options, non-JSON and non-200 responses remain untouched',()=>{
 for(const options of [{body:'{bad'},{argument:'{bad'},{argument:'{"enabled":false}'},{status:304},{type:'text/html'},{url:CLOUD_URL.replace('bdmap','otherapp'),method:'POST',body:JSON.stringify(cloud())}])assert.equal(Object.keys(run(options).result).length,0);
});
test('module argument declarations, placeholders and patterns are valid',()=>{
 const text=fs.readFileSync(path.join(__dirname,'../BaiduMap.Minimal.sgmodule'),'utf8');
 const values={};for(const item of text.match(/^#!arguments=(.*)$/m)[1].split(',')){const [name,value]=item.split(':');assert.match(name,/^[a-z_]+$/);assert.ok(value);values[name]=value;}
 const line=text.split('\n').find(line=>line.startsWith('nickcxm.'));const regex=new RegExp(line.match(/pattern=(.*?), requires-body/)[1]);
 assert.ok(regex.test(PACKAGE_URL));assert.ok(regex.test(CLOUD_URL));assert.equal(regex.test('https://newclient.map.baidu.com/client/phpui2/'),false);
 const argument=line.match(/argument="(.*)"$/)[1].replace(/\{\{\{([^}]+)\}\}\}/g,(_,name)=>{assert.ok(name in values);return values[name];});assert.deepEqual(JSON.parse(argument),api.DEFAULTS);
});
