'use strict';
const {app,BrowserWindow,WebContentsView,ipcMain,protocol,session,dialog,systemPreferences}=require('electron');
const {spawn}=require('node:child_process');
const fs=require('node:fs');const path=require('node:path');const {pathToFileURL}=require('node:url');const readline=require('node:readline');
const {PCMParser}=require('./audio-protocol.cjs');
const root=__dirname;
protocol.registerSchemesAsPrivileged([{scheme:'performer-assets',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true}}]);
if(process.env.PERFORMER_TEST_DATA)app.setPath('userData',process.env.PERFORMER_TEST_DATA);
const dataDir=app.getPath('userData');
const settingsPath=path.join(dataDir,'settings.json'),sessionPath=path.join(dataDir,'session.json');
const readJSON=(file,fallback)=>{try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return fallback;}};
// Default to a stage running on this computer; set your public HTTPS stage in the Mixer tab.
let settings=readJSON(settingsPath,{url:'http://localhost:8765/'});
let win,stage,engine,engineReady=false,lastStatus={running:false},showLive=false,stageAudioReady=false,waitingAudio=false;
let audioQueue=[];let sessionRestored=false;
let requestId=0,selectedTab='mixer',closing=false;const requests=new Map();let pluginPaths=new Set();
function atomicJSON(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file+'.tmp',JSON.stringify(value,null,2),{mode:0o600});fs.renameSync(file+'.tmp',file);}
function send(channel,value){if(closing)return;const targets=[];if(win&&!win.isDestroyed())targets.push(win.webContents);if(stage)targets.push(stage.webContents);for(const w of targets)if(w&&!w.isDestroyed())w.send(channel,value);}
async function rpc(c) {
 if(!engineReady)await new Promise(resolve=>{let attempts=0;const poll=setInterval(()=>{if(engineReady||++attempts>=100){clearInterval(poll);resolve();}},50);});
 if(!engineReady)return Promise.reject(Error('Audio engine is not ready'));
 return new Promise((resolve,reject)=>{
   const id=++requestId;const timer=setTimeout(()=>{requests.delete(id);reject(Error('Audio engine timed out; check for a plug-in activation dialog.'));},120000);
   requests.set(id,{resolve,reject,timer});engine.stdin.write(JSON.stringify({...c,id})+'\n');
 });
}
function flushAudio(){if(closing||waitingAudio||!stageAudioReady||!stage||stage.webContents.isDestroyed()||!audioQueue.length)return;waitingAudio=true;stage.webContents.send('native-audio',audioQueue.shift());}
function deliverAudio(frame){if(!stageAudioReady)return;audioQueue.push({rate:frame.rate,sequence:frame.sequence,pcm:Uint8Array.from(frame.pcm)});if(audioQueue.length>8)audioQueue.shift();flushAudio();}
function pluginFolders(){
 if(process.platform==='win32'){
  const common=process.env.CommonProgramFiles||'C:\\Program Files\\Common Files';
  return [path.join(common,'VST3'),path.join(process.env.LOCALAPPDATA||path.join(app.getPath('home'),'AppData','Local'),'Programs','Common','VST3')];
 }
 if(process.platform==='linux')return [path.join(app.getPath('home'),'.vst3'),'/usr/lib/vst3','/usr/local/lib/vst3'];
 return ['/Library/Audio/Plug-Ins/VST3',path.join(app.getPath('home'),'Library/Audio/Plug-Ins/VST3')];
}
function listPlugins(){
 // Vendors often install into a sub-folder (e.g. VST3/Vendor/Plugin.vst3), so scan two levels.
 const result=[];const scan=(dir,depth)=>{let entries;try{entries=fs.readdirSync(dir,{withFileTypes:true});}catch{return;}
   for(const entry of entries){const p=path.join(dir,entry.name);
     if(entry.name.toLowerCase().endsWith('.vst3'))result.push({path:p,name:entry.name.replace(/\.vst3$/i,'').replace(/^uaudio_/,'UAD · ').replaceAll('_',' ')});
     else if(entry.isDirectory()&&depth>0)scan(p,depth-1);}};
 for(const dir of pluginFolders())scan(dir,1);
 result.sort((a,b)=>a.name.localeCompare(b.name));pluginPaths=new Set(result.map(p=>p.path));return result;
}
function enginePaths(){
 if(process.platform==='win32')return [path.join(process.resourcesPath,'native','Performer Audio Engine.exe'),path.resolve(root,'../build/PerformerAudio_artefacts/Release/Performer Audio Engine.exe')];
 if(process.platform==='linux')return [path.join(process.resourcesPath,'native','Performer Audio Engine'),path.resolve(root,'../build/PerformerAudio_artefacts/Release/Performer Audio Engine')];
 return [path.join(process.resourcesPath,'native','Performer Audio Engine.app','Contents','MacOS','Performer Audio Engine'),path.resolve(root,'../build/PerformerAudio_artefacts/Release/Performer Audio Engine.app/Contents/MacOS/Performer Audio Engine')];
}
function startEngine(){
 const [bundledEngine,devEngine]=enginePaths();
 const executable=fs.existsSync(bundledEngine)?bundledEngine:devEngine;
 engine=spawn(executable,[],{stdio:['pipe','pipe','pipe','pipe']});
 engine.on('error',err=>{console.error('Audio helper launch failed:',err.message);send('engine-error',err.message);});
 engine.stderr.on('data',data=>process.stderr.write(data));
 const lines=readline.createInterface({input:engine.stdout});
 lines.on('line',line=>{let message;try{message=JSON.parse(line);}catch{return;}
   if(message.event==='ready'){engineReady=true;rpc({op:'status'}).then(s=>{lastStatus=s;send('engine-status',s);}).catch(()=>{});}
   if(message.event==='status'){lastStatus=message.data;send('engine-status',lastStatus);}
   if(message.event==='midi'&&!closing&&stage&&!stage.webContents.isDestroyed())stage.webContents.send('native-midi',message.messages);
   const request=requests.get(message.id);if(request){clearTimeout(request.timer);requests.delete(message.id);if(message.ok&&message.data&&typeof message.data.running==='boolean'){lastStatus=message.data;send('engine-status',lastStatus);}message.ok?request.resolve(message.data):request.reject(Error(message.error));}
 });
 const parser=new PCMParser(deliverAudio);
 engine.stdio[3].on('data',chunk=>{try{parser.push(chunk);}catch(err){send('engine-error',err.message);engine.kill();}});
 engine.on('exit',()=>{engineReady=false;lastStatus={running:false};send('engine-status',lastStatus);send('engine-error','Audio engine stopped. Relaunch Performer Studio to restart it.');for(const r of requests.values()){clearTimeout(r.timer);r.reject(Error('Audio engine stopped'));}requests.clear();});
}
// HTTPS is required for remote stages; plain HTTP is accepted only for a stage on this computer.
const isLocalHost=host=>['localhost','127.0.0.1','[::1]'].includes(host);
function validateURL(value){const url=new URL(value);if(!(url.protocol==='https:'||(url.protocol==='http:'&&isLocalHost(url.hostname)))||url.username||url.password||url.search||url.hash)throw Error('Enter an HTTPS stage URL (or http://localhost) without credentials or query parameters.');if(!url.pathname.endsWith('/'))url.pathname+='/';return url.href;}
function trustedStage(event){return stage&&event.sender===stage.webContents&&event.senderFrame===stage.webContents.mainFrame&&new URL(event.senderFrame.url).origin===new URL(settings.url).origin;}
function trustedShell(event){return win&&event.sender===win.webContents&&event.senderFrame===win.webContents.mainFrame&&event.senderFrame.url===pathToFileURL(path.join(root,'index.html')).href;}
function shellHandle(name,fn){ipcMain.handle(name,(e,...args)=>{if(!trustedShell(e))throw Error('Untrusted control request');return fn(...args);});}
function layout(){if(!stage)return;const [width,height]=win.getContentSize();stage.setBounds(selectedTab==='performer'?{x:0,y:64,width,height:Math.max(1,height-64)}:{x:width+10,y:64,width,height:Math.max(1,height-64)});}
async function createStage(){
 const ses=session.fromPartition('persist:performer-stage');
 // Only the pinned performer script and the PCM worklet are replaced. Cookies,
 // TLS validation, origin checks and the existing login remain native Chromium.
 ses.webRequest.onBeforeRequest((details,callback)=>{
   const url=new URL(details.url),base=new URL(settings.url);
   const asset=url.origin===base.origin&&[base.pathname+'app.js',base.pathname+'desktop-pcm.js'].includes(url.pathname);
   callback(asset?{redirectURL:'performer-assets://studio/'+url.pathname.split('/').pop()} : {});
 });
 ses.protocol.handle('performer-assets',async request=>{
   const url=new URL(request.url),base=new URL(settings.url);
   if(url.hostname==='studio'&&url.pathname==='/app.js'){
     let code=fs.readFileSync(path.join(root,'assets','app.js'),'utf8');
     code=code.replace(/from '(\.\/[^']+)'/g,(_match,relative)=>'from '+JSON.stringify(new URL(relative,base).href));
     code=code.replace('async function initWebMIDI() {','async function initWebMIDI() { if (window.nativeStudio) { document.getElementById("midi-badge").textContent="Native MIDI · choose input in Mixer"; document.getElementById("midi-select").disabled=true; return; }');
     code=code.replace('async function toggleRecordShow() {','async function toggleRecordShow() { if (window.nativeStudio && !STATE.recordingShow) { try { await prepareNativeAudio(); } catch (e) { alert(e.message); return; } }');
     code=code.replaceAll('STATE.recordingShow = true;', 'STATE.recordingShow = true; window.nativeStudio.live(true);').replaceAll('STATE.recordingShow = false;', 'STATE.recordingShow = false; window.nativeStudio.live(false);');
     code+='\n'+fs.readFileSync(path.join(root,'stage-bridge.js'),'utf8');
     return new Response(code,{headers:{'Content-Type':'text/javascript','Cache-Control':'no-store','Access-Control-Allow-Origin':base.origin}});
   }
   if(url.hostname==='studio'&&url.pathname==='/desktop-pcm.js')return new Response(fs.readFileSync(path.join(root,'pcm-worklet.js')),{headers:{'Content-Type':'text/javascript','Access-Control-Allow-Origin':base.origin}});
   return new Response('Not found',{status:404});
 });
 const allow=(permission,details)=>['media','midi','midiSysex','fullscreen'].includes(permission)&&(!details?.securityOrigin||details.securityOrigin===new URL(settings.url).origin);
 ses.setPermissionRequestHandler((contents,permission,callback,details)=>callback(contents===stage?.webContents&&allow(permission,details)));
 ses.setPermissionCheckHandler((contents,permission,origin)=>contents===stage?.webContents&&origin===new URL(settings.url).origin&&allow(permission));
 stage=new WebContentsView({webPreferences:{session:ses,preload:path.join(root,'stage-preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false,autoplayPolicy:'no-user-gesture-required'}});
 win.contentView.addChildView(stage);layout();
 stage.webContents.setWindowOpenHandler(()=>({action:'deny'}));
 stage.webContents.on('will-navigate',(e,url)=>{if(!url.startsWith(settings.url))e.preventDefault();});
 stage.webContents.on('did-start-loading',()=>{stageAudioReady=false;waitingAudio=false;audioQueue=[];});
 stage.webContents.on('render-process-gone',()=>{stageAudioReady=false;waitingAudio=false;audioQueue=[];showLive=false;send('live-state',false);send('engine-error','Performer view stopped. Native monitoring is still running; reopen the app before broadcasting.');});
 stage.webContents.on('did-fail-load',(_e,code,description,_url,isMainFrame)=>{if(isMainFrame&&code!==-3)send('engine-error',`Performer page: ${description}. Mixer remains available.`);});
 await stage.webContents.loadURL(settings.url).catch(()=>{});
}
app.whenReady().then(async()=>{
 win=new BrowserWindow({width:1440,height:960,minWidth:1050,minHeight:720,title:'Performer Studio',backgroundColor:'#10141c',webPreferences:{preload:path.join(root,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
 win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.webContents.on('will-navigate',e=>e.preventDefault());
 shellHandle('plugins',listPlugins);shellHandle('settings',()=>settings);
 shellHandle('tab',tab=>{selectedTab=tab==='performer'?'performer':'mixer';layout();});
 shellHandle('connect',async url=>{if(showLive)throw Error('Stop the show before changing the stage URL.');settings.url=validateURL(url);atomicJSON(settingsPath,settings);await stage.webContents.loadURL(settings.url);return settings;});
 const allowed=new Set(['devices','start','stop','load','editor','gain','mute','pan','solo','bypass','monitor','input','midiDevice','panic','status']);
 shellHandle('engine',async c=>{
   if(!c||!allowed.has(c.op))throw Error('Unsupported control');
   if(showLive&&['start','stop','load','input','midiDevice'].includes(c.op))throw Error('Stop the show before changing audio routing or plug-ins.');
   if(c.op==='load'&&c.path&&!pluginPaths.has(c.path))throw Error('Select an installed VST3 plug-in.');
   if(c.op==='start'&&c.input!=='__none__'&&process.platform==='darwin'&&!await systemPreferences.askForMediaAccess('microphone'))throw Error('Allow microphone access in System Settings → Privacy & Security.');
   return rpc(c);
 });
 shellHandle('save',async()=>{if(showLive)throw Error('Stop the show before saving plug-in state.');const state=await rpc({op:'save'});atomicJSON(sessionPath,state);return sessionPath;});
 shellHandle('restore',async(optional=false)=>{if(showLive)throw Error('Stop the show before restoring a session.');const state=readJSON(sessionPath,null);if(!state){sessionRestored=true;if(optional)return null;throw Error('No saved session yet.');}for(const p of state.plugins||[])if(!pluginPaths.has(p.path))throw Error('Missing installed plug-in: '+p.path);const restored=await rpc({op:'restore',session:state});sessionRestored=true;return restored;});
 ipcMain.handle('stage-status',e=>{if(!trustedStage(e))throw Error('Untrusted stage');return lastStatus;});
 ipcMain.on('stage-midi',(e,bytes)=>{if(trustedStage(e)&&Array.isArray(bytes)&&bytes.length>=2&&bytes.length<=3&&bytes.every(v=>Number.isInteger(v)&&v>=0&&v<=255))rpc({op:'midi',bytes}).catch(()=>{});});
 ipcMain.on('stage-live',(e,value)=>{if(trustedStage(e)){showLive=!!value;send('live-state',showLive);}});
 ipcMain.on('audio-ready',e=>{if(trustedStage(e)){stageAudioReady=true;waitingAudio=false;}});
 ipcMain.on('audio-ack',e=>{if(trustedStage(e)){waitingAudio=false;flushAudio();}});
 win.on('resize',layout);
 win.on('close',e=>{if(closing)return;e.preventDefault();(async()=>{if(showLive){const result=await dialog.showMessageBox(win,{type:'warning',message:'A show is live. Stop and save it in Performer before closing.',buttons:['Keep open','Quit without finishing archive'],defaultId:0,cancelId:0});if(result.response===0)return;}if(engineReady&&sessionRestored&&!showLive){try{atomicJSON(sessionPath,await rpc({op:'save'}));}catch(error){const result=await dialog.showMessageBox(win,{type:'warning',message:'Could not save your mixer setup.',detail:error.message,buttons:['Keep open','Quit without saving'],defaultId:0,cancelId:0});if(result.response===0)return;}}closing=true;stage?.webContents.close();engine?.stdin.end();win.destroy();app.quit();})();});
 startEngine();await win.loadFile(path.join(root,'index.html'));listPlugins();await createStage();
 if(process.env.PERFORMER_SMOKE==='1')setTimeout(async()=>{
  try{
   const result=await win.webContents.executeJavaScript('({title:document.title,cards:document.querySelectorAll(".strip").length,notice:document.getElementById("notice").textContent,consoleBottom:document.getElementById("channels").getBoundingClientRect().bottom,viewport:innerHeight})');
   console.log('SMOKE',JSON.stringify(result));fs.mkdirSync(dataDir,{recursive:true});
   fs.writeFileSync(path.join(dataDir,'mixer.png'),(await win.webContents.capturePage()).toPNG());
   console.log('STAGE',await stage.webContents.executeJavaScript('({title:document.title,native:!!window.nativeStudio,visibility:document.visibilityState,midi:document.getElementById("midi-badge")?.textContent})'));
   const loginProbe=await stage.webContents.executeJavaScript(`fetch('./api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}).then(async r=>({status:r.status,body:await r.json()}))`);
   console.log('LOGIN_ORIGIN_CHECK',JSON.stringify(loginProbe));
   if(loginProbe.status!==400||loginProbe.body.error!=='Invalid request')throw Error('Login origin check failed');
   if(process.env.PERFORMER_AUDIO_TEST==='1'){
    for(const [slot,file]of [['instrument','Pianoteq 9.vst3'],['mic0','uaudio_api_vision_channel_strip.vst3'],['aux10','uaudio_pure_plate.vst3'],['master0','uaudio_api_2500.vst3']])await rpc({op:'load',slot,path:'/Library/Audio/Plug-Ins/VST3/'+file});
    await new Promise(r=>setTimeout(r,300));fs.writeFileSync(path.join(dataDir,'mixer-loaded.png'),(await win.webContents.capturePage()).toPNG());
    await rpc({op:'start',input:'__none__',rate:48000,buffer:256});
    const recording=stage.webContents.executeJavaScript(`(async()=>{
     const module=await import(document.querySelector('script[type="module"][src*="app.js"]').src);
     const stream=await module.nativeRecordingStream();
     const chunks=[];const recorder=new MediaRecorder(stream,{mimeType:'audio/webm;codecs=opus'});
     recorder.ondataavailable=e=>chunks.push(e.data);recorder.start(200);
     await new Promise(r=>setTimeout(r,2500));await new Promise(r=>{recorder.onstop=r;recorder.stop();});
     const bytes=new Uint8Array(await new Blob(chunks).arrayBuffer());
     const ctx=new AudioContext();const decoded=await ctx.decodeAudioData(bytes.buffer.slice(0));let peak=0;for(const s of decoded.getChannelData(0))peak=Math.max(peak,Math.abs(s));await ctx.close();
     return {bytes:Array.from(bytes),peak,duration:decoded.duration};
    })()`).then(value=>({value}),error=>({error}));
    await new Promise(r=>setTimeout(r,600));await rpc({op:'midi',bytes:[144,60,100]});
    await new Promise(r=>setTimeout(r,800));await rpc({op:'midi',bytes:[128,60,0]});
    const result=await recording;if(result.error)throw result.error;const captured=result.value;
    fs.writeFileSync(path.join(dataDir,'native-stream.webm'),Buffer.from(captured.bytes));
    if(captured.peak<0.0001)throw Error('Stream recording was silent');
    console.log('AUDIO_CAPTURE',JSON.stringify({bytes:captured.bytes.length,peak:captured.peak,duration:captured.duration}));
    await rpc({op:'stop'});
   }
  }catch(error){console.error('SMOKE_FAILED',error);process.exitCode=1;}
  finally{closing=true;stage?.webContents.close();engine?.stdin.end();app.quit();}
 },5000);
});
app.on('window-all-closed',()=>app.quit());
app.on('before-quit',event=>{if(!closing&&win&&!win.isDestroyed()){event.preventDefault();win.close();return;}engine?.stdin.end();});
