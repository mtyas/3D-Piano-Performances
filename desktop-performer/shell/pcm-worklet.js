// A bounded stereo queue with linear sample-rate conversion. Hardware monitoring
// never passes through this queue; it feeds only the existing WebM recorder.
class NativePCM extends AudioWorkletProcessor {
 constructor(){
  super();this.size=32768;this.left=new Float32Array(this.size);this.right=new Float32Array(this.size);
  this.write=0;this.read=0;this.ratio=1;this.started=false;this.lastSequence=null;this.underruns=0;this.overruns=0;
  this.port.onmessage=({data})=>{
   if(data.reset){this.read=this.write=0;this.started=false;return;}
   const samples=data.samples;if(!(samples instanceof Float32Array))return;
   const frames=samples.length/2;this.ratio=data.rate/sampleRate;
   // Discard stale backlog after stalls; never replay old audio minutes later.
   if(this.write-this.read+frames>this.size-2){this.read=this.write;this.started=false;this.overruns++;}
   for(let i=0;i<frames;i++){const index=(this.write+i)%this.size;this.left[index]=samples[i*2];this.right[index]=samples[i*2+1];}
   this.write+=frames;this.lastSequence=data.sequence;
  };
 }
 process(_inputs,outputs){
  const [l,r]=outputs[0];if(!l||!r)return true;
  if(!this.started){if(this.write-this.read<2048)return true;this.started=true;}
  for(let i=0;i<l.length;i++){
   if(this.read+1>=this.write){this.started=false;this.underruns++;break;}
   const base=Math.floor(this.read),f=this.read-base,a=base%this.size,b=(base+1)%this.size;
   l[i]=this.left[a]+f*(this.left[b]-this.left[a]);r[i]=this.right[a]+f*(this.right[b]-this.right[a]);this.read+=this.ratio;
  }
  return true;
 }
}
registerProcessor('native-pcm',NativePCM);
