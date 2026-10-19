import * as THREE from 'three';

const tip = new THREE.Vector3();
const target = new THREE.Vector3();
const axis = new THREE.Vector3(1, 0, 0);
const rotation = new THREE.Quaternion();
const saved = new THREE.Quaternion();
const derivativeTip = new THREE.Vector3();
const wristPosition = new THREE.Vector3();
const wristTarget = new THREE.Vector3();
const jointPosition = new THREE.Vector3();
const currentDirection = new THREE.Vector3();
const desiredDirection = new THREE.Vector3();
const worldDelta = new THREE.Quaternion();
const parentRotation = new THREE.Quaternion();
const localDelta = new THREE.Quaternion();
const palmRotation = new THREE.Quaternion();
const depthPoint = new THREE.Vector3();
const errorVector=new THREE.Vector3();
const gradient=new THREE.Vector3();

function lowerArmCarriage(side, bones, gap, depthShift, lateralShift = 0) {
  const hand = bones[`${side}Hand`];
  if (!hand) return;
  hand.updateWorldMatrix(true, false);
  hand.getWorldPosition(wristTarget);
  wristTarget.y -= THREE.MathUtils.clamp(gap, -.08, .08);
  wristTarget.x += THREE.MathUtils.clamp(lateralShift, -.08, .08);
  wristTarget.z += THREE.MathUtils.clamp(depthShift, -.08, .08);
  hand.getWorldQuaternion(palmRotation);
  for (let iteration = 0; iteration < 12; iteration++) {
    for (const part of ['LowerArm', 'UpperArm']) {
      const joint = bones[`${side}${part}`];
      if (!joint?.parent) continue;
      joint.updateWorldMatrix(true, false);
      hand.updateWorldMatrix(true, false);
      joint.getWorldPosition(jointPosition);
      hand.getWorldPosition(wristPosition);
      currentDirection.subVectors(wristPosition, jointPosition).normalize();
      desiredDirection.subVectors(wristTarget, jointPosition).normalize();
      worldDelta.setFromUnitVectors(currentDirection, desiredDirection);
      joint.parent.getWorldQuaternion(parentRotation);
      localDelta.copy(parentRotation).invert().multiply(worldDelta).multiply(parentRotation);
      joint.quaternion.premultiply(localDelta);
    }
    hand.updateWorldMatrix(true, false);
    hand.getWorldPosition(wristPosition);
    if (wristPosition.distanceTo(wristTarget) < 0.0003) break;
  }
  hand.parent.getWorldQuaternion(parentRotation);
  hand.quaternion.copy(parentRotation).invert().multiply(palmRotation);
  hand.updateWorldMatrix(true, true);
}


