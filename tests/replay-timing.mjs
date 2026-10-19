import assert from 'node:assert/strict';
import { advanceReplayClock,interpolatePose } from '../replay-timing.js';
const broken={paused:false,ended:false,readyState:4,currentTime:0};
const clock={time:0,lastNow:0};
for(let t=20;t<=10000;t+=20)advanceReplayClock(clock,t,broken);
assert.ok(clock.time>9900&&clock.time<=10000,'zero media timestamps must not freeze the event timeline');
assert.equal(clock.fallback,true);
const time=clock.time;broken.paused=true;advanceReplayClock(clock,11000,broken);assert.equal(clock.time,time,'pause must stop animation');
broken.paused=false;clock.waiting=true;advanceReplayClock(clock,12000,broken);assert.equal(clock.time,time,'network buffering must stop animation');
clock.waiting=false;advanceReplayClock(clock,12020,broken);assert.equal(clock.time,time+20,'resume must not catch up the pause');
const good={time:0,lastNow:0};
for(let t=20;t<=10000;t+=20)advanceReplayClock(good,t,{...broken,currentTime:t/1000});
assert.ok(Math.abs(good.time-10000)<1,'healthy media clock stays synchronized');
const midpoint=interpolatePose({t:0,pose:{sway:0,armLConfidence:1}},{t:100,pose:{sway:20,armLConfidence:1}},50);
assert.equal(midpoint.sway,10);assert.equal(midpoint.armLConfidence,1);
assert.equal(interpolatePose({t:0,pose:{armLConfidence:1}},null,1000).armLConfidence,0,'occluded arms must release tracking');
console.log('Replay timing: stalled clock, valid clock, pause, buffering, resume, interpolation and stale tracking passed');

assert.equal(interpolatePose({t:0,pose:{eyeTracking:1,eyeBlinkLeft:1}},null,1000).eyeTracking,0,'lost face releases closed eyelids');
assert.equal(interpolatePose({t:0,pose:{eyeTracking:1,eyeBlinkLeft:0}},{t:100,pose:{eyeTracking:1,eyeBlinkLeft:1}},50).eyeBlinkLeft,.5);
const frames=[{t:0,pose:{pitch:0}},{t:70,pose:{pitch:18}},{t:190,pose:{pitch:20}},{t:260,pose:{pitch:-10}}];
for(let t=70;t<=190;t++) {
 const value=interpolatePose(frames[1],frames[2],t,frames[0],frames[3]).pitch;
 assert.ok(value>=18&&value<=20,'cubic must not overshoot measured head range');
}
const at=t=>interpolatePose(frames[1],frames[2],t,frames[0],frames[3]).pitch;
assert.ok(Math.abs(at(190)-at(189.99))<.00001,'velocity eases to zero at a change of direction');
assert.equal(interpolatePose({t:0,pose:{pitch:5}},{t:1000,pose:{pitch:40}},600).pitch,5,'do not invent motion across tracking gaps');
console.log('Irregular pose timing, extrema and tracking gaps passed');
