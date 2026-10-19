import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
const app=await readFile(new URL('../app.js',import.meta.url),'utf8');
const code=app.slice(app.indexOf('const STAGE_ASSETS ='),app.indexOf('async function loadStageAndAvatar()'));
const bytes=await readFile(new URL('../rig_calibration.json',import.meta.url));
const filename='rig_calibration.json';
function setup({unavailable=false,quota=false,corrupt=false}={}){
 const stored=new Map();let requests=0;
 const cache={
  match:async key=>stored.get(key)?.clone(),
  put:async(key,response)=>{if(quota)throw Error('QuotaExceededError');stored.set(key,response.clone());},
  keys:async()=>[...stored.keys()].map(url=>({url})),delete:async key=>stored.delete(key),
 };
 const context={URL,Response,Uint8Array,crypto:webcrypto,console:{info(){}},location:{href:'https://concert.example/piano/'},
  fetch:async(url,options)=>{requests++;assert.equal(options.credentials,'omit');assert.ok(!url.includes('Date.now'));
   const data=Buffer.from(bytes);if(corrupt)data[0]^=1;return new Response(data,{headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});},
 };
 if(!unavailable)context.caches={open:async()=>cache};
 vm.runInNewContext(code+'\nglobalThis.loadAsset=loadPublicStageAsset;',context);
 return {load:context.loadAsset,stored,requests:()=>requests};
}
const cached=setup();let progress=0;
assert.equal((await cached.load(filename,(n,total)=>{progress=n/total;})).byteLength,bytes.length);
assert.equal(progress,1);assert.equal(cached.requests(),1);
await cached.load(filename);assert.equal(cached.requests(),1,'second load must reuse cached data despite server no-store');
assert.match([...cached.stored.keys()][0],/v=[a-f0-9]{64}$/,'asset URL must carry the release fingerprint');
for(const options of [{unavailable:true},{quota:true}]){
 const fallback=setup(options);assert.equal((await fallback.load(filename)).byteLength,bytes.length,'unavailable cache must not break the stage');
}
const corrupt=setup({corrupt:true});await assert.rejects(()=>corrupt.load(filename),/updated/);
assert.equal(corrupt.stored.size,0,'a mismatched release must never enter the cache');
console.log('Public stage cache: cold/warm load, download progress, versioned keys, unavailable/full cache fallback and checksum validation passed.');
