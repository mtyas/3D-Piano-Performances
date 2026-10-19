const {contextBridge,ipcRenderer}=require('electron');
const listen=(name,fn)=>{const handler=(_e,data)=>fn(data);ipcRenderer.on(name,handler);return()=>ipcRenderer.removeListener(name,handler);};
contextBridge.exposeInMainWorld('studio',Object.freeze({
 command:c=>ipcRenderer.invoke('engine',c), plugins:()=>ipcRenderer.invoke('plugins'),
 tab:t=>ipcRenderer.invoke('tab',t), connect:url=>ipcRenderer.invoke('connect',url),
 save:()=>ipcRenderer.invoke('save'), restore:optional=>ipcRenderer.invoke('restore',optional),
 settings:()=>ipcRenderer.invoke('settings'),
 onStatus:fn=>listen('engine-status',fn),onError:fn=>listen('engine-error',fn),onLive:fn=>listen('live-state',fn)
}));
