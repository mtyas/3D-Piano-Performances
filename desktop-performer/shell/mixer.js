'use strict';
const $=id=>document.getElementById(id);let plugins=[],status={mix:{},plugins:{}},live=false,busy=false;
const names={piano:'Piano',mic:'Microphone',aux1:'Aux 1',aux2:'Aux 2',master:'Master'};
const db=g=>g>0?(20*Math.log10(g)).toFixed(1):'−∞';
function notice(message,error=false){$('notice').textContent=message;$('notice').classList.toggle('error',error);}
async function action(fn,message){try{const result=await fn();if(message)notice(message);return result;}catch(e){notice(e.message,true);return null;}}
async function command(c){return window.studio.command(c);}
function disableControls(){document.querySelectorAll('[id^="slot-"]').forEach(el=>el.disabled=busy||live);for(const id of ['start','stop','device-type','input-device','output-device','sample-rate','buffer','mic-channel','midi-input','restore','save','connect'])if($(id))$(id).disabled=busy||live;}
function renderStatus(s){status=s;const running=!!s.running;if(!s.monitor)$('monitor-enable').checked=false;$('engine-badge').classList.toggle('running',running);$('engine-badge').lastChild.textContent=running?(live?' Live · audio running':' Audio running'):' Engine stopped';$('engine-format').textContent=running?`${s.type?s.type+' · ':''}${Math.round(s.rate/1000*10)/10} kHz · ${s.buffer} samples`:(s.deviceConfig?.type||'Audio driver');$('engine-health').textContent=running?`${s.output} · ${s.latency||0} samples plug-in latency · ${s.dropped||0} transport overruns`:'Audio is stopped.';
 updateConsole(s);
 if(!busy)for(const select of document.querySelectorAll('[id^="slot-"]'))if(document.activeElement!==select)select.value=s.plugins?.[select.id.slice(5)]?.path||'';
}
// Prefer the low-latency driver for each platform: CoreAudio on macOS, ASIO on Windows, ALSA on Linux (JACK when a JACK/PipeWire server is running).
let deviceTypes=[];
function fillDevices(){const type=deviceTypes.find(t=>t.name===$('device-type').value)||deviceTypes[0];for(const [id,values]of [['input-device',type?.inputs||[]],['output-device',type?.outputs||[]]]){const old=$(id).value;$(id).replaceChildren(new Option('System default',''),...(id==='input-device'?[new Option('No input (piano only)','__none__')]:[]),...values.map(s=>new Option(s,s)));$(id).value=old;}}
async function refresh(){const data=await command({op:'devices'});deviceTypes=data.types;const old=$('device-type').value;$('device-type').replaceChildren(...data.types.map(t=>new Option(t.name,t.name)));const preferred=['CoreAudio','ASIO','Windows Audio (Low Latency Mode)','Windows Audio','ALSA','JACK'].find(n=>data.types.some(t=>t.name===n));$('device-type').value=data.types.some(t=>t.name===old)?old:(preferred||data.types[0]?.name||'');fillDevices();$('midi-input').replaceChildren(new Option('All connected inputs',''),...data.midi.map(d=>new Option(d.name,d.id)));}
$('device-type').onchange=fillDevices;
$('start').onclick=()=>action(()=>command({op:'start',type:$('device-type').value,input:$('input-device').value,output:$('output-device').value,rate:Number($('sample-rate').value),buffer:Number($('buffer').value)}),'Audio running. Enable headphone monitoring when ready.');
$('stop').onclick=()=>action(()=>command({op:'stop'}),'Audio stopped.');
$('refresh').onclick=()=>action(refresh,'Device list refreshed.');
$('panic').onclick=()=>action(()=>command({op:'panic'}),'All notes off.');
$('save').onclick=()=>action(async()=>{await window.studio.save();$('session-status').textContent='Saved '+new Date().toLocaleTimeString();},'Session saved, including plug-in states.');
async function restoreSession(optional=false){busy=true;disableControls();try{const s=await window.studio.restore(optional);if(!s)return false;busy=false;renderStatus(s);$('monitor-enable').checked=false;$('midi-input').value=s.midi||'';$('mic-channel').value=String(s.micInput||0);const d=s.deviceConfig||{};if(d.type&&deviceTypes.some(t=>t.name===d.type)){$('device-type').value=d.type;fillDevices();}for(const [id,key]of [['input-device','input'],['output-device','output'],['sample-rate','rate'],['buffer','buffer']])if(d[key]!==undefined)$(id).value=d[key];$('session-status').textContent='Restored · saves on quit';return true;}finally{busy=false;disableControls();}}
$('restore').onclick=()=>action(()=>restoreSession(),'Session restored. Start audio when ready; monitoring is off.');
function monitor(){action(()=>command({op:'monitor',value:$('monitor-enable').checked?Number($('monitor-level').value)/100:0}));}
$('monitor-enable').onchange=monitor;$('monitor-level').oninput=monitor;
$('connect').onclick=()=>action(()=>window.studio.connect($('stage-url').value),'Stage connected. Open Performer to sign in.');
for(const tab of ['performer','mixer'])$(tab+'-tab').onclick=()=>{window.studio.tab(tab);$('performer-tab').classList.toggle('selected',tab==='performer');$('mixer-tab').classList.toggle('selected',tab==='mixer');$('mixer').style.visibility=tab==='mixer'?'visible':'hidden';};
window.studio.onStatus(renderStatus);window.studio.onError(e=>notice(e,true));window.studio.onLive(value=>{live=value;disableControls();notice(live?'Live show running. Device and plug-in changes are locked until the show stops.':'Show stopped. Mixer routing is available.');});
(async()=>{plugins=await window.studio.plugins();for(const key of Object.keys(names))makeStrip(key);$('stage-url').value=(await window.studio.settings()).url;for(let attempt=0;attempt<30;attempt++){try{await refresh();break;}catch{await new Promise(r=>setTimeout(r,300));}}await action(async()=>{notice('Restoring mixer and plug-ins…');const restored=await restoreSession(true);notice(restored?'Mixer and plug-ins restored. Start audio when ready.':'Choose your devices and load Pianoteq. Your setup saves when you quit.');});})();
