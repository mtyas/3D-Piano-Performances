const {spawn}=require('node:child_process');const readline=require('node:readline');const path=require('node:path');const assert=require('node:assert/strict');
const fs=require('node:fs');
const exe=process.platform==='win32'?path.resolve(__dirname,'../build/PerformerAudio_artefacts/Release/Performer Audio Engine.exe'):path.resolve(__dirname,'../build/PerformerAudio_artefacts/Release/Performer Audio Engine.app/Contents/MacOS/Performer Audio Engine');
// The hosting checks use specific installed plug-ins (Pianoteq 9 and three UADx effects).
// Override the folder with PERFORMER_VST3_DIR; the test is skipped when they are absent.
const vst3=process.env.PERFORMER_VST3_DIR||(process.platform==='win32'?path.join(process.env.CommonProgramFiles||'C:\\Program Files\\Common Files','VST3'):'/Library/Audio/Plug-Ins/VST3');
const required=['Pianoteq 9.vst3','uaudio_api_vision_channel_strip.vst3','uaudio_pure_plate.vst3','uaudio_api_2500.vst3'];
const missing=required.filter(f=>!fs.existsSync(path.join(vst3,f)));
if(missing.length){console.log('SKIP native smoke: missing plug-ins in',vst3,'-',missing.join(', '));process.exit(0);}
const child=spawn(exe,[],{stdio:['pipe','pipe','pipe','pipe']});let id=0;const requests=new Map();let ready;
const started=new Promise(r=>ready=r);child.stderr.pipe(process.stderr);child.stdio[3].resume();
readline.createInterface({input:child.stdout}).on('line',line=>{let m;try{m=JSON.parse(line);}catch{return;}if(m.event==='ready')ready();const r=requests.get(m.id);if(r){requests.delete(m.id);m.ok?r.resolve(m.data):r.reject(Error(m.error));}});
function rpc(c){return new Promise((resolve,reject)=>{const n=++id;requests.set(n,{resolve,reject});child.stdin.write(JSON.stringify({...c,id:n})+'\n');});}
child.on('exit',code=>{if(code){console.error('Engine exit',code);process.exitCode=1;}});
const timeout=setTimeout(()=>{console.error('Native smoke timed out');child.kill('SIGKILL');process.exitCode=1;},90000);
(async()=>{try{
 await started;
 const devices=await rpc({op:'devices'});console.log('Device backends:',devices.types.map(t=>t.name).join(', '));
 const files=[['instrument','Pianoteq 9.vst3'],['mic0','uaudio_api_vision_channel_strip.vst3'],['aux10','uaudio_pure_plate.vst3'],['master0','uaudio_api_2500.vst3']];
 for(const [slot,file]of files){const s=await rpc({op:'load',slot,path:path.join(vst3,file)});assert.ok(s.plugins[slot]);console.log('Loaded',slot,s.plugins[slot].name);}
 const rendered=await rpc({op:'renderTest'});assert.ok(rendered.peak>0.00001,'Pianoteq must render audible signal');console.log('Offline render',rendered);
 await rpc({op:'pan',strip:'master',value:-1});const left=await rpc({op:'renderTest'});assert.ok(left.leftPeak>0.001);assert.ok(left.rightPeak<0.000001,'Hard left pan must silence right');await rpc({op:'pan',strip:'master',value:0});
 await rpc({op:'mute',strip:'master',value:true});const muted=await rpc({op:'renderTest'});assert.equal(muted.peak,0,'Master mute must silence stream');await rpc({op:'mute',strip:'master',value:false});
 await rpc({op:'mute',strip:'piano',value:true});await rpc({op:'gain',strip:'micSend1',value:.5});const mic=await rpc({op:'renderTest',inputTone:true});assert.ok(mic.peak>0.001,'Microphone input must reach master through API');assert.ok(mic.auxPeak>0.00001,'Aux send must reach plate return');
 await rpc({op:'gain',strip:'micSend1',value:0});await rpc({op:'mute',strip:'piano',value:false});
 await rpc({op:'load',slot:'aux10',path:''});await rpc({op:'solo',strip:'mic',value:true});const solo=await rpc({op:'renderTest'});assert.ok(solo.peak<.000001,'Mic solo must exclude piano');await rpc({op:'solo',strip:'mic',value:false});await rpc({op:'load',slot:'aux10',path:path.join(vst3,'uaudio_pure_plate.vst3')});
 await rpc({op:'bypass',slot:'master0',value:true});assert.equal((await rpc({op:'status'})).plugins.master0.bypass,true);await rpc({op:'bypass',slot:'master0',value:false});
 console.log('PASS microphone inserts, aux send/return, master mute, pan, solo and bypass');
 await rpc({op:'midiDevice',identifier:''});assert.equal((await rpc({op:'status'})).midi,'');
 const saved=await rpc({op:'save'});assert.equal(saved.plugins.length,4);assert.ok(saved.plugins.every(p=>p.state.length>0));
 await rpc({op:'gain',strip:'piano',value:.43});await rpc({op:'restore',session:saved});const restored=await rpc({op:'status'});assert.equal(restored.mix.piano.gain,1);assert.equal(restored.monitor,0);console.log('Session state restored, monitoring off');
 // Regression: with no (or a mono) input, loading an insert while running used to abort
 // rewiring part-way and silence the mixer until relaunch.
 await rpc({op:'load',slot:'aux10',path:''});await rpc({op:'start',input:'__none__',rate:48000,buffer:256});
 await rpc({op:'load',slot:'aux10',path:path.join(vst3,'uaudio_pure_plate.vst3')});await rpc({op:'stop'});
 const afterHotLoad=await rpc({op:'renderTest'});assert.ok(afterHotLoad.peak>0.00001,'Piano must still reach master after a hot aux load with no input');console.log('PASS hot aux load with no input keeps audio');
 await assert.rejects(rpc({op:'load',slot:'bogus',path:''}),/Unknown insert/);console.log('PASS native hosting, render, save/restore and invalid slot');
 }catch(e){console.error(e);process.exitCode=1;}finally{clearTimeout(timeout);child.stdin.end();setTimeout(()=>child.kill(),1000).unref();}})();
