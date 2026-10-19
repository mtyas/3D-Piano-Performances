// Appended to the bundled performer ES module: references its existing synth,
// MIDI dispatch and recorder directly without exposing them to remote frames.
let nativePCMNode=null,nativeAudioPromise=null,nativeHardwareDispatch=false;
async function prepareNativeAudio(){
 const status=await window.nativeStudio.status();
 if(!status.running)throw Error('Start the audio engine in the Mixer tab before starting a show.');
 if(nativeAudioPromise){await nativeAudioPromise;await synth.ctx.resume();return;}
 nativeAudioPromise=(async()=>{
  synth.ensureContext();await synth.ctx.resume();
  await synth.ctx.audioWorklet.addModule('./desktop-pcm.js');
  nativePCMNode=new AudioWorkletNode(synth.ctx,'native-pcm',{numberOfInputs:0,numberOfOutputs:1,outputChannelCount:[2]});
  nativePCMNode.connect(synth.recordDest);
  window.nativeStudio.onAudio(frame=>{
   const bytes=frame.pcm;const copy=new Uint8Array(bytes).buffer;
   nativePCMNode.port.postMessage({samples:new Float32Array(copy),rate:frame.rate,sequence:frame.sequence},[copy]);
  });
  window.nativeStudio.audioReady();
 })().catch(error=>{nativeAudioPromise=null;throw error;});
 return nativeAudioPromise;
}
if(window.nativeStudio){
 // Hardware MIDI has already reached Pianoteq in the native callback. These
 // events update the avatar/archive only; screen keys still play the instrument.
 synth.noteOn=(note,velocity=0.8)=>{if(!nativeHardwareDispatch){synth.voices.set(note,{});window.nativeStudio.midi([0x90,note,Math.round(velocity*127)]);}};
 synth.noteOff=note=>{if(!nativeHardwareDispatch){synth.voices.delete(note);window.nativeStudio.midi([0x80,note,0]);}};
 window.nativeStudio.onMidi(messages=>{
  if(STATE.viewMode!=='performer')return;
  nativeHardwareDispatch=true;
  try{for(const bytes of messages)handleHardwareMIDIMessage({data:bytes},'Native MIDI');}finally{nativeHardwareDispatch=false;}
 });
 // Audio is exclusively supplied by the native mixer. Browser capture would
 // create an extra input and bypass the channel strip.
 const micButton=document.getElementById('btn-mic-stream');
 if(micButton){micButton.disabled=true;micButton.textContent='Audio from Mixer';}
 const audioSelect=document.getElementById('audio-input-select');if(audioSelect)audioSelect.disabled=true;
 const synthToggle=document.getElementById('btn-synth-toggle');if(synthToggle)synthToggle.hidden=true;
 window.nativeStudio.onStatus(status=>{
  if(status.running&&!nativeAudioPromise)prepareNativeAudio().catch(error=>console.warn(error));
  if(!status.running&&nativePCMNode)nativePCMNode.port.postMessage({reset:true});
  if(!status.running&&STATE.recordingShow){document.getElementById('rec-status-line').textContent='Audio engine stopped — stopping the show.';toggleRecordShow();}
 });
 window.nativeStudio.onError(message=>{const el=document.getElementById('rec-status-line');if(el)el.textContent=message;});
}

export async function nativeRecordingStream(){await prepareNativeAudio();return synth.getRecordingStream();}

// Remember camera choices, but require an explicit tracking start on each launch.
const cameraPreferenceKey='native-performer-cameras-v1';
let cameraPreferences={};try{cameraPreferences=JSON.parse(localStorage.getItem(cameraPreferenceKey)||'{}');}catch{}
for(const id of ['webcam-front-select','webcam-side-select']){
 const select=document.getElementById(id);if(!select)continue;
 const restore=()=>{if(Object.prototype.hasOwnProperty.call(cameraPreferences,id)&&[...select.options].some(option=>option.value===cameraPreferences[id]))select.value=cameraPreferences[id];};
 new MutationObserver(restore).observe(select,{childList:true});restore();
 select.addEventListener('change',()=>{cameraPreferences[id]=select.value;try{localStorage.setItem(cameraPreferenceKey,JSON.stringify(cameraPreferences));}catch{}});
}