// Correct playing fingers against the animated key surface, without moving wrist joints.
// Existing calibrations without fingertipContact retain their original behavior.
export function enforceFingertipContact({ bones, hands, keys, calibration }) {
  const config = calibration?.fingertipContact;
  if (!config) return;
  for (const side of ['left', 'right']) {
    const hand = hands[side];
    const corrections = new Map(); // Shared across both passes; bounded per frame.
    for (let pass = 0; pass < 3; pass++) {
    for (const [finger, midi] of Object.entries(hand.fingerKeys || {})) {
      const distal = bones[`${side}${finger}Distal`];
      const key = keys[midi];
      const localTip = config.tips[`${side}${finger}`];
      if (!distal || !key || !localTip || (hand.fingerPress[finger] || 0) <= 0) continue;
      key.updateWorldMatrix(true, false);
      key.geometry.computeBoundingBox();
      const box = key.geometry.boundingBox;
      const joints = finger === 'Thumb'
        ? ['Proximal', 'Metacarpal', 'Distal']
        : ['Proximal', 'Intermediate', 'Distal'];

      for (let iteration = 0; iteration < 36; iteration++) {
        axis.set(iteration%2===0?1:0,0,iteration%2===0?0:1);
        distal.updateWorldMatrix(true, false);
        tip.fromArray(localTip).applyMatrix4(distal.matrixWorld);
        target.copy(tip);
        key.worldToLocal(target);
        target.x = THREE.MathUtils.clamp(target.x, box.min.x, box.max.x);
        target.z = THREE.MathUtils.clamp(target.z, box.min.z, box.max.z);
        target.y = box.max.y;
        key.localToWorld(target);
        target.y += config.padRadius;
        errorVector.subVectors(target,tip);
        if (errorVector.length() < 0.0006) break;
        let improved = false;
        for (const part of joints) {
          const joint = bones[`${side}${finger}${part}`];
          if (!joint) continue;
          // Interphalangeal joints hinge; lateral spread belongs at the knuckle.
          if (iteration % 2 === 1 && part !== (finger === 'Thumb' ? 'Metacarpal' : 'Proximal')) continue;
          saved.copy(joint.quaternion);
          rotation.setFromAxisAngle(axis, 0.012);
          joint.quaternion.multiply(rotation);
          distal.updateWorldMatrix(true, false);
          derivativeTip.fromArray(localTip).applyMatrix4(distal.matrixWorld);
          gradient.subVectors(derivativeTip,tip).divideScalar(.012);
          const derivative = gradient.lengthSq();
          joint.quaternion.copy(saved);
          if (derivative < .000004) continue;
          const correctionKey=finger+part+iteration%2;
          const used = corrections.get(correctionKey)||0;
          const limit = iteration % 2 === 1 ? .22 : .55;
          const bounded = THREE.MathUtils.clamp(
            used + THREE.MathUtils.clamp(errorVector.dot(gradient) / derivative, -0.16, 0.16),
            -Math.min(config.maxCorrectionRadians, limit), Math.min(config.maxCorrectionRadians, limit)
          );
          const delta = bounded - used;
          if (Math.abs(delta) < 0.00001) continue;
          rotation.setFromAxisAngle(axis, delta);
          joint.quaternion.multiply(rotation);
          corrections.set(correctionKey, bounded);
          distal.updateWorldMatrix(true, false);
          tip.fromArray(localTip).applyMatrix4(distal.matrixWorld);
          improved = true;
          break;
        }
        if (!improved) break;
      }
    }
    if (pass < 2) {
      let maxGap = -Infinity, minGap = Infinity;
      let minLateralShift = -Infinity, maxLateralShift = Infinity;
      let minDepthShift = -Infinity;
      let maxDepthShift = Infinity;
      for (const [finger, midi] of Object.entries(hand.fingerKeys || {})) {
        const distal = bones[`${side}${finger}Distal`];
        const key = keys[midi];
        const localTip = config.tips[`${side}${finger}`];
        if (!distal || !key || !localTip) continue;
        distal.updateWorldMatrix(true, false);
        tip.fromArray(localTip).applyMatrix4(distal.matrixWorld);
        target.copy(tip);
        key.worldToLocal(target);
        const box = key.geometry.boundingBox;
        depthPoint.copy(target);depthPoint.x=box.min.x+config.padRadius;key.localToWorld(depthPoint);
        minLateralShift=Math.max(minLateralShift,depthPoint.x-tip.x);
        depthPoint.copy(target);depthPoint.x=box.max.x-config.padRadius;key.localToWorld(depthPoint);
        maxLateralShift=Math.min(maxLateralShift,depthPoint.x-tip.x);
        target.x = THREE.MathUtils.clamp(target.x, box.min.x, box.max.x);
        target.z = THREE.MathUtils.clamp(target.z, box.min.z, box.max.z);
        target.y = box.max.y;
        depthPoint.copy(target); depthPoint.z = box.min.z + config.padRadius * 1.5;
        key.localToWorld(depthPoint);
        minDepthShift = Math.max(minDepthShift, depthPoint.z - tip.z);
        depthPoint.copy(target); depthPoint.z = box.max.z - config.padRadius * 1.5;
        key.localToWorld(depthPoint);
        maxDepthShift = Math.min(maxDepthShift, depthPoint.z - tip.z);
        key.localToWorld(target);
        const gap=tip.y-config.padRadius-target.y;
        maxGap = Math.max(maxGap, gap);minGap = Math.min(minGap, gap);
      }
      if (!Number.isFinite(maxGap)) continue;
      maxGap=(maxGap+minGap)*.5;
      const lateralShift=minLateralShift<=maxLateralShift?THREE.MathUtils.clamp(0,minLateralShift,maxLateralShift):(minLateralShift+maxLateralShift)*.5;
      const depthShift = minDepthShift <= maxDepthShift
        ? THREE.MathUtils.clamp(0, minDepthShift, maxDepthShift)
        : (minDepthShift + maxDepthShift) * 0.5;
      if (Math.abs(maxGap) > 0.0006 || Math.abs(depthShift) > 0.0006 || Math.abs(lateralShift) > .0006) lowerArmCarriage(side, bones, maxGap, depthShift, lateralShift);
    }
    }
  }
}
