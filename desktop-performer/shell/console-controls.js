// Shared by the renderer; controls operate on the native graph.
const toGain = value => Number(value) <= -60 ? 0 : 10 ** (Number(value) / 20);
function pluginSelect(slot) {
 const box=document.createElement('div');box.className='insert';
 const row=document.createElement('div');row.className='insert-row';
 const bypass=document.createElement('button');bypass.className='bypass';bypass.id='bypass-'+slot;bypass.textContent='\u25cf';bypass.title='Bypass insert';bypass.setAttribute('aria-label',slot+' bypass');
 bypass.onclick=()=>action(()=>command({op:'bypass',slot,value:!status.plugins?.[slot]?.bypass}));
 const select=document.createElement('select');select.id='slot-'+slot;select.setAttribute('aria-label',slot+' plug-in');select.add(new Option(slot==='instrument'?'Load instrument...':`Insert ${Number(slot.at(-1))+1} - empty`,''));
 for(const p of plugins)select.add(new Option(p.name,p.path));
 const edit=document.createElement('button');edit.textContent='\u2197';edit.title='Open plug-in editor';edit.setAttribute('aria-label',slot+' editor');edit.onclick=()=>action(()=>command({op:'editor',slot}));
 select.onchange=async()=>{busy=true;notice('Loading plug-in... Its authorization window may open.');disableControls();const result=await action(()=>command({op:'load',slot,path:select.value}),'Plug-in loaded. Set aux effects to 100% wet.');busy=false;if(result)renderStatus(result);else select.value=status.plugins?.[slot]?.path||'';disableControls();};
 row.append(bypass,select,edit);box.append(row);return box;
}
function makeStrip(key) {
 const strip=document.createElement('article');strip.className='strip '+(key.startsWith('aux')?'aux':key);
 const number={piano:'01',mic:'02',aux1:'A1',aux2:'A2',master:'LR'}[key];
 strip.innerHTML=`<div class="strip-top"><span class="channel-number">${number}</span><h2>${names[key]}</h2><span class="channel-type">${key==='mic'?'MONO':'ST'}</span></div><div class="strip-body"><div class="source" id="source-${key}"></div><div class="section-label">INSERTS</div><div id="inserts-${key}"></div><div class="send-bank" id="sends-${key}"></div><div class="pan-section"><label>${key==='mic'?'PAN':'BALANCE'}</label><div class="pan-row"><span>L</span><input type="range" min="-100" max="100" value="0" id="pan-${key}" aria-label="${names[key]} pan"><span>R</span></div><output id="pan-value-${key}">C</output></div><div class="channel-buttons"><button class="mute" id="mute-${key}">M</button>${['piano','mic'].includes(key)?`<button class="solo" id="solo-${key}">S</button>`:'<span class="bus-label">STEREO BUS</span>'}</div><div class="fader-section"><div class="fader-lane"><div class="fader-scale"><span>+6</span><span>0</span><span>-6</span><span>-12</span><span>-24</span><span>-36</span><span>-&#8734;</span></div><input class="channel-fader" type="range" min="-60" max="6" step="0.1" value="0" id="gain-${key}" aria-label="${names[key]} level"></div><div class="stereo-meter"><div class="meter"><div class="meter-fill" id="meterL-${key}"></div></div><div class="meter"><div class="meter-fill" id="meterR-${key}"></div></div><div class="meter-scale"><span>0</span><span>-12</span><span>-24</span><span>-36</span><span>-60</span></div></div></div><div class="fader-value"><span id="db-${key}">0.0</span><small>dB</small></div><div class="scribble">${names[key]}</div></div>`;
 $('channels').append(strip);const source=$('source-'+key);
 if(key==='piano'){source.innerHTML='<label>MIDI INPUT<select id="midi-input"><option value="">All connected inputs</option></select></label>';source.append(pluginSelect('instrument'));$('midi-input').onchange=e=>action(()=>command({op:'midiDevice',identifier:e.target.value}));}
 else if(key==='mic'){source.innerHTML='<label>AUDIO INPUT<select id="mic-channel"><option value="0">Input 1 - mono</option><option value="1">Input 2 - mono</option></select></label><div class="routing-label">MONO INPUT / STEREO STRIP</div>';$('mic-channel').onchange=e=>action(()=>command({op:'input',value:Number(e.target.value)}));}
 else source.innerHTML=`<label>${key==='master'?'MIX BUS':'AUX RETURN'}</label><div class="routing-label">${key==='master'?'CHANNELS + AUX RETURNS':'POST-FADER SENDS'}</div><div class="routing-detail">${key==='master'?'To stream & headphones':'Stereo effect return'}</div>`;
 for(let i=0;i<2;i++)$('inserts-'+key).append(pluginSelect(key+i));
 $('gain-'+key).oninput=e=>{const gain=toGain(e.target.value);$('db-'+key).textContent=db(gain);action(()=>command({op:'gain',strip:key,value:gain}));};
 $('gain-'+key).ondblclick=()=>action(()=>command({op:'gain',strip:key,value:1}));
 $('mute-'+key).title='Mute '+names[key];$('mute-'+key).onclick=()=>action(()=>command({op:'mute',strip:key,value:!status.mix?.[key]?.mute}));
 if($('solo-'+key)){$('solo-'+key).title='Solo '+names[key];$('solo-'+key).onclick=()=>action(()=>command({op:'solo',strip:key,value:!status.mix?.[key]?.solo}));}
 $('pan-'+key).oninput=e=>action(()=>command({op:'pan',strip:key,value:Number(e.target.value)/100}));$('pan-'+key).ondblclick=()=>action(()=>command({op:'pan',strip:key,value:0}));
 const sends=$('sends-'+key);
 if(['piano','mic'].includes(key)){sends.innerHTML='<div class="section-label">AUX SENDS / POST</div><div class="send-knobs"></div>';for(let i=1;i<=2;i++){const id=key+'Send'+i;const row=document.createElement('div');row.className='send';row.innerHTML=`<label>AUX ${i}</label><div class="dial" id="dial-${id}"><span></span></div><input type="range" min="-60" max="0" value="-60" step="0.5" id="gain-${id}" aria-label="${names[key]} send to aux ${i}"><output id="db-${id}">-&#8734;</output>`;sends.lastChild.append(row);$('gain-'+id).oninput=e=>action(()=>command({op:'gain',strip:id,value:toGain(e.target.value)}));}}
 else sends.innerHTML=`<div class="section-label">${key==='master'?'OUTPUT':'EFFECT MIX'}</div><div class="bus-symbol">${key==='master'?'L + R':'100%'}<small>${key==='master'?'STEREO MASTER':'WET IN PLUG-IN'}</small></div>`;
}
function updateConsole(s) {
 for(const [key,value]of Object.entries(s.mix||{})){
  if($('db-'+key))$('db-'+key).textContent=db(value.gain);
  const fader=$('gain-'+key);if(fader&&document.activeElement!==fader)fader.value=value.gain>0?20*Math.log10(value.gain):-60;
  if($('dial-'+key))$('dial-'+key).style.setProperty('--angle',(-135+(Math.max(-60,Number(fader.value))+60)/60*270)+'deg');
  const mute=$('mute-'+key);if(mute){mute.classList.toggle('active',value.mute);mute.setAttribute('aria-pressed',!!value.mute);}
  const solo=$('solo-'+key);if(solo){solo.classList.toggle('active',value.solo);solo.setAttribute('aria-pressed',!!value.solo);}
  const pan=$('pan-'+key);if(pan&&document.activeElement!==pan)pan.value=(value.pan||0)*100;
  if($('pan-value-'+key))$('pan-value-'+key).textContent=Math.abs(value.pan||0)<.01?'C':Math.round(Math.abs(value.pan)*100)+(value.pan<0?' L':' R');
  for(const side of ['L','R']){const meter=$('meter'+side+'-'+key),peak=value['peak'+side]||0;if(meter){meter.style.height=Math.max(0,Math.min(100,(20*Math.log10(Math.max(.00001,peak))+60)/60*100))+'%';meter.classList.toggle('clip',peak>=1);}}
 }
 for(const button of document.querySelectorAll('.bypass')){const p=s.plugins?.[button.id.slice(7)];button.classList.toggle('enabled',!!p&&!p.bypass);button.setAttribute('aria-pressed',!!p?.bypass);}
}
