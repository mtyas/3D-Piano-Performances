// A broken MediaRecorder clock must not pin MIDI and pose playback to zero.
export function advanceReplayClock(clock, now, audio) {
  const delta=clock.lastNow===undefined?0:Math.max(0,now-clock.lastNow);clock.lastNow=now;
  if(audio && (audio.paused || audio.readyState<2 || audio.seeking || clock.waiting)) return clock.time;
  const predicted=clock.time+delta;
  if(!audio) return clock.time=predicted;
  const media=audio.currentTime*1000;
  const advances=Number.isFinite(media)&&media>(clock.lastMedia??-1)+.5;
  if(advances){clock.lastAdvance=now;clock.lastMedia=media;}
  clock.lastAdvance??=now;
  // Once malformed timestamps are detected, stay on the continuous clock for this playback.
  if(now-clock.lastAdvance>400 || media<clock.time-500) clock.fallback=true;
  if(!clock.fallback && advances && Math.abs(media-predicted)<500) clock.time=predicted+(media-predicted)*.15;
  else clock.time=predicted;
  return clock.time;
}
export function interpolatePose(a,b,time,before,after) {
  if(!a) return {};
  const span=b?b.t-a.t:0;
  const alpha=span>0&&span<500?Math.max(0,Math.min(1,(time-a.t)/span)):0;
  const out={...a.pose};
  for(const [key,value] of Object.entries(out)) if(Number.isFinite(b?.pose[key])) {
    const next=b.pose[key], slope=span>0?(next-value)/span:0;
    // Monotone cubic interpolation: continuous velocity without overshooting
    // measured poses, including irregular webcam frame intervals.
    const tangent=(frame, left)=>{
      if(!frame || !Number.isFinite(frame.pose[key])) return slope;
      const duration=left?a.t-frame.t:frame.t-b.t;
      if(duration<=0 || duration>=500) return slope;
      const other=left?(value-frame.pose[key])/duration:(frame.pose[key]-next)/duration;
      if(other*slope<=0) return 0;
      return Math.sign(slope)*Math.min(Math.abs((other+slope)/2),3*Math.abs(slope),3*Math.abs(other));
    };
    const u=alpha, u2=u*u, u3=u2*u;
    out[key]=(2*u3-3*u2+1)*value+(u3-2*u2+u)*span*tangent(before,true)
      +(-2*u3+3*u2)*next+(u3-u2)*span*tangent(after,false);
  }
  const stale=Math.max(0,Math.min(1,1-(time-a.t-250)/500));
  for(const k of ['armLConfidence','armRConfidence','eyeTracking'])out[k]=(out[k]||0)*stale;
  return out;
}
