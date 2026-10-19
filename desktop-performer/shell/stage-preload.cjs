const {contextBridge,ipcRenderer}=require('electron');
const listen=(name,fn)=>{const handler=(_e,data)=>fn(data);ipcRenderer.on(name,handler);return()=>ipcRenderer.removeListener(name,handler);};
contextBridge.exposeInMainWorld('nativeStudio',Object.freeze({
 midi:bytes=>ipcRenderer.send('stage-midi',bytes),
 live:value=>ipcRenderer.send('stage-live',!!value),
 status:()=>ipcRenderer.invoke('stage-status'),
 audioReady:()=>ipcRenderer.send('audio-ready'),
 onAudio:fn=>listen('native-audio',data=>{fn(data);ipcRenderer.send('audio-ack');}),
 onMidi:fn=>listen('native-midi',fn),onStatus:fn=>listen('engine-status',fn),onError:fn=>listen('engine-error',fn)
}));
