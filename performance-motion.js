import * as THREE from 'three';

export const ARM_FIELDS = ['armLUpperX','armLUpperY','armLUpperZ','armLLowerX','armLLowerY','armLLowerZ','armLConfidence','armRUpperX','armRUpperY','armRUpperZ','armRLowerX','armRLowerY','armRLowerZ','armRConfidence'];
// Retain directions, not camera-space distances, so body proportions stay consistent.
export function captureArmPose(landmarks, world) {
  const pose = {};
  for (const [tag,indices] of [['L',[11,13,15]],['R',[12,14,16]]]) {
    const confidence = Math.min(...indices.map(i => landmarks[i]?.visibility ?? 0));
    pose[`arm${tag}Confidence`] = confidence > .65 ? confidence : 0;
    if (!world || confidence <= .65) continue;
    for (const [part,a,b] of [['Upper',indices[0],indices[1]],['Lower',indices[1],indices[2]]]) {
      const from=world[a],to=world[b];
      if (!from || !to) { pose[`arm${tag}Confidence`]=0; continue; }
      const v=new THREE.Vector3(to.x-from.x,from.y-to.y,from.z-to.z).normalize();
      for (const axis of ['X','Y','Z']) pose[`arm${tag}${part}${axis}`]=v[axis.toLowerCase()];
    }
  }
  return pose;
}
const origin=new THREE.Vector3(),end=new THREE.Vector3(),desired=new THREE.Vector3(),actual=new THREE.Vector3();
const delta=new THREE.Quaternion(),parent=new THREE.Quaternion(),target=new THREE.Quaternion();
function aim(bone,child,direction,weight) {
  if (!bone?.parent || !child || direction.lengthSq()<.1) return;
  bone.updateWorldMatrix(true,true);bone.getWorldPosition(origin);child.getWorldPosition(end);
  actual.subVectors(end,origin).normalize();desired.copy(direction).normalize();
  delta.setFromUnitVectors(actual,desired);bone.parent.getWorldQuaternion(parent);
  target.copy(parent).invert().multiply(delta).multiply(parent).multiply(bone.quaternion);
  bone.quaternion.slerp(target,weight);bone.updateWorldMatrix(true,true);
}
// Playing notes always win. A free hand can move with the webcam; look-ahead returns it before the next strike.
export function applyTrackedArms({bones,hands,pose,upcoming,dt,fresh}) {
  for(const [side,tag] of [['left','L'],['right','R']]) {
    const h=hands[side],playing=Object.keys(h.fingerKeys||{}).length>0;
    const lead=Math.min(Infinity,...upcoming.filter(n=>n.hand===side).map(n=>n.leadMs));
    const freedom=playing?0:THREE.MathUtils.clamp((lead-100)/650,0,1);
    const confidence=fresh?THREE.MathUtils.clamp(pose[`arm${tag}Confidence`]||0,0,1):0;
    h.gestureBlend=(h.gestureBlend||0)+(freedom*confidence-(h.gestureBlend||0))*(1-Math.exp(-dt*10));
    // Never soften the MIDI constraint while fingers are assigned.
    const weight=playing?0:Math.min(h.gestureBlend,freedom);
    for(const [part,child] of [['Upper','LowerArm'],['Lower','Hand']]) {
      desired.set(pose[`arm${tag}${part}X`]||0,pose[`arm${tag}${part}Y`]||0,pose[`arm${tag}${part}Z`]||0);
      aim(bones[`${side}${part}Arm`],bones[`${side}${child}`],desired,weight);
    }
  }
}

// Positive anatomical pitch always bends toward the piano (+Z), regardless of bone roll.
// The source rig alternates the direction of local X between adjacent spine joints.
export function forwardPitchAxis(bone) {
  return new THREE.Vector3(1,0,0).applyQuaternion(bone.getWorldQuaternion(new THREE.Quaternion()).invert());
}
const pitchDelta=new THREE.Quaternion(),lateralDelta=new THREE.Quaternion(),lateralEuler=new THREE.Euler();
export function applyAnatomicalRotation(bone,base,axis,pitchDegrees,yawDegrees=0,rollDegrees=0) {
  pitchDelta.setFromAxisAngle(axis,THREE.MathUtils.degToRad(pitchDegrees));
  lateralEuler.set(0,THREE.MathUtils.degToRad(yawDegrees),THREE.MathUtils.degToRad(rollDegrees));
  lateralDelta.setFromEuler(lateralEuler);
  bone.quaternion.fromArray(base).multiply(pitchDelta).multiply(lateralDelta);
}
