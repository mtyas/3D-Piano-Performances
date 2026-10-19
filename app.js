import * as THREE from 'three';
import { ARM_FIELDS, captureArmPose, applyTrackedArms, forwardPitchAxis, applyAnatomicalRotation } from './performance-motion.js';
import { advanceReplayClock, interpolatePose } from './replay-timing.js';

import { createStageDirection, sampleSmoothPose, PoseDamper } from './stage-direction.js';
import { enforceFingertipContact } from './fingertip-contact.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRButton } from 'three/addons/webxr/VRButton.js';

// ============================================================================
// 1. GLOBAL STATE & CONFIGURATION
// ============================================================================
const LOOKAHEAD_BUFFER_MS = 1800; // 1.8s visitor buffer for hand/arm anticipation

const STATE = {
  viewMode: 'lobby', // 'lobby' | 'visitor' | 'performer'
  role: 'visitor',   // 'visitor' | 'performer'
  cameraMode: '3q',
  ws: null,
  wsConnected: false,
  performerAuthorized: false,

  // Live stage status from server
  liveShowActive: false,
  performerOnline: false,
  currentShowTitle: 'Live Evening Recital',
  visitorsCount: 0,
  archives: [],

  // Performer recording state
  recordingShow: false,
  recordStartTime: 0,
  recordTimerInterval: null,

  // Audio state
  synthEnabled: true,
  muted: false,
  masterVolume: 0.8,
  micStreaming: false,
  demoPlaying: false,
  webcamActive: false,
  lastTrackedPoseAt: -Infinity,

  // Calibration & 3D references
  calib: null,
  bones: {},
  baseShoulderWorldQuat: { left: null, right: null },
  forwardPitchAxes: {},
  keyMeshes: {},     // midi (21..108) -> THREE.Object3D
  key2DElements: {}, // midi (21..108) -> HTMLElement
  headOnlyMeshes: [],
  blinkMeshes: [],
  blinkHold: false,
  lastEyeCaptureAt: -Infinity,
  eyeClosure: {L: 0, R: 0},
  blinkTime: -1,
  blinkCount: 0,
  nextBlink: 4.0,

  // Active MIDI notes right now: Map<midi, { velocity: 0..1, timeOn: number, hand: 'left'|'right', finger: string }>
  activeNotes: new Map(),
  sustainPedal: false,

  // Visitor 1.8s Look-Ahead Event Queue (for live buffered stream)
  // Array of { playAt: performance.now() + 1800, event: { type: 'midi'|'pose', ... } }
  liveBufferQueue: [],

  // Archive Replay State
  replay: {
    active: false,
    paused: false,
    session: null,       // Full loaded archive JSON
    playheadMs: 0,       // Current playback position in ms
    eventCursor: 0,      // Next index in session.events to trigger
    audioEl: null,       // Optional recorded .webm Audio element
  },

  // Hand IK Tracking State
  hands: {
    left: {
      currentX: 0.223,   // C3 default bass position
      targetX: 0.223,
      anchorMidi: 48,
      strikeAmt: 0,
      prepLift: 0,       // Anticipatory wrist lift before upcoming note
      blackAmt: 0,
      lastActiveTime: 0,
      fingerPress: { Thumb: 0, Index: 0, Middle: 0, Ring: 0, Little: 0 },
      fingerSpread: { Thumb: 0, Index: 0, Middle: 0, Ring: 0, Little: 0 },
    },
    right: {
      currentX: -0.035,  // G4 default treble position
      targetX: -0.035,
      anchorMidi: 67,
      strikeAmt: 0,
      prepLift: 0,
      blackAmt: 0,
      lastActiveTime: 0,
      fingerPress: { Thumb: 0, Index: 0, Middle: 0, Ring: 0, Little: 0 },
      fingerSpread: { Thumb: 0, Index: 0, Middle: 0, Ring: 0, Little: 0 },
    },
  },

  // Upper-Body, Spine Arch, Shoulders, Elbows & Head Pose State (Front + Side Webcams)
  pose: {
    yaw: 0,
    pitch: 0,
    roll: 0,
    sway: 0,
    lean: 0,
    arch: 0,
    shoulderL: 0,
    shoulderR: 0,
    elbowL: 0,
    elbowR: 0,
    jaw: 0,
    smile: 0,
    frown: 0,
    browRaise: 0,
    eyeBlinkLeft: 0, eyeBlinkRight: 0, eyeTracking: 0,
  },
  smoothedPose: {
    yaw: 0,
    pitch: 0,
    roll: 0,
    sway: 0,
    lean: 0,
    arch: 0,
    shoulderL: 0,
    shoulderR: 0,
    elbowL: 0,
    elbowR: 0,
    jaw: 0,
    smile: 0,
    frown: 0,
    browRaise: 0,
    eyeBlinkLeft: 0, eyeBlinkRight: 0, eyeTracking: 0,
  },
};

const FINGER_NAMES = ['Thumb', 'Index', 'Middle', 'Ring', 'Little'];
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

function midiToNoteName(midi) {
  const name = NOTE_NAMES[midi % 12];
  const oct = Math.floor(midi / 12) - 1;
  return `${name}${oct}`;
}

function formatTimeMs(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function chooseHandForMidi(midi) {
  return midi < 60 ? 'left' : 'right';
}

// ============================================================================
// 2. THREE.JS CONCERT STAGE & WEBXR SETUP
// ============================================================================
const container = document.getElementById('canvas-container');
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
renderer.xr.enabled = true;
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0d13);
scene.fog = new THREE.FogExp2(0x0b0d13, 0.12);

const camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 0.05, 50);
camera.position.set(-1.35, 1.42, 1.55);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0.0, 0.92, 0.25);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.maxPolarAngle = Math.PI * 0.49;
controls.minDistance = 0.35;
controls.maxDistance = 18.0;
controls.update();

const CAM_PRESETS = {
  'stage':    { pos: [-3.05, 2.25, 4.45], target: [0.0, 1.43, -.60], fov: 48 },
  '3q':       { pos: [-1.35, 1.42, 1.55], target: [0.0, 0.92, 0.25], fov: 42 },
  'hands':    { pos: [-0.28, 1.05, 0.88], target: [0.05, 0.75, 0.46], fov: 35 },
  'face':     { pos: [-0.18, 1.28, 0.78], target: [0.0, 1.17, 0.02], fov: 36 },
  'overhead': { pos: [0.0, 1.95, 0.52],   target: [0.0, 0.72, 0.47], fov: 45 },
  'pov':      { pos: [0.0, 1.23, 0.09],   target: [0.0, 0.72, 0.49], fov: 58 },
};

let camTransition = null;
function setCameraPreset(name) {
  const preset = CAM_PRESETS[name];
  if (!preset) return;
  STATE.cameraMode = name;
  camTransition = {
    startPos: camera.position.clone(),
    endPos: name==='stage' ? new THREE.Vector3(...preset.pos).sub(new THREE.Vector3(...preset.target)).multiplyScalar(Math.max(1,1.0/camera.aspect)).add(new THREE.Vector3(...preset.target)) : new THREE.Vector3(...preset.pos),
    startTarget: controls.target.clone(),
    endTarget: new THREE.Vector3(...preset.target),
    startFov: camera.fov,
    endFov: preset.fov,
    progress: 0,
  };
  document.querySelectorAll('[data-cam]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.cam === name);
  });
}

// Concert Hall Lighting
const ambientLight = new THREE.HemisphereLight(0xdbeafe, 0x1e1b18, 0.75);
scene.add(ambientLight);

const keySpot = new THREE.SpotLight(0xfff3db, 4.5);
keySpot.position.set(-1.4, 3.2, 2.2);
keySpot.angle = Math.PI / 4;
keySpot.penumbra = 0.65;
keySpot.castShadow = true;
keySpot.shadow.mapSize.set(2048, 2048);
keySpot.shadow.bias = -0.0004;
scene.add(keySpot);

const rimLight = new THREE.SpotLight(0x60a5fa, 2.4);
rimLight.position.set(1.8, 2.5, -1.6);
rimLight.angle = Math.PI / 3;
rimLight.penumbra = 0.8;
scene.add(rimLight);

const keyboardFill = new THREE.PointLight(0xffedd5, 1.2, 3.0);
keyboardFill.position.set(0.0, 1.25, 0.65);
scene.add(keyboardFill);

// Soft additive key halos are local to the pressed notes, including the in-world
// camera views. Pool all 88 once; inactive halos cost no draw calls.
const keyGlowCanvas=document.createElement('canvas');keyGlowCanvas.width=keyGlowCanvas.height=128;
const keyGlowContext=keyGlowCanvas.getContext('2d');
const keyGlowGradient=keyGlowContext.createRadialGradient(64,64,1,64,64,64);
keyGlowGradient.addColorStop(0,'rgba(255,255,255,.95)');keyGlowGradient.addColorStop(.2,'rgba(255,255,255,.65)');keyGlowGradient.addColorStop(.55,'rgba(255,255,255,.18)');keyGlowGradient.addColorStop(1,'rgba(255,255,255,0)');
keyGlowContext.fillStyle=keyGlowGradient;keyGlowContext.fillRect(0,0,128,128);
const keyGlowTexture=new THREE.CanvasTexture(keyGlowCanvas);keyGlowTexture.colorSpace=THREE.SRGBColorSpace;
function attachKeyGlow(key){
  key.geometry.computeBoundingBox();const b=key.geometry.boundingBox;
  key.userData.originalKeyColor=key.material.color.clone();
  const glow=new THREE.Sprite(new THREE.SpriteMaterial({map:keyGlowTexture,color:0xffffff,transparent:true,opacity:0,blending:THREE.AdditiveBlending,depthWrite:false,toneMapped:false,fog:false}));
  glow.position.set((b.min.x+b.max.x)/2,b.max.y+.020,b.min.z+(b.max.z-b.min.z)*.70);
  glow.scale.set(.068,.084,1);glow.visible=false;key.add(glow);key.userData.noteGlow=glow;
}

// Single Non-Flickering Hardwood Concert Stage Floor
function createStageFloorTexture() {
  const size = 1024;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d');

  ctx.fillStyle = '#18130f';
  ctx.fillRect(0, 0, size, size);

  const plankCount = 32;
  const plankH = size / plankCount;
  for (let i = 0; i < plankCount; i++) {
    const shade = 18 + ((i * 7) % 9);
    ctx.fillStyle = `rgb(${shade + 6}, ${shade + 1}, ${shade - 3})`;
    ctx.fillRect(0, i * plankH, size, plankH - 1);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.38)';
    ctx.fillRect(0, (i + 1) * plankH - 1.5, size, 1.5);
  }

  const grad = ctx.createRadialGradient(size / 2, size / 2, size * 0.1, size / 2, size / 2, size * 0.5);
  grad.addColorStop(0, 'rgba(255, 215, 160, 0.05)');
  grad.addColorStop(0.7, 'rgba(0, 0, 0, 0.15)');
  grad.addColorStop(1, 'rgba(0, 0, 0, 0.65)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);

  ctx.strokeStyle = 'rgba(245, 158, 11, 0.35)';
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size * 0.39, 0, Math.PI * 2);
  ctx.stroke();

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

const floorGeo = new THREE.CircleGeometry(5.5, 64);
const floorMat = new THREE.MeshStandardMaterial({
  map: createStageFloorTexture(),
  roughness: 0.42,
  metalness: 0.08,
});
const floorMesh = new THREE.Mesh(floorGeo, floorMat);
floorMesh.rotation.x = -Math.PI / 2;
floorMesh.position.y = -0.002;
floorMesh.receiveShadow = true;
scene.add(floorMesh);

function createMicroDetailBumpTexture() {
  const size = 256;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  let seed = 1337;
  for (let i = 0; i < img.data.length; i += 4) {
    seed = (seed * 16807) % 2147483647;
    const v = 115 + (seed % 26);
    img.data[i] = v;
    img.data[i + 1] = v;
    img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(16, 16);
  return tex;
}
const microBumpTex = createMicroDetailBumpTexture();

// WebXR VR Button
const vrBtnEl = document.getElementById('btn-vr');
if ('xr' in navigator) {
  navigator.xr.isSessionSupported('immersive-vr').then((supported) => {
    if (supported) {
      const hiddenVrBtn = VRButton.createButton(renderer);
      hiddenVrBtn.style.display = 'none';
      document.body.appendChild(hiddenVrBtn);
      vrBtnEl.addEventListener('click', () => hiddenVrBtn.click());
    } else {
      vrBtnEl.textContent = '🥽 VR Not Detected';
    }
  }).catch(() => {
    vrBtnEl.textContent = '🥽 VR Unavailable';
  });
} else {
  vrBtnEl.textContent = '🥽 WebXR N/A';
}

// ============================================================================
// 3. LOAD RIG CALIBRATION & CONCERT_STAGE.GLB
// ============================================================================
// Fingerprints must change with every model/calibration release. Only public assets enter this cache.
const STAGE_ASSETS = {
  "concert_stage.glb": {
    "sha256": "534a8b7a1aa0da8696465548c22c83a0eed14fff60540db99f416bbf950c55db",
    "bytes": 62971180
  },
  "rig_calibration.json": {
    "sha256": "8e1c866238c0ca713a7f47d7b16e2cef22ca5b1670e257642ea5ff3d093a84ac",
    "bytes": 56636
  }
};
async function loadPublicStageAsset(name,onProgress) {
  const spec=STAGE_ASSETS[name],url=new URL(`./${name}`,location.href);
  url.searchParams.set('v',spec.sha256);
  let cache=null,response=null;
  try {
    cache=await globalThis.caches?.open('piano-public-stage-v1');
    response=await cache?.match(url.href);
  } catch (error) { console.info('Stage cache unavailable; using network'); }
  const cached=Boolean(response);
  if (!response) response=await fetch(url.href,{credentials:'omit'});
  if (!response.ok) throw Error(`Unable to load ${name}: ${response.status}`);
  let buffer;
  if (response.body&&onProgress) {
    const reader=response.body.getReader(),bytes=new Uint8Array(spec.bytes);let received=0;
    while (true) {
      const {done,value}=await reader.read();if (done) break;
      if (received+value.length>bytes.length) { await reader.cancel();throw Error(`Stage version changed; please reload`); }
      bytes.set(value,received);received+=value.length;onProgress(received,spec.bytes,cached);
    }
    buffer=bytes.buffer;
  } else buffer=await response.arrayBuffer();
  if (buffer.byteLength!==spec.bytes) {
    await cache?.delete(url.href);
    throw Error(`Incomplete ${name}; please reload the page`);
  }
  const digest=await crypto.subtle.digest('SHA-256',buffer);
  const actual=[...new Uint8Array(digest)].map(byte=>byte.toString(16).padStart(2,'0')).join('');
  if (actual!==spec.sha256) {
    await cache?.delete(url.href);
    throw Error(`The stage has been updated; please reload the page`);
  }
  if (cache&&!cached) {
    try {
      await cache.put(url.href,new Response(buffer,{headers:{'Content-Type':response.headers.get('Content-Type')||'application/octet-stream'}}));
      for (const key of await cache.keys()) {
        if (new URL(key.url).pathname===url.pathname&&key.url!==url.href) await cache.delete(key);
      }
    } catch (error) { console.info('Stage cache is full; this visit will use the network'); }
  }
  console.info(`Stage asset ${cached?'cache hit':'downloaded'}: ${name}`);
  return buffer;
}

async function loadStageAndAvatar() {
  const loadingText = document.getElementById('loading-text');
  const loadingOverlay = document.getElementById('loading-overlay');

  try {
    loadingText.textContent = 'Loading avatar and keyboard calibration…';
    const [calibration,model]=await Promise.all([
      loadPublicStageAsset('rig_calibration.json'),
      loadPublicStageAsset('concert_stage.glb',(loaded,total,cached)=>{
        loadingText.textContent=`${cached?'Restoring':'Loading'} 3D Avatar & Grand Piano (${Math.round(loaded/total*100)}%)…`;
      }),
    ]);
    STATE.calib=JSON.parse(new TextDecoder().decode(calibration));
    build2DKeyboardRibbon();
    loadingText.textContent='Preparing avatar and piano…';
    const loader=new GLTFLoader();
    const gltf=await loader.parseAsync(model,new URL('./',location.href).href);

    const root = gltf.scene;
    scene.add(root);

    const convertedGeometries = new WeakSet();
    STATE.headOnlyMeshes = [];

    root.traverse((obj) => {
      if (obj.isBone) {
        STATE.bones[obj.name] = obj;
      }
      if (obj.name === 'Floor' || (obj.material && obj.material.name === 'Stage_Floor')) {
        obj.visible = false;
        return;
      }
      if (obj.isMesh) {
        if (obj.morphTargetDictionary?.Blink !== undefined) {
          // Split the fitted bilateral morph, including eye retraction and normals,
          // into independent eyes without changing the original automatic blink.
          const blinkIndex = obj.morphTargetDictionary.Blink;
          obj.geometry = obj.geometry.clone();
          const positions = obj.geometry.attributes.position;
          const first = obj.geometry.morphAttributes.position.length;
          for (const [attribute, targets] of Object.entries(obj.geometry.morphAttributes)) {
            const blink = targets[blinkIndex];
            if (!blink) continue;
            for (const sign of [1, -1]) {
              const split = blink.clone();
              for (let i=0; i<split.count; i++) if (positions.getX(i)*sign < 0) {
                for (let c=0; c<split.itemSize; c++) split.array[i*split.itemSize+c] = obj.geometry.morphTargetsRelative ? 0 : obj.geometry.attributes[attribute].array[i*split.itemSize+c];
              }
              targets.push(split);
            }
          }
          obj.morphTargetDictionary.BlinkLeft = first;
          obj.morphTargetDictionary.BlinkRight = first+1;
          obj.morphTargetInfluences.push(0,0);
          STATE.blinkMeshes.push(obj);
        }
        obj.castShadow = true;
        obj.receiveShadow = true;
        obj.frustumCulled = !obj.isSkinnedMesh;

        if (obj.geometry && obj.geometry.attributes.color && !convertedGeometries.has(obj.geometry)) {
          convertedGeometries.add(obj.geometry);
          const colAttr = obj.geometry.attributes.color;
          const count = colAttr.count;
          const rgb = new Float32Array(count * 3);
          for (let i = 0; i < count; i++) {
            rgb[i * 3]     = colAttr.getX(i);
            rgb[i * 3 + 1] = colAttr.getY(i);
            rgb[i * 3 + 2] = colAttr.getZ(i);
          }
          obj.geometry.setAttribute('color', new THREE.BufferAttribute(rgb, 3));
        }

        if (obj.material) {
          const mName = obj.material.name || '';
          if (['NaturalHairFibers','NaturalEyelashes'].includes(mName)) obj.castShadow = false;
          if(mName==='NaturalEyelashes')obj.receiveShadow=false;
          // Avoid coarse shadow-map acne on millimetre-scale moving eyelids.
          if (['PortraitSkin', 'EyeWhite', 'Iris', 'Pupil', 'SaltPepperHair', 'NaturalHairFibers'].includes(mName)) obj.receiveShadow = false;
          if (['LegacyGarment'].includes(mName) && obj.isSkinnedMesh) {
            obj.geometry = obj.geometry.clone();
            const p = obj.geometry.attributes.position, n = obj.geometry.attributes.normal;
            if (p && n) {
              // Rest-space tailoring follows existing skin weights through every pose.
              // Millimetres of ease and broad folds add silhouette without inflating hands/face.
              const jacket = mName === 'Jacket';
              for (let i=0; i<p.count; i++) {
                const x=p.getX(i), y=p.getY(i), z=p.getZ(i);
                const ease = jacket ? .006 : .004;
                const fold = (jacket ? .0025 : .002) * Math.sin(z*48+x*19) * Math.sin(y*35+z*13);
                const offset=ease+fold;
                p.setXYZ(i,x+n.getX(i)*offset,y+n.getY(i)*offset,z+n.getZ(i)*offset);
              }
              p.needsUpdate=true;
              obj.geometry.computeVertexNormals();
              obj.geometry.computeBoundingSphere();
            }
            obj.material.roughness = .92;
          }

          obj.material.transparent = false;
          obj.material.depthWrite = true;
          if (obj.geometry && obj.geometry.attributes.color) {
            obj.material.vertexColors = true;
          }
          if (['Skin', 'Beard', 'Moustache', 'SaltPepperHair', 'Jacket', 'Sweater', 'Jeans', 'Trousers', 'DressShirt'].includes(mName)) {
            obj.material.bumpMap = microBumpTex;
            obj.material.bumpScale = ['Beard', 'Moustache', 'SaltPepperHair'].includes(mName) ? 0.0005 : 0.0003;
          }
          if (['EyeWhite', 'Iris', 'Pupil'].includes(mName)) {
            obj.material.roughness = 0.1;
          }
          if (['Beard', 'Moustache', 'SaltPepperHair', 'Brows', 'EyeWhite', 'Iris', 'Pupil', 'Lips', 'Nostril'].includes(mName)) {
            STATE.headOnlyMeshes.push(obj);
          }
          obj.material.needsUpdate = true;
        }
      }
      if (obj.name && obj.name.startsWith('Key_')) {
        const parts = obj.name.split('_');
        const midi = parseInt(parts[1], 10);
        if (!isNaN(midi)) {
          STATE.keyMeshes[midi] = obj;
          if (obj.isMesh && obj.material) {
            obj.material = obj.material.clone();
            attachKeyGlow(obj);
          }
        }
      }
    });

    applyBasePose();
    loadingOverlay.style.display = 'none';
  } catch (err) {
    console.error('Failed to load stage or calibration:', err);
    loadingText.textContent = `Error loading stage: ${err.message}`;
  }
}

function applyBasePose() {
  if (!STATE.calib || !STATE.calib.basePose) return;
  for (const [boneName, data] of Object.entries(STATE.calib.basePose)) {
    const bone = STATE.bones[boneName];
    if (!bone) continue;
    if (data.t) bone.position.fromArray(data.t);
    if (data.r) bone.quaternion.fromArray(data.r);
  }
  scene.updateMatrixWorld(true);
  for (const name of ['spine','chest','upperChest','neck','head','leftShoulder','rightShoulder']) {
    if (STATE.bones[name]) STATE.forwardPitchAxes[name]=forwardPitchAxis(STATE.bones[name]);
  }
  STATE.baseShoulderWorldQuat = {
    left: STATE.bones.leftShoulder ? STATE.bones.leftShoulder.getWorldQuaternion(new THREE.Quaternion()) : null,
    right: STATE.bones.rightShoulder ? STATE.bones.rightShoulder.getWorldQuaternion(new THREE.Quaternion()) : null,
  };
}

// ============================================================================
// 4. LOOK-AHEAD ANTICIPATORY 88-KEY ARM IK & 10-FINGER SOLVER
// ============================================================================
const _qA = new THREE.Quaternion();
const _qB = new THREE.Quaternion();
const _qC = new THREE.Quaternion();
const _qTarget = new THREE.Quaternion();
const _qDelta = new THREE.Quaternion();
const _qShoulderCur = new THREE.Quaternion();
const _qShoulderComp = new THREE.Quaternion();
const _euler = new THREE.Euler();

function sampleArmIK(side, wristX, strikeAmt, blackAmt, bonePart) {
  const samples = STATE.calib.armIK[side];
  const minX = samples[0].x;
  const step = samples[1].x - samples[0].x;
  const clampedX = Math.max(-0.6, Math.min(0.6, wristX));
  const floatIdx = (clampedX - minX) / step;
  const idx0 = Math.max(0, Math.min(samples.length - 2, Math.floor(floatIdx)));
  const idx1 = idx0 + 1;
  const frac = Math.max(0, Math.min(1, floatIdx - idx0));

  function blendAtSample(s) {
    _qA.fromArray(s.hover[bonePart]);
    _qB.fromArray(s.strike[bonePart]);
    // Negative strikeAmt lifts wrist slightly above hover for preparatory anticipation
    const clampedStrike = Math.max(0, Math.min(1, strikeAmt));
    _qA.slerp(_qB, clampedStrike);
    if (blackAmt > 0.001) {
      _qC.fromArray(s.reachBlack[bonePart]);
      _qA.slerp(_qC, blackAmt * 0.85);
    }
    return _qA.clone();
  }

  const q0 = blendAtSample(samples[idx0]);
  const q1 = blendAtSample(samples[idx1]);
  return q0.slerp(q1, frac);
}

/**
 * Returns upcoming noteOn events within the next `windowMs` (1200ms) from either:
 *  - Archive Replay timeline (`STATE.replay`), or
 *  - Live Visitor Look-Ahead Buffer (`STATE.liveBufferQueue`)
 * Each item is `{ leadMs: number, midi: number, velocity: number, hand: 'left'|'right' }`.
 */
function getLookAheadUpcomingNotes(now, windowMs = LOOKAHEAD_BUFFER_MS) {
  const upcoming = [];

  if (STATE.replay.active && STATE.replay.session && !STATE.replay.paused) {
    const events = STATE.replay.session.events;
    const curMs = STATE.replay.playheadMs;
    for (let i = STATE.replay.eventCursor; i < events.length; i++) {
      const ev = events[i];
      const leadMs = ev.t - curMs;
      if (leadMs > windowMs) break;
      if (leadMs > 0 && ev.type === 'midi' && ev.action === 'noteOn') {
        upcoming.push({
          leadMs,
          midi: ev.midi,
          velocity: ev.velocity || 0.8,
          hand: chooseHandForMidi(ev.midi),
        });
      }
    }
  } else if (STATE.viewMode === 'visitor' && STATE.liveBufferQueue.length > 0) {
    for (const item of STATE.liveBufferQueue) {
      const leadMs = item.playAt - now;
      if (leadMs > windowMs) break;
      if (leadMs > 0 && item.event.type === 'midi' && item.event.action === 'noteOn') {
        upcoming.push({
          leadMs,
          midi: item.event.midi,
          velocity: item.event.velocity || 0.8,
          hand: chooseHandForMidi(item.event.midi),
        });
      }
    }
  }

  return upcoming;
}

function updateHandAndFingerTargets(now) {
  if (!STATE.calib) return;

  const leftNotes = [];
  const rightNotes = [];
  for (const [midi, info] of STATE.activeNotes.entries()) {
    if (info.hand === 'left') leftNotes.push({ midi, ...info });
    else rightNotes.push({ midi, ...info });
  }
  leftNotes.sort((a, b) => a.midi - b.midi);
  rightNotes.sort((a, b) => a.midi - b.midi);

  // Gather look-ahead future notes (up to 1.8s ahead) for anticipatory arm/hand movement
  const upcomingAll = getLookAheadUpcomingNotes(now, LOOKAHEAD_BUFFER_MS);
  const leftUpcoming = upcomingAll.filter((n) => n.hand === 'left');
  const rightUpcoming = upcomingAll.filter((n) => n.hand === 'right');

  solveSingleHandCluster('left', leftNotes, leftUpcoming, now);
  solveSingleHandCluster('right', rightNotes, rightUpcoming, now);
}

function solveSingleHandCluster(side, activeCluster, upcomingList, now) {
  const handState = STATE.hands[side];
  const fingerOffsets = STATE.calib.fingerXOffset[side];
  const nextFingerPress = { Thumb: 0, Index: 0, Middle: 0, Ring: 0, Little: 0 };
  const nextFingerSpread = { Thumb: 0, Index: 0, Middle: 0, Ring: 0, Little: 0 };
  const nextFingerKeys = {};

  const orderedFingers =
    side === 'left'
      ? ['Little', 'Ring', 'Middle', 'Index', 'Thumb']
      : ['Thumb', 'Index', 'Middle', 'Ring', 'Little'];

  // Compute earliest upcoming note cluster in the look-ahead window
  let upcomingTargetX = null;
  let upcomingBlack = 0;
  let minLeadMs = Infinity;
  let upcomingFinger = null;
  let upcomingClusterAssignments = [];

  if (upcomingList.length > 0) {
    minLeadMs = upcomingList[0].leadMs;
    // Group notes occurring within 35ms of the earliest upcoming note (upcoming chord/dyad)
    const nextCluster = upcomingList.filter((u) => Math.abs(u.leadMs - minLeadMs) <= 35);
    nextCluster.sort((a, b) => a.midi - b.midi);

    let xSum = 0;
    let bCount = 0;
    nextCluster.forEach((n, idx) => {
      const fIdx =
        nextCluster.length === 1
          ? Math.max(0, Math.min(4, 2 + Math.round((n.midi - handState.anchorMidi) / 2)))
          : Math.min(4, Math.round((idx / Math.max(1, nextCluster.length - 1)) * 4));
      const fName = orderedFingers[fIdx];
      if (idx === 0) upcomingFinger = fName;
      const kd = STATE.calib.keys[String(n.midi)];
      if (kd) {
        xSum += kd.x - (fingerOffsets[fName] || 0);
        if (kd.isBlack) bCount++;
        upcomingClusterAssignments.push({ finger: fName, fIdx, keyX: kd.x });
      }
    });
    upcomingTargetX = Math.max(-0.58, Math.min(0.58, xSum / nextCluster.length));
    upcomingBlack = bCount / nextCluster.length;
  }

  if (activeCluster.length > 0) {
    handState.lastActiveTime = now;
    handState.prepLift = 0;

    const avgMidi = activeCluster.reduce((acc, n) => acc + n.midi, 0) / activeCluster.length;
    handState.anchorMidi = handState.anchorMidi * 0.65 + avgMidi * 0.35;

    let wristXSum = 0;
    let maxVelocity = 0;
    let blackCount = 0;

    if (activeCluster.length === 1) {
      const note = activeCluster[0];
      const delta = Math.round(note.midi - handState.anchorMidi);
      let fingerIdx = 2;
      if (delta <= -3) fingerIdx = 0;
      else if (delta <= -1) fingerIdx = 1;
      else if (delta <= 1) fingerIdx = 2;
      else if (delta <= 3) fingerIdx = 3;
      else fingerIdx = 4;

      const chosenFinger = note.finger || orderedFingers[fingerIdx];
      note.finger = chosenFinger;
      nextFingerKeys[chosenFinger] = note.midi;
      nextFingerPress[chosenFinger] = Math.max(0.55, note.velocity);

      const keyData = STATE.calib.keys[String(note.midi)];
      if (keyData) {
        wristXSum = keyData.x - (fingerOffsets[chosenFinger] || 0);
        if (keyData.isBlack) blackCount = 1;
      } else {
        wristXSum = handState.targetX;
      }
      maxVelocity = note.velocity;
    } else {
      activeCluster.forEach((note, i) => {
        const fIdx = Math.min(
          4,
          Math.round((i / Math.max(1, activeCluster.length - 1)) * 4)
        );
        const chosenFinger = orderedFingers[fIdx];
        note.finger = chosenFinger;
        nextFingerKeys[chosenFinger] = note.midi;
        nextFingerPress[chosenFinger] = Math.max(nextFingerPress[chosenFinger], Math.max(0.55, note.velocity));

        const keyData = STATE.calib.keys[String(note.midi)];
        if (keyData) {
          wristXSum += keyData.x - (fingerOffsets[chosenFinger] || 0);
          if (keyData.isBlack) blackCount++;
        }
        if (note.velocity > maxVelocity) maxVelocity = note.velocity;
      });
      wristXSum /= activeCluster.length;
    }

    let finalTargetX = Math.max(-0.58, Math.min(0.58, wristXSum));
    // Smoothly bias wrist carrier toward the next upcoming note if within 350ms
    if (upcomingTargetX !== null && minLeadMs < 350) {
      const blend = (1 - minLeadMs / 350) * 0.28;
      finalTargetX = finalTargetX * (1 - blend) + upcomingTargetX * blend;
    }

    handState.targetX = finalTargetX;
    handState.strikeAmt = STATE.calib.fingertipContact ? 1.0 : Math.min(1.0, 0.55 + maxVelocity * 0.45);
    handState.blackAmt = blackCount / activeCluster.length;

    // Compute lateral finger abduction/spread so each finger reaches its exact target key X
    // (+rzRad moves fingertip in +X world direction on both left and right hands, ~0.070m per rad)
    let minKeyX = Infinity;
    let maxKeyX = -Infinity;
    for (const note of activeCluster) {
      const chosenFinger = note.finger;
      const keyData = STATE.calib.keys[String(note.midi)];
      if (!keyData || !chosenFinger) continue;
      if (keyData.x < minKeyX) minKeyX = keyData.x;
      if (keyData.x > maxKeyX) maxKeyX = keyData.x;
      // Blend between currentX and finalTargetX so finger reaches out immediately while wrist glides
      const refWristX = handState.currentX * 0.45 + finalTargetX * 0.55;
      const neutralFingerX = refWristX + (fingerOffsets[chosenFinger] || 0);
      const dx = keyData.x - neutralFingerX;
      nextFingerSpread[chosenFinger] = Math.max(-0.42, Math.min(0.42, dx / 0.068));
    }

    // Sympathetic fan across non-playing fingers so fingers open up naturally on chords & wide intervals
    const chordSpan = maxKeyX > minKeyX ? maxKeyX - minKeyX : 0;
    const extraFan = Math.max(0, (chordSpan - 0.09) * 1.35);
    orderedFingers.forEach((fName, idx) => {
      if (nextFingerPress[fName] === 0) {
        // Fan outward from middle finger (idx === 2): idx 0..1 spread +X, idx 3..4 spread -X
        const fanDir = (2 - idx) * 0.5;
        let neighborSpread = 0;
        if (idx > 0) neighborSpread += nextFingerSpread[orderedFingers[idx - 1]] * 0.32;
        if (idx < 4) neighborSpread += nextFingerSpread[orderedFingers[idx + 1]] * 0.32;
        nextFingerSpread[fName] = Math.max(-0.38, Math.min(0.38, neighborSpread + fanDir * extraFan));
      }
    });
  } else {
    // Hand is currently between notes: use look-ahead buffer to pre-position hand & pre-spread fingers!
    handState.strikeAmt = 0.0;
    if (upcomingTargetX !== null) {
      // Smoothly glide wrist to upcomingTargetX ahead of the note!
      handState.targetX = upcomingTargetX;
      const reachProgress = Math.max(0, Math.min(1, 1 - minLeadMs / 900));
      handState.blackAmt = upcomingBlack * reachProgress;

      // Pre-spread fingers toward upcoming note/chord during final 550ms
      if (minLeadMs < 550 && upcomingClusterAssignments.length > 0) {
        const spreadPrep = Math.max(0, Math.min(1, 1 - minLeadMs / 550)) * 0.75;
        for (const item of upcomingClusterAssignments) {
          const neutralX = upcomingTargetX + (fingerOffsets[item.finger] || 0);
          const dx = item.keyX - neutralX;
          nextFingerSpread[item.finger] = Math.max(-0.36, Math.min(0.36, (dx / 0.068) * spreadPrep));
        }
      }

      // Preparatory wrist/finger lift during final 320ms before striking the key
      if (minLeadMs < 320) {
        const phase = (320 - minLeadMs) / 320;
        handState.prepLift = Math.sin(phase * Math.PI) * 0.22;
        if (upcomingFinger) {
          nextFingerPress[upcomingFinger] = -Math.sin(phase * Math.PI) * 0.35; // Negative = preparatory finger lift!
        }
      } else {
        handState.prepLift = 0;
      }
    } else {
      handState.blackAmt *= 0.85;
      handState.prepLift = 0;
    }
  }

  handState.fingerPress = nextFingerPress;
  handState.fingerSpread = nextFingerSpread;
  handState.fingerKeys = nextFingerKeys;
}

const bodyDamper = new PoseDamper(.16);
function updateAvatarAndPianoAnimation(dt, elapsed) {
  if (!STATE.calib) return;

  const now = performance.now();
  processLiveBufferQueue(now);
  processArchiveReplay(dt);
  updateHandAndFingerTargets(now);

  // 1. Animate 88 3D Piano Keys
  for (let midi = 21; midi <= 108; midi++) {
    const keyObj = STATE.keyMeshes[midi];
    if (!keyObj) continue;
    const noteInfo = STATE.activeNotes.get(midi);
    const targetRotX = noteInfo ? -0.084 * (0.65 + 0.35 * noteInfo.velocity) : 0.0;
    keyObj.rotation.x += (targetRotX - keyObj.rotation.x) * Math.min(1, dt * 32);

    const lit=Boolean(STATE.viewMode==='visitor'&&STATE.visitorNoteLights&&noteInfo);
    const lightColor=noteInfo?.hand==='left'?0x08aaff:0xff9f16;
    const glow=keyObj.userData.noteGlow;
    if(glow){
      const target=lit ? .65+(noteInfo.velocity||.5)*.35 : 0;
      glow.material.opacity+=(target-glow.material.opacity)*(1-Math.exp(-dt*(lit?35:14)));
      glow.material.color.setHex(lightColor);glow.visible=glow.material.opacity>.008;
      if(lit)keyObj.material.color.setHex(lightColor);else keyObj.material.color.copy(keyObj.userData.originalKeyColor);
    }
    if (keyObj.material && keyObj.material.emissive) {
      if (noteInfo) {
        const illuminated=STATE.viewMode==='visitor'&&STATE.visitorNoteLights;
        keyObj.material.emissive.setHex(noteInfo.hand === 'left' ? (illuminated?0x08aaff:0x0c4a6e) : (illuminated?0xff9f16:0x78350f));
        keyObj.material.emissiveIntensity=illuminated?1.35:1;
      } else {
        keyObj.material.emissive.setHex(0x000000);
        keyObj.material.emissiveIntensity=1;
      }
    }
  }

  // 2. Upper-Body, Head & Jaw Motion (updated BEFORE arms so shoulder world compensation keeps hands above keys)
  let autoYaw = 0;
  let autoPitch = 0;
  let autoSway = 0;
  let autoLean = 0;

  if (!STATE.webcamActive && !STATE.replay.active && performance.now()-STATE.lastTrackedPoseAt>2500) {
    const activeHandX =
      STATE.activeNotes.size > 0
        ? (STATE.hands.left.currentX + STATE.hands.right.currentX) * 0.5
        : Math.sin(elapsed * 0.6) * 0.08;
    autoYaw = activeHandX * 24;
    autoPitch = 4 + Math.sin(elapsed * 1.4) * 2.2 + (STATE.activeNotes.size > 0 ? 3.0 : 0);
    autoSway = -activeHandX * 9 + Math.sin(elapsed * 0.9) * 1.6;
    autoLean = STATE.activeNotes.size > 0 ? 2.2 + Math.sin(elapsed * 1.8) * 1.0 : Math.sin(elapsed * 1.1) * 0.8;
  }

  const targetYaw = (STATE.pose.yaw || 0) + autoYaw;
  const targetPitch = (STATE.pose.pitch || 0) + autoPitch;
  const targetRoll = STATE.pose.roll || 0;
  const targetSway = (STATE.pose.sway || 0) + ((STATE.webcamActive || performance.now()-STATE.lastTrackedPoseAt<2500) ? 0 : autoSway);
  const targetLean = (STATE.pose.lean || 0) + ((STATE.webcamActive || performance.now()-STATE.lastTrackedPoseAt<2500) ? 0 : autoLean);
  const targetArch = STATE.pose.arch || 0;
  const targetShL = STATE.pose.shoulderL || 0;
  const targetShR = STATE.pose.shoulderR || 0;
  const targetElbL = STATE.pose.elbowL || 0;
  const targetElbR = STATE.pose.elbowR || 0;
  const targetJaw = STATE.pose.jaw || 0;

  const targets={yaw:targetYaw,pitch:targetPitch,roll:targetRoll,sway:targetSway,lean:targetLean,arch:targetArch,
    shoulderL:targetShL,shoulderR:targetShR,elbowL:targetElbL,elbowR:targetElbR,jaw:targetJaw};
  for(const field of ARM_FIELDS)targets[field]=STATE.pose[field]||0;
  for(const [field,target] of Object.entries(targets))
    STATE.smoothedPose[field]=bodyDamper.update(field,target,dt,STATE.smoothedPose[field]||0);

  const deg = THREE.MathUtils.degToRad;

  for (const [bName, leanW, archW] of [
    ['spine', 0.36, 0.05],
    ['chest', 0.34, 0.42],
    ['upperChest', 0.30, 0.53],
  ]) {
    const bone = STATE.bones[bName];
    const base = STATE.calib.basePose[bName];
    if (!bone || !base) continue;
    applyAnatomicalRotation(bone,base.r,STATE.forwardPitchAxes[bName],
      STATE.smoothedPose.lean * leanW + STATE.smoothedPose.arch * archW,
      STATE.smoothedPose.yaw * 0.08,STATE.smoothedPose.sway * 0.35);
  }

  for (const [side, shVal] of [
    ['left', STATE.smoothedPose.shoulderL],
    ['right', STATE.smoothedPose.shoulderR],
  ]) {
    const shBone = STATE.bones[`${side}Shoulder`];
    const base = STATE.calib.basePose[`${side}Shoulder`];
    if (shBone && base) {
      const sSign = side === 'left' ? 1 : -1;
      applyAnatomicalRotation(shBone,base.r,STATE.forwardPitchAxes[`${side}Shoulder`],
        STATE.smoothedPose.arch * 0.15,0,sSign * shVal * 0.85);
    }
  }

  if (STATE.bones.upperChest) {
    STATE.bones.upperChest.updateWorldMatrix(true, true);
  }

  for (const [bName, weight] of [['neck', 0.42], ['head', 0.58]]) {
    const bone = STATE.bones[bName];
    const base = STATE.calib.basePose[bName];
    if (!bone || !base) continue;
    applyAnatomicalRotation(bone,base.r,STATE.forwardPitchAxes[bName],
      STATE.smoothedPose.pitch * weight + STATE.smoothedPose.arch * 0.12,
      STATE.smoothedPose.yaw * weight,STATE.smoothedPose.roll * weight);
  }

  if (STATE.bones.jaw && STATE.calib.basePose.jaw && !STATE.blinkMeshes.some(m=>m.morphTargetDictionary.OpenMouth!==undefined)) {
    _qTarget.fromArray(STATE.calib.basePose.jaw.r);
    _euler.set(deg(STATE.smoothedPose.jaw * 18), 0, 0);
    _qDelta.setFromEuler(_euler);
    STATE.bones.jaw.quaternion.copy(_qTarget).multiply(_qDelta);
  }

  // 3. Solve Both Arms & 10 Fingers (with shoulder world-orientation stabilization)
  for (const side of ['left', 'right']) {
    const h = STATE.hands[side];
    // Smooth horizontal wrist carriage along the 88-key keyboard
    const moveSpeed = Math.min(1, dt * 12);
    h.currentX += (h.targetX - h.currentX) * moveSpeed;

    const idleWave = Math.sin(elapsed * 2.1 + (side === 'left' ? 0 : 1.7)) * 0.025;
    const effectiveStrike = Math.max(
      0,
      Math.min(1, h.strikeAmt - h.prepLift * 0.5 + (h.strikeAmt > 0 ? 0 : idleWave))
    );

    const elbDeg = side === 'left' ? STATE.smoothedPose.elbowL : STATE.smoothedPose.elbowR;
    const sSign = side === 'left' ? 1 : -1;

    for (const part of ['UpperArm', 'LowerArm', 'Hand']) {
      const boneName = `${side}${part}`;
      const bone = STATE.bones[boneName];
      if (!bone) continue;
      const targetQ = sampleArmIK(side, h.currentX, effectiveStrike, h.blackAmt, part);

      // Counter-rotate UpperArm against torso lean/sway/shoulder shrug so hands stay strictly above the keybed
      if (part === 'UpperArm' && STATE.baseShoulderWorldQuat && STATE.baseShoulderWorldQuat[side]) {
        const shBone = STATE.bones[`${side}Shoulder`];
        if (shBone) {
          shBone.getWorldQuaternion(_qShoulderCur);
          _qShoulderComp.copy(_qShoulderCur).invert().multiply(STATE.baseShoulderWorldQuat[side]);
          targetQ.premultiply(_qShoulderComp);
        }
        if (Math.abs(elbDeg) > 0.1) {
          _euler.set(0, deg(sSign * elbDeg * 0.38), deg(sSign * elbDeg * 0.18));
          _qDelta.setFromEuler(_euler);
          targetQ.multiply(_qDelta);
        }
      } else if (part === 'LowerArm' && Math.abs(elbDeg) > 0.1) {
        _euler.set(0, deg(-sSign * elbDeg * 0.32), deg(-sSign * elbDeg * 0.15));
        _qDelta.setFromEuler(_euler);
        targetQ.multiply(_qDelta);
      }

      // Add subtle preparatory wrist extension when h.prepLift > 0
      if (part === 'Hand' && h.prepLift > 0.01) {
        _euler.set(h.prepLift * 0.35, 0, 0);
        _qDelta.setFromEuler(_euler);
        targetQ.multiply(_qDelta);
      }
      // Contact IK must not feed its correction into the next frame's carrier pose.
      const carrier = bone.userData.carrierQuaternion ||= bone.quaternion.clone();
      carrier.slerp(targetQ, 1 - Math.exp(-Math.min(dt, .05) * 18));
      bone.quaternion.copy(carrier);
    }

    // 4. Articulate all 5 Fingers (Calibrated Key-Top Flexion + Lateral Abduction/Spread)
    const s = side === 'left' ? 1 : -1;
    for (const finger of FINGER_NAMES) {
      const press = h.fingerPress[finger] || 0;
      const spread = h.fingerSpread ? (h.fingerSpread[finger] || 0) : 0;
      const activeHandLift = h.strikeAmt > 0.1 && press === 0 ? -0.10 : 0;
      const effPress = press + activeHandLift;

      if (finger === 'Thumb') {
        applyFingerPhalanx(`${side}ThumbMetacarpal`, -0.18 * effPress, 0, spread * 0.85 + s * 0.08 * effPress, dt);
        applyFingerPhalanx(`${side}ThumbProximal`, -0.20 * effPress, 0, spread * 0.35, dt);
        applyFingerPhalanx(`${side}ThumbDistal`, -0.14 * effPress, 0, 0, dt);
      } else {
        applyFingerPhalanx(`${side}${finger}Proximal`, -0.22 * effPress, 0, spread, dt);
        applyFingerPhalanx(`${side}${finger}Intermediate`, -0.24 * effPress, 0, 0, dt);
        applyFingerPhalanx(`${side}${finger}Distal`, -0.16 * effPress, 0, 0, dt);
      }
    }
  }

  applyTrackedArms({bones:STATE.bones,hands:STATE.hands,pose:STATE.smoothedPose,upcoming:getLookAheadUpcomingNotes(now),dt,fresh:STATE.replay.active||now-STATE.lastTrackedPoseAt<750});
  enforceFingertipContact({bones: STATE.bones, hands: STATE.hands, keys: STATE.keyMeshes, calibration: STATE.calib});

  // Hide head/face/hair/beard geometry in First-Person Pianist POV (or when camera is inside head radius)
  const dx = camera.position.x;
  const dy = camera.position.y - 1.22;
  const dz = camera.position.z - 0.04;
  const distToHead = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const hideHead = (STATE.cameraMode === 'pov' && distToHead < 0.45) || distToHead < 0.28 || renderer.xr.isPresenting;

  const targetHeadScale = hideHead ? 0.0001 : 1.0;
  if (STATE.bones.head) STATE.bones.head.scale.setScalar(targetHeadScale);
  if (STATE.bones.neck) STATE.bones.neck.scale.setScalar(targetHeadScale);
  if (STATE.headOnlyMeshes) {
    for (const m of STATE.headOnlyMeshes) {
      m.visible = !hideHead;
    }
  }
}

function applyFingerPhalanx(boneName, rxRad, ryRad, rzRad, dt) {
  const bone = STATE.bones[boneName];
  const base = STATE.calib.basePose[boneName];
  if (!bone || !base) return;
  _qTarget.fromArray(base.r);
  _euler.set(rxRad, ryRad, rzRad);
  _qDelta.setFromEuler(_euler);
  _qTarget.multiply(_qDelta);
  const animated = bone.userData.fingerQuaternion ||= _qTarget.clone();
  animated.slerp(_qTarget, 1 - Math.exp(-Math.min(dt, .05) * 26));
  bone.quaternion.copy(animated);
}

// ============================================================================
// 5. VISITOR LOOK-AHEAD BUFFER & ARCHIVE REPLAY ENGINE
// ============================================================================
function enqueueLiveVisitorEvent(msg) {
  const playAt = performance.now() + LOOKAHEAD_BUFFER_MS;
  STATE.liveBufferQueue.push({ playAt, event: msg });
}

function processLiveBufferQueue(now) {
  while (STATE.liveBufferQueue.length > 0 && STATE.liveBufferQueue[0].playAt <= now) {
    const { event, playAt } = STATE.liveBufferQueue.shift();
    if (event.type === 'midi') {
      if (event.action === 'noteOn') {
        triggerNoteOn(event.midi, event.velocity, true);
      } else if (event.action === 'noteOff') {
        triggerNoteOff(event.midi, true);
      }
    } else if (event.type === 'pose' && event.pose) {
      Object.assign(STATE.pose, event.pose);
      STATE.lastTrackedPoseAt=performance.now();
      STATE.livePoseBefore=STATE.livePosePrevious;
      STATE.livePosePrevious={t:playAt,pose:event.pose};
      (STATE.livePoseHistory ||= []).push(STATE.livePosePrevious);
      if(STATE.livePoseHistory.length>24)STATE.livePoseHistory.shift();
    }
  }
  if(STATE.livePosePrevious&&!STATE.replay.active){
    const history=STATE.livePoseHistory||[STATE.livePosePrevious];
    const frames=[...history,...STATE.liveBufferQueue.filter(item=>item.event.type==='pose'&&item.playAt<=now+300).map(item=>({t:item.playAt,pose:item.event.pose}))];
    Object.assign(STATE.pose,sampleSmoothPose(frames,history.length-1,now));
  }
}

async function startArchiveReplay(sessionId) {
  try {
    const resp = await fetch(`./api/archives/${encodeURIComponent(sessionId)}`);
    if (!resp.ok) return;
    const session = await resp.json();

    stopConcertDemo();
    clearAllActiveNotes();
    STATE.liveBufferQueue = [];

    if (STATE.replay.audioEl) {
      STATE.replay.audioEl.pause();
      STATE.replay.audioEl.src = '';
      STATE.replay.audioEl = null;
    }

    STATE.replay.active = true;
    STATE.replay.paused = false;
    session.events=(session.events||[]).filter(e=>Number.isFinite(e.t)).sort((a,b)=>a.t-b.t);
    STATE.replay.poseFrames=session.events.filter(e=>e.type==='pose');
    STATE.replay.poseCursor=0;
    STATE.replay.clock={time:0,lastNow:performance.now()};
    bodyDamper.reset();STATE.livePoseHistory=[];
    for(const field of Object.keys(STATE.pose))STATE.pose[field]=0;
    STATE.replay.session = session;
    STATE.replay.playheadMs = 0;
    STATE.replay.eventCursor = 0;
    STATE.replay.audioPlaying = false;

    // Switch to clean Visitor view if currently in Lobby
    if (STATE.viewMode === 'lobby') {
      enterVisitorStage(false);
    }

    if (session.hasAudio) {
      const audio = new Audio(`./api/archives/${encodeURIComponent(sessionId)}/audio?v=${Date.now()}`);
      audio.preload = 'auto';
      audio.addEventListener('waiting',()=>{STATE.replay.clock.waiting=true;});
      audio.addEventListener('playing',()=>{STATE.replay.clock.waiting=false;STATE.replay.clock.lastNow=performance.now();});
      audio.addEventListener('ended',()=>{STATE.replay.paused=true;clearAllActiveNotes();updateVisitorReplayUI();});
      audio.volume = STATE.muted ? 0 : STATE.masterVolume;
      audio.addEventListener('playing', () => {
        STATE.replay.audioPlaying = true;
      });
      audio.addEventListener('pause', () => {
        STATE.replay.audioPlaying = false;
      });
      audio.addEventListener('error', () => {
        STATE.replay.audioPlaying = false;
      });
      STATE.replay.audioEl = audio;
      audio.play().catch((err) => {
        console.warn('Archive audio autoplay blocked until interaction:', err);
      });
    }

    updateVisitorReplayUI();
  } catch (err) {
    console.error('Failed to load archive session:', err);
  }
}

function stopArchiveReplay() {
  STATE.livePoseHistory=[];STATE.livePosePrevious=null;STATE.livePoseBefore=null;bodyDamper.reset();
  STATE.replay.active = false;
  STATE.replay.paused = false;
  STATE.replay.session = null;
  STATE.replay.audioPlaying = false;
  if (STATE.replay.audioEl) {
    STATE.replay.audioEl.pause();
    STATE.replay.audioEl.src = '';
    STATE.replay.audioEl = null;
  }
  clearAllActiveNotes();
  updateVisitorReplayUI();
}

function seekArchiveReplay(targetMs) {
  const session = STATE.replay.session;
  if (!session) return;
  clearAllActiveNotes();
  STATE.replay.playheadMs = Math.max(0, Math.min(session.durationMs, targetMs));

  // Find first event at or after targetMs
  const events = session.events;
  let idx = 0;
  while (idx < events.length && events[idx].t < STATE.replay.playheadMs) {
    idx++;
  }
  document.getElementById('replay-time').textContent=`${formatTimeMs(STATE.replay.playheadMs)} / ${formatTimeMs(session.durationMs)}`;
  STATE.replay.eventCursor = idx;
  STATE.replay.clock={time:STATE.replay.playheadMs,lastNow:performance.now(),fallback:STATE.replay.clock?.fallback};
  STATE.replay.poseCursor=0;
  // Rebuild held notes and the latest pose when seeking into the middle of a phrase.
  const held=new Map();
  for(let i=0;i<idx;i++){const e=events[i];if(e.type==='midi'){if(e.action==='noteOn')held.set(e.midi,e.velocity);else held.delete(e.midi);}else if(e.type==='pose')Object.assign(STATE.pose,e.pose);}
  Object.assign(STATE.smoothedPose,STATE.pose);bodyDamper.reset();
  for(const [midi,velocity] of held)triggerNoteOn(midi,velocity,true,true);

  if (STATE.replay.audioEl) {
    try {
      STATE.replay.audioEl.currentTime = STATE.replay.playheadMs / 1000;
      if (!STATE.replay.paused && STATE.replay.audioEl.paused) {
        STATE.replay.audioEl.play().catch(() => {});
      }
    } catch (_) {}
  }
}

function processArchiveReplay(dt) {
  if (!STATE.replay.active || STATE.replay.paused || !STATE.replay.session) return;

  const session = STATE.replay.session;
  const audioEl = STATE.replay.audioEl;

  STATE.replay.playheadMs=advanceReplayClock(STATE.replay.clock,performance.now(),audioEl?.error?null:audioEl);

  // If recorded audio already contains the mixed synth stream, avoid double-synthesizing on top
  const suppressDuplicateSynth = Boolean(
    session.hasRecordedSynth &&
      audioEl &&
      !audioEl.paused &&
      !audioEl.ended &&
      audioEl.readyState >= 2
  );

  const events = session.events;
  while (
    STATE.replay.eventCursor < events.length &&
    events[STATE.replay.eventCursor].t <= STATE.replay.playheadMs
  ) {
    const ev = events[STATE.replay.eventCursor++];
    if (ev.type === 'midi') {
      if (ev.action === 'noteOn') {
        triggerNoteOn(ev.midi, ev.velocity || 0.8, true, suppressDuplicateSynth);
      } else if (ev.action === 'noteOff') {
        triggerNoteOff(ev.midi, true);
      }
    } else if (ev.type === 'pose' && ev.pose) {
      Object.assign(STATE.pose, ev.pose);
      STATE.lastTrackedPoseAt=performance.now();
    }
  }

  const frames=STATE.replay.poseFrames||[];
  while(STATE.replay.poseCursor+1<frames.length&&frames[STATE.replay.poseCursor+1].t<=STATE.replay.playheadMs)STATE.replay.poseCursor++;
  const previous=frames[STATE.replay.poseCursor];
  if(previous&&previous.t<=STATE.replay.playheadMs)Object.assign(STATE.pose,sampleSmoothPose(frames,STATE.replay.poseCursor,STATE.replay.playheadMs));
  // Update scrubber & time label
  const scrubber = document.getElementById('replay-scrubber');
  const timeEl = document.getElementById('replay-time');
  if (scrubber && session.durationMs > 0) {
    scrubber.value = Math.round((STATE.replay.playheadMs / session.durationMs) * 1000);
  }
  if (timeEl) {
    timeEl.textContent = `${formatTimeMs(STATE.replay.playheadMs)} / ${formatTimeMs(session.durationMs)}`;
  }

  if (STATE.replay.playheadMs >= session.durationMs) {
    STATE.replay.paused=true;audioEl?.pause();clearAllActiveNotes();updateVisitorReplayUI();
  }
}

function updateVisitorReplayUI() {
  const transport = document.getElementById('replay-transport');
  const modeBadge = document.getElementById('visitor-mode-text');
  const headerTitle = document.getElementById('stage-header-title');
  const playPauseBtn = document.getElementById('btn-replay-playpause');

  if (STATE.replay.active && STATE.replay.session) {
    transport.style.display = 'flex';
    const audioBadge = STATE.replay.session.hasAudio ? '🔊 Synced Audio' : '🎹 Synth';
    modeBadge.textContent = `📼 Replay: ${STATE.replay.session.title} (${audioBadge})`;
    headerTitle.textContent = `📼 ${STATE.replay.session.title}`;
    playPauseBtn.textContent = STATE.replay.paused ? '▶ Play' : '⏸ Pause';
  } else {
    transport.style.display = 'none';
    if (STATE.liveShowActive) {
      modeBadge.textContent = `🔴 LIVE: ${STATE.currentShowTitle} (1.8s Look-Ahead)`;
      headerTitle.textContent = `🔴 ${STATE.currentShowTitle}`;
    } else {
      modeBadge.textContent = '⏳ 1.8s Look-Ahead Buffer Ready';
      headerTitle.textContent = '🎹 Live Concert Stage';
    }
  }
}

function clearAllActiveNotes() {
  for (const m of Array.from(STATE.activeNotes.keys())) {
    triggerNoteOff(m, true);
  }
}

// ============================================================================
// 6. POLYPHONIC WEBAUDIO GRAND PIANO SYNTHESIZER & RECORDING BUS
// ============================================================================
class GrandPianoSynth {
  constructor() {
    this.ctx = null;
    this.masterGain = null;
    this.recordDest = null;
    this.micSource = null;
    this.micGain = null;
    this.voices = new Map();
  }

  ensureContext() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AudioCtx();
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = (STATE.muted ? 0 : STATE.masterVolume) * 0.45;

      // Master recording destination captures both internal synth + any external audio input
      this.recordDest = this.ctx.createMediaStreamDestination();

      const delayL = this.ctx.createDelay();
      const delayR = this.ctx.createDelay();
      delayL.delayTime.value = 0.085;
      delayR.delayTime.value = 0.135;
      const fbGain = this.ctx.createGain();
      fbGain.gain.value = 0.22;
      const wetGain = this.ctx.createGain();
      wetGain.gain.value = 0.22;

      this.masterGain.connect(this.ctx.destination);
      this.masterGain.connect(this.recordDest);
      this.masterGain.connect(delayL);
      this.masterGain.connect(delayR);
      delayL.connect(fbGain);
      delayR.connect(fbGain);
      fbGain.connect(delayL);
      delayL.connect(wetGain);
      delayR.connect(wetGain);
      wetGain.connect(this.ctx.destination);
      wetGain.connect(this.recordDest);
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  attachExternalStream(mediaStream) {
    this.ensureContext();
    this.detachExternalStream();
    try {
      this.micSource = this.ctx.createMediaStreamSource(mediaStream);
      this.micGain = this.ctx.createGain();
      this.micGain.gain.value = 1.0;
      this.micSource.connect(this.micGain);
      this.micGain.connect(this.recordDest);
    } catch (err) {
      console.warn('Could not attach external audio stream to recording bus:', err);
    }
  }

  detachExternalStream() {
    if (this.micSource) {
      try {
        this.micSource.disconnect();
      } catch (_) {}
      this.micSource = null;
    }
    if (this.micGain) {
      try {
        this.micGain.disconnect();
      } catch (_) {}
      this.micGain = null;
    }
  }

  getRecordingStream() {
    this.ensureContext();
    return this.recordDest ? this.recordDest.stream : null;
  }

  setVolume(val01) {
    if (this.masterGain && this.ctx) {
      const eff = STATE.muted ? 0 : val01;
      this.masterGain.gain.setTargetAtTime(eff * 0.45, this.ctx.currentTime, 0.02);
    }
    if (STATE.replay.audioEl) {
      STATE.replay.audioEl.volume = STATE.muted ? 0 : val01;
    }
  }

  noteOn(midi, velocity = 0.8) {
    if (!STATE.synthEnabled || STATE.muted) return;
    this.ensureContext();
    this.noteOff(midi);

    const now = this.ctx.currentTime;
    const freq = 440 * Math.pow(2, (midi - 69) / 12);

    const voiceGain = this.ctx.createGain();
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    const cutoff = Math.min(14000, freq * (3.5 + velocity * 7.5));
    filter.frequency.setValueAtTime(cutoff, now);
    filter.frequency.exponentialRampToValueAtTime(Math.max(freq * 1.6, 400), now + 2.4);

    const osc1 = this.ctx.createOscillator();
    const osc2 = this.ctx.createOscillator();
    const osc3 = this.ctx.createOscillator();

    osc1.type = 'triangle';
    osc1.frequency.setValueAtTime(freq, now);

    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(freq * 2, now);
    osc2.detune.setValueAtTime(1.8, now);

    osc3.type = 'sine';
    osc3.frequency.setValueAtTime(freq, now);
    osc3.detune.setValueAtTime(-1.5, now);

    const g1 = this.ctx.createGain();
    const g2 = this.ctx.createGain();
    const g3 = this.ctx.createGain();
    g1.gain.value = 0.65;
    g2.gain.value = 0.22 * velocity;
    g3.gain.value = 0.35;

    osc1.connect(g1).connect(filter);
    osc2.connect(g2).connect(filter);
    osc3.connect(g3).connect(filter);
    filter.connect(voiceGain).connect(this.masterGain);

    const peak = Math.max(0.05, velocity * 0.55);
    const decayTime = Math.max(1.2, 5.2 - ((midi - 21) / 87) * 3.4);

    voiceGain.gain.setValueAtTime(0.0001, now);
    voiceGain.gain.linearRampToValueAtTime(peak, now + 0.006);
    voiceGain.gain.exponentialRampToValueAtTime(peak * 0.45, now + 0.18);
    voiceGain.gain.exponentialRampToValueAtTime(0.0008, now + decayTime);

    osc1.start(now);
    osc2.start(now);
    osc3.start(now);

    this.voices.set(midi, {
      release: () => {
        const t = this.ctx.currentTime;
        voiceGain.gain.cancelScheduledValues(t);
        voiceGain.gain.setValueAtTime(Math.max(0.0001, voiceGain.gain.value), t);
        voiceGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
        setTimeout(() => {
          try {
            osc1.stop();
            osc2.stop();
            osc3.stop();
            voiceGain.disconnect();
          } catch (_) {}
        }, 250);
      },
    });
  }

  noteOff(midi) {
    const v = this.voices.get(midi);
    if (v) {
      v.release();
      this.voices.delete(midi);
    }
  }
}

const synth = new GrandPianoSynth();

// ============================================================================
// 7. NOTE TRIGGER DISPATCHER
// ============================================================================
function triggerNoteOn(midi, velocity = 0.8, fromPlaybackOrNetwork = false, suppressSynth = false) {
  if (midi < 21 || midi > 108) return;
  const hand = chooseHandForMidi(midi);

  STATE.activeNotes.set(midi, {
    velocity,
    timeOn: performance.now(),
    hand,
    finger: null,
  });

  if (!suppressSynth) {
    synth.noteOn(midi, velocity);
  }
  update2DKeyHighlight(midi, hand);

  const indicator = document.getElementById('note-indicator');
  if (indicator) {
    indicator.textContent = `${midiToNoteName(midi)} (MIDI ${midi})`;
  }

  if (!fromPlaybackOrNetwork && STATE.role === 'performer') {
    broadcastWS({
      type: 'midi',
      action: 'noteOn',
      midi,
      velocity: Number(velocity.toFixed(3)),
    });
  }
}

function triggerNoteOff(midi, fromPlaybackOrNetwork = false) {
  if (midi < 21 || midi > 108) return;
  STATE.activeNotes.delete(midi);
  if (!STATE.sustainPedal) {
    synth.noteOff(midi);
  }
  update2DKeyHighlight(midi, null);

  if (STATE.activeNotes.size === 0) {
    const indicator = document.getElementById('note-indicator');
    if (indicator) indicator.textContent = 'Idle';
  }

  if (!fromPlaybackOrNetwork && STATE.role === 'performer') {
    broadcastWS({
      type: 'midi',
      action: 'noteOff',
      midi,
    });
  }
}

// ============================================================================
// 8. INTERACTIVE 2D 88-KEY RIBBON & COMPUTER KEYBOARD (PERFORMER STUDIO)
// ============================================================================
function build2DKeyboardRibbon() {
  const container2D = document.getElementById('keyboard-2d');
  if (!container2D) return;
  container2D.innerHTML = '';

  const whiteMidis = [];
  for (let m = 21; m <= 108; m++) {
    const k = STATE.calib.keys[String(m)];
    if (k && !k.isBlack) whiteMidis.push(m);
  }
  const whiteWidthPct = 100 / whiteMidis.length;
  const whiteIndexMap = new Map();
  whiteMidis.forEach((m, idx) => whiteIndexMap.set(m, idx));

  let isPointerDown = false;
  let currentPointerMidi = null;

  window.addEventListener('pointerup', () => {
    isPointerDown = false;
    if (currentPointerMidi !== null) {
      triggerNoteOff(currentPointerMidi);
      currentPointerMidi = null;
    }
  });

  for (let m = 21; m <= 108; m++) {
    const k = STATE.calib.keys[String(m)];
    if (!k) continue;

    const el = document.createElement('div');
    el.className = `key-2d ${k.isBlack ? 'black' : 'white'}`;
    el.dataset.midi = m;

    if (!k.isBlack) {
      const wIdx = whiteIndexMap.get(m);
      el.style.left = `${wIdx * whiteWidthPct}%`;
      el.style.width = `${whiteWidthPct}%`;
      if (m % 12 === 0 || m === 21) {
        el.textContent = midiToNoteName(m);
      }
    } else {
      const prevWhiteIdx = whiteIndexMap.get(m - 1);
      const blackW = whiteWidthPct * 0.64;
      el.style.left = `${(prevWhiteIdx + 1) * whiteWidthPct - blackW / 2}%`;
      el.style.width = `${blackW}%`;
    }

    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      isPointerDown = true;
      currentPointerMidi = m;
      triggerNoteOn(m, 0.85);
    });

    el.addEventListener('pointerenter', () => {
      if (isPointerDown && currentPointerMidi !== m) {
        if (currentPointerMidi !== null) triggerNoteOff(currentPointerMidi);
        currentPointerMidi = m;
        triggerNoteOn(m, 0.82);
      }
    });

    container2D.appendChild(el);
    STATE.key2DElements[m] = el;
  }
}

function update2DKeyHighlight(midi, hand) {
  const el = STATE.key2DElements[midi];
  if (!el) return;
  el.classList.remove('active-left', 'active-right');
  if (hand === 'left') el.classList.add('active-left');
  if (hand === 'right') el.classList.add('active-right');
}

let kbOctaveOffset = 0;
const KEY_TO_SEMITONE = {
  KeyA: 0, KeyW: 1, KeyS: 2, KeyE: 3, KeyD: 4, KeyF: 5,
  KeyT: 6, KeyG: 7, KeyY: 8, KeyH: 9, KeyU: 10, KeyJ: 11,
  KeyK: 12, KeyO: 13, KeyL: 14, KeyP: 15, Semicolon: 16,
};
const heldComputerKeys = new Map();

window.addEventListener('keydown', (e) => {
  if (STATE.viewMode !== 'performer') return;
  if (e.repeat || e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.code === 'KeyZ') {
    kbOctaveOffset = Math.max(-3, kbOctaveOffset - 1);
    return;
  }
  if (e.code === 'KeyX') {
    kbOctaveOffset = Math.min(3, kbOctaveOffset + 1);
    return;
  }
  const semi = KEY_TO_SEMITONE[e.code];
  if (semi !== undefined) {
    const midi = 60 + kbOctaveOffset * 12 + semi;
    heldComputerKeys.set(e.code, midi);
    triggerNoteOn(midi, 0.82);
  }
});

window.addEventListener('keyup', (e) => {
  const midi = heldComputerKeys.get(e.code);
  if (midi !== undefined) {
    heldComputerKeys.delete(e.code);
    triggerNoteOff(midi);
  }
});

// ============================================================================
// 9. HARDWARE WEBMIDI KEYBOARD INPUT
// ============================================================================
let midiAccess = null;
let selectedMidiInputId = '';

async function initWebMIDI() {
  const badge = document.getElementById('midi-badge');
  const select = document.getElementById('midi-select');
  const logEl = document.getElementById('midi-log');

  if (!navigator.requestMIDIAccess) {
    badge.textContent = 'Use Chrome/Edge for USB MIDI';
    badge.style.color = '#fbbf24';
    return;
  }

  try {
    midiAccess = await navigator.requestMIDIAccess();
    const updateInputs = () => {
      select.innerHTML = '<option value="">All Connected MIDI Inputs</option>';
      let count = 0;
      for (const input of midiAccess.inputs.values()) {
        count++;
        const opt = document.createElement('option');
        opt.value = input.id;
        opt.textContent = input.name || `MIDI Device ${count}`;
        select.appendChild(opt);
        input.onmidimessage = (msg) => {
          if (STATE.viewMode !== 'performer') return;
          if (selectedMidiInputId && input.id !== selectedMidiInputId) return;
          handleHardwareMIDIMessage(msg, input.name);
        };
      }
      badge.textContent = count > 0 ? `${count} MIDI Connected` : 'No USB MIDI (Ready)';
    };

    midiAccess.onstatechange = updateInputs;
    updateInputs();
    select.addEventListener('change', () => {
      selectedMidiInputId = select.value;
    });
  } catch (err) {
    logEl.textContent = `MIDI access unavailable: ${err.message}`;
  }
}

function handleHardwareMIDIMessage(event, deviceName) {
  const [status, data1, data2] = event.data;
  const cmd = status & 0xf0;
  const logEl = document.getElementById('midi-log');

  if (cmd === 0x90 && data2 > 0) {
    const vel = data2 / 127;
    triggerNoteOn(data1, vel);
    if (logEl) logEl.textContent = `${deviceName || 'MIDI'}: Note On ${midiToNoteName(data1)} (vel ${data2})`;
  } else if (cmd === 0x80 || (cmd === 0x90 && data2 === 0)) {
    triggerNoteOff(data1);
  } else if (cmd === 0xb0 && data1 === 64) {
    STATE.sustainPedal = data2 >= 64;
    if (!STATE.sustainPedal) {
      for (const midi of synth.voices.keys()) {
        if (!STATE.activeNotes.has(midi)) synth.noteOff(midi);
      }
    }
  }
}

// ============================================================================
// 10. DUAL-WEBCAM 3D BODY & FACE TRACKING (FRONT CAM + SIDE PROFILE CAM)
// ============================================================================
let visionFileset = null;
let visionModule = null;
let poseLandmarkerFront = null;
let faceLandmarkerFront = null;
let poseLandmarkerSide = null;
let webcamStreamFront = null;
let webcamStreamSide = null;
let lastFrontDetectTs = 0;
let lastSideDetectTs = 0;

// Raw uncalibrated measurements and user-zeroed neutral sitting baseline
const rawWebcamPose = {
  frontYaw: 0,
  frontPitch: 0,
  frontRoll: 0,
  frontSway: 0,
  frontLean: 0,
  frontShL: 0,
  frontShR: 0,
  frontElbL: 0,
  frontElbR: 0,
  sideLean: 0,
  sideArch: 0,
  sidePitch: 0,
  sideArmReach: 0,
  sideValid: false,
  sideLastSeen: -Infinity,
};

const webcamNeutralOffset = {
  frontYaw: 0,
  frontPitch: 0,
  frontRoll: 0,
  frontSway: 0,
  frontLean: 0,
  frontShL: 0,
  frontShR: 0,
  frontElbL: 0,
  frontElbR: 0,
  sideLean: 0,
  sideArch: 0,
  sidePitch: 0,
  sideArmReach: 0,
};

async function populateVideoInputs() {
  const frontSel = document.getElementById('webcam-front-select');
  const sideSel = document.getElementById('webcam-side-select');
  if (!frontSel || !sideSel || !navigator.mediaDevices?.enumerateDevices) return;

  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cams = devices.filter((d) => d.kind === 'videoinput');
    const prevFront = frontSel.value;
    const prevSide = sideSel.value;

    frontSel.innerHTML = '<option value="">Front Cam: Default Camera</option>';
    sideSel.innerHTML = '<option value="">Side Cam: None (1-Cam Mode)</option>';
    if (cams.length >= 2) {
      const autoOpt = document.createElement('option');
      autoOpt.value = '__auto_second__';
      autoOpt.textContent = 'Side Cam: Auto-Select 2nd Webcam';
      sideSel.appendChild(autoOpt);
    }

    cams.forEach((cam, idx) => {
      const label = cam.label || `Webcam ${idx + 1}`;
      const optF = document.createElement('option');
      optF.value = cam.deviceId;
      optF.textContent = `Front: ${label}`;
      frontSel.appendChild(optF);

      const optS = document.createElement('option');
      optS.value = cam.deviceId;
      optS.textContent = `Side: ${label}`;
      sideSel.appendChild(optS);
    });

    if (prevFront && Array.from(frontSel.options).some((o) => o.value === prevFront)) {
      frontSel.value = prevFront;
    }
    if (prevSide && Array.from(sideSel.options).some((o) => o.value === prevSide)) {
      sideSel.value = prevSide;
    } else if (!prevSide && cams.length >= 2) {
      sideSel.value = '__auto_second__';
    }
  } catch (err) {
    console.warn('Could not enumerate video devices:', err);
  }
}

function calibrateNeutralPosture() {
  for (const k of Object.keys(webcamNeutralOffset)) {
    if (typeof rawWebcamPose[k] === 'number') {
      webcamNeutralOffset[k] = rawWebcamPose[k];
    }
  }
  STATE.pose.yaw = 0;
  STATE.pose.pitch = 0;
  STATE.pose.roll = 0;
  STATE.pose.sway = 0;
  STATE.pose.lean = 0;
  STATE.pose.arch = 0;
  STATE.pose.shoulderL = 0;
  STATE.pose.shoulderR = 0;
  STATE.pose.elbowL = 0;
  STATE.pose.elbowR = 0;
  for (const [id, val] of [
    ['sl-yaw', 0],
    ['sl-pitch', 0],
    ['sl-sway', 0],
    ['sl-lean', 0],
    ['sl-arch', 0],
  ]) {
    const el = document.getElementById(id);
    if (el) el.value = val;
  }
}

function stopWebcamStreams() {
  if (webcamStreamFront) {
    webcamStreamFront.getTracks().forEach((t) => t.stop());
    webcamStreamFront = null;
  }
  if (webcamStreamSide) {
    webcamStreamSide.getTracks().forEach((t) => t.stop());
    webcamStreamSide = null;
  }
  rawWebcamPose.sideValid = false;
}

async function ensureVisionModelsLoaded(needSidePose) {
  if (!visionModule || !visionFileset) {
    visionModule = await import('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14');
    visionFileset = await visionModule.FilesetResolver.forVisionTasks(
      'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm'
    );
  }
  if (!poseLandmarkerFront) {
    poseLandmarkerFront = await visionModule.PoseLandmarker.createFromOptions(visionFileset, {
      baseOptions: {
        modelAssetPath:
          'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
        delegate: 'GPU',
      },
      runningMode: 'VIDEO',
      numPoses: 1,
    });
  }
  if (!faceLandmarkerFront) {
    faceLandmarkerFront = await visionModule.FaceLandmarker.createFromOptions(visionFileset, {
      baseOptions: {
        modelAssetPath:
          'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
        delegate: 'GPU',
      },
      runningMode: 'VIDEO',
      outputFaceBlendshapes: true,
      numFaces: 1,
    });
  }
  if (needSidePose && !poseLandmarkerSide) {
    poseLandmarkerSide = await visionModule.PoseLandmarker.createFromOptions(visionFileset, {
      baseOptions: {
        modelAssetPath:
          'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
        delegate: 'GPU',
      },
      runningMode: 'VIDEO',
      numPoses: 1,
    });
  }
}

async function startOrRestartWebcamStreams() {
  const btn = document.getElementById('btn-webcam');
  const pipFront = document.getElementById('webcam-pip');
  const pipSide = document.getElementById('webcam-pip-side');
  const videoFront = document.getElementById('webcam-video');
  const videoSide = document.getElementById('webcam-video-side');
  const frontSel = document.getElementById('webcam-front-select');
  const sideSel = document.getElementById('webcam-side-select');
  const fpsEl = document.getElementById('webcam-fps');

  stopWebcamStreams();

  const frontDeviceId = frontSel ? frontSel.value : '';
  const frontConstraints = {
    video: frontDeviceId
      ? { deviceId: { exact: frontDeviceId }, width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } }
      : { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } },
    audio: false,
  };

  webcamStreamFront = await navigator.mediaDevices.getUserMedia(frontConstraints);
  videoFront.srcObject = webcamStreamFront;
  await videoFront.play();
  pipFront.classList.add('visible');

  // Refresh device labels now that camera permission has been granted
  await populateVideoInputs();

  // Determine if a 2nd Side Profile camera is requested
  const activeFrontTrack = webcamStreamFront.getVideoTracks()[0];
  const activeFrontDevId = activeFrontTrack?.getSettings?.()?.deviceId || frontDeviceId;
  let sideDeviceId = sideSel ? sideSel.value : '';

  if (sideDeviceId === '__auto_second__') {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const otherCam = devices.find((d) => d.kind === 'videoinput' && d.deviceId && d.deviceId !== activeFrontDevId);
    sideDeviceId = otherCam ? otherCam.deviceId : '';
  }

  let hasSideCam = false;
  if (sideDeviceId && sideDeviceId !== activeFrontDevId) {
    try {
      webcamStreamSide = await navigator.mediaDevices.getUserMedia({
        video: {
          deviceId: { exact: sideDeviceId },
          width: { ideal: 640 },
          height: { ideal: 480 },
          frameRate: { ideal: 30 },
        },
        audio: false,
      });
      videoSide.srcObject = webcamStreamSide;
      await videoSide.play();
      pipSide.classList.add('visible');
      hasSideCam = true;
    } catch (sideErr) {
      console.warn('Side profile webcam could not be opened, continuing with Front Cam:', sideErr);
      pipSide.classList.remove('visible');
    }
  } else {
    pipSide.classList.remove('visible');
  }

  btn.textContent = '⏳ Loading MediaPipe Vision…';
  await ensureVisionModelsLoaded(hasSideCam);

  STATE.webcamActive = true;
  btn.classList.add('active');
  btn.textContent = hasSideCam ? '⏹ Stop Dual-Cam (Front+Side)' : '⏹ Stop Webcam Tracking';
  fpsEl.textContent = hasSideCam ? '2 Cams Active' : '1 Cam Active';
}

async function toggleWebcamTracking() {
  const btn = document.getElementById('btn-webcam');
  const pipFront = document.getElementById('webcam-pip');
  const pipSide = document.getElementById('webcam-pip-side');
  const fpsEl = document.getElementById('webcam-fps');

  if (STATE.webcamActive) {
    STATE.webcamActive = false;
    stopWebcamStreams();
    pipFront.classList.remove('visible');
    if (pipSide) pipSide.classList.remove('visible');
    btn.classList.remove('active');
    btn.textContent = '📷 Start Tracking';
    fpsEl.textContent = 'Off';
    return;
  }

  try {
    await startOrRestartWebcamStreams();
    runWebcamLoop();
  } catch (err) {
    console.error('Webcam tracking error:', err);
    STATE.webcamActive = false;
    stopWebcamStreams();
    btn.classList.remove('active');
    btn.textContent = '📷 Start Tracking';
    fpsEl.textContent = 'Camera blocked';
  }
}

function runWebcamLoop() {
  const videoFront = document.getElementById('webcam-video');
  const canvasFront = document.getElementById('webcam-canvas');
  const ctxFront = canvasFront.getContext('2d');
  const labelFront = document.getElementById('webcam-label');

  const videoSide = document.getElementById('webcam-video-side');
  const canvasSide = document.getElementById('webcam-canvas-side');
  const ctxSide = canvasSide ? canvasSide.getContext('2d') : null;
  const labelSide = document.getElementById('webcam-label-side');
  const sideOrientSel = document.getElementById('webcam-side-orient');

  const fpsEl = document.getElementById('webcam-fps');
  let lastFrontVideoTime = -1;
  let lastSideVideoTime = -1;
  let lastFrameTs = performance.now();

  function step() {
    if (!STATE.webcamActive) return;
    const now = performance.now();
    let updatedAny = false;

    // -------------------------------------------------------------------------
    // A. FRONT CAMERA: Coronal Yaw, Roll, Sway, Shoulders, Elbows & Face/Jaw
    // -------------------------------------------------------------------------
    if (videoFront && videoFront.readyState >= 2 && videoFront.currentTime !== lastFrontVideoTime) {
      lastFrontVideoTime = videoFront.currentTime;
      updatedAny = true;
      canvasFront.width = videoFront.videoWidth || 320;
      canvasFront.height = videoFront.videoHeight || 240;
      ctxFront.clearRect(0, 0, canvasFront.width, canvasFront.height);

      const detectTs = Math.max(Math.floor(now), lastFrontDetectTs + 1);
      lastFrontDetectTs = detectTs;

      const poseRes = poseLandmarkerFront ? poseLandmarkerFront.detectForVideo(videoFront, detectTs) : null;
      const faceRes = faceLandmarkerFront ? faceLandmarkerFront.detectForVideo(videoFront, detectTs) : null;

      if (poseRes?.landmarks?.length > 0) {
        const lm = poseRes.landmarks[0];
        Object.assign(STATE.pose,captureArmPose(lm,poseRes.worldLandmarks?.[0]));
        STATE.lastTrackedPoseAt=now;
        const nose = lm[0];
        const lEar = lm[7];
        const rEar = lm[8];
        const lSh = lm[11];
        const rSh = lm[12];
        const lElb = lm[13];
        const rElb = lm[14];

        if (lSh && rSh && nose && (lSh.visibility ?? 1) > .6 && (rSh.visibility ?? 1) > .6) {
          const midShX = (lSh.x + rSh.x) * 0.5;
          const midShY = (lSh.y + rSh.y) * 0.5;
          const shWidth = Math.max(0.12, Math.abs(lSh.x - rSh.x));

          const hipsVisible = lm[23]?.visibility > .65 && lm[24]?.visibility > .65;
          const hipX = hipsVisible ? (lm[23].x + lm[24].x) * .5 : .5;
          const hipY = hipsVisible ? (lm[23].y + lm[24].y) * .5 : midShY + shWidth;
          rawWebcamPose.frontSway = THREE.MathUtils.clamp(Math.atan2(hipX-midShX, Math.max(.1,hipY-midShY))*180/Math.PI, -18,18);
          rawWebcamPose.frontLean = THREE.MathUtils.clamp((shWidth - 0.42) * 45, -12, 18);
          rawWebcamPose.frontYaw = THREE.MathUtils.clamp(((nose.x - midShX) / shWidth) * -95, -40, 40);
          rawWebcamPose.frontPitch = THREE.MathUtils.clamp(
            ((nose.y - (midShY - shWidth * 0.52)) / shWidth) * 75,
            -25,
            30
          );
          rawWebcamPose.frontRoll =
            lEar && rEar ? THREE.MathUtils.clamp((lEar.y - rEar.y) * 65, -22, 22) : 0;

          // Independent shoulder shrug/drop relative to neck-shoulder span
          rawWebcamPose.frontShL = THREE.MathUtils.clamp((midShY - lSh.y) / shWidth * 55, -10, 14);
          rawWebcamPose.frontShR = THREE.MathUtils.clamp((midShY - rSh.y) / shWidth * 55, -10, 14);

          // Frontal elbow abduction / flare angle
          if (lElb) {
            const abductionL = (Math.abs(lElb.x - lSh.x) / shWidth - 0.36) * 42;
            rawWebcamPose.frontElbL = THREE.MathUtils.clamp(abductionL, -15, 18);
          }
          if (rElb) {
            const abductionR = (Math.abs(rElb.x - rSh.x) / shWidth - 0.36) * 42;
            rawWebcamPose.frontElbR = THREE.MathUtils.clamp(abductionR, -15, 18);
          }

          // Draw coronal skeleton on Front PiP
          ctxFront.strokeStyle = '#38bdf8';
          ctxFront.lineWidth = 3;
          ctxFront.beginPath();
          ctxFront.moveTo(lSh.x * canvasFront.width, lSh.y * canvasFront.height);
          ctxFront.lineTo(rSh.x * canvasFront.width, rSh.y * canvasFront.height);
          if (lElb) {
            ctxFront.moveTo(lSh.x * canvasFront.width, lSh.y * canvasFront.height);
            ctxFront.lineTo(lElb.x * canvasFront.width, lElb.y * canvasFront.height);
          }
          if (rElb) {
            ctxFront.moveTo(rSh.x * canvasFront.width, rSh.y * canvasFront.height);
            ctxFront.lineTo(rElb.x * canvasFront.width, rElb.y * canvasFront.height);
          }
          ctxFront.stroke();

          ctxFront.fillStyle = '#f59e0b';
          for (const pt of [nose, lSh, rSh, lElb, rElb].filter(Boolean)) {
            ctxFront.beginPath();
            ctxFront.arc(pt.x * canvasFront.width, pt.y * canvasFront.height, 4.5, 0, Math.PI * 2);
            ctxFront.fill();
          }
        }
      }

      if (faceRes?.faceLandmarks?.length > 0) {
        const scores = Object.fromEntries((faceRes.faceBlendshapes?.[0]?.categories || []).map(c => [c.categoryName,c.score]));
        const hasEyes = Number.isFinite(scores.eyeBlinkLeft) && Number.isFinite(scores.eyeBlinkRight);
        STATE.pose.eyeTracking = hasEyes ? 1 : 0;
        if (hasEyes) {
          STATE.lastEyeCaptureAt = now;
          STATE.pose.eyeBlinkLeft = THREE.MathUtils.clamp(scores.eyeBlinkLeft, 0, 1);
          STATE.pose.eyeBlinkRight = THREE.MathUtils.clamp(scores.eyeBlinkRight, 0, 1);
        }
        STATE.pose.smile = ((scores.mouthSmileLeft || 0) + (scores.mouthSmileRight || 0)) * .5;
        STATE.pose.frown = Math.max(((scores.browDownLeft || 0) + (scores.browDownRight || 0)) * .5, ((scores.mouthFrownLeft || 0) + (scores.mouthFrownRight || 0)) * .5);
        STATE.pose.browRaise = scores.browInnerUp || 0;
        const flm = faceRes.faceLandmarks[0];
        const upLip = flm[13];
        const lowLip = flm[14];
        if (upLip && lowLip) {
          const openRatio = Math.max(0, (lowLip.y - upLip.y) * 14);
          STATE.pose.jaw = Math.min(1, openRatio);
        }
      }
    }

    // -------------------------------------------------------------------------
    // B. SIDE PROFILE CAMERA: True Sagittal Spine Lean, Upper-Back Arch & Pitch
    // -------------------------------------------------------------------------
    const sideActive = Boolean(webcamStreamSide && videoSide && videoSide.readyState >= 2);
    if (sideActive && videoSide.currentTime !== lastSideVideoTime) {
      lastSideVideoTime = videoSide.currentTime;
      updatedAny = true;
      canvasSide.width = videoSide.videoWidth || 320;
      canvasSide.height = videoSide.videoHeight || 240;
      ctxSide.clearRect(0, 0, canvasSide.width, canvasSide.height);

      const detectSideTs = Math.max(Math.floor(now), lastSideDetectTs + 1);
      lastSideDetectTs = detectSideTs;

      const sideRes = poseLandmarkerSide ? poseLandmarkerSide.detectForVideo(videoSide, detectSideTs) : null;
      if (sideRes?.landmarks?.length > 0) {
        const lm = sideRes.landmarks[0];
        const nose = lm[0];
        const lEar = lm[7];
        const rEar = lm[8];
        const lSh = lm[11];
        const rSh = lm[12];
        const lElb = lm[13];
        const rElb = lm[14];
        const lHip = lm[23];
        const rHip = lm[24];

        if (lSh && rSh && nose && (lSh.visibility ?? 1) > .6 && (rSh.visibility ?? 1) > .6) {
          // Pick weighted or midpoint shoulder/ear/hip in the sagittal view
          const wL = (lSh.visibility ?? 0.5) >= (rSh.visibility ?? 0.5) ? 0.7 : 0.3;
          const wR = 1 - wL;
          const shX = lSh.x * wL + rSh.x * wR;
          const shY = lSh.y * wL + rSh.y * wR;

          const earX = lEar && rEar ? lEar.x * wL + rEar.x * wR : nose.x;
          const earY = lEar && rEar ? lEar.y * wL + rEar.y * wR : nose.y;

          // Determine which horizontal image direction is "Forward toward the piano"
          const orientMode = sideOrientSel ? sideOrientSel.value : 'auto';
          let facingDir = 1;
          if (orientMode === 'left') {
            facingDir = -1; // Note: video CSS is scaleX(-1), raw image x direction
          } else if (orientMode === 'right') {
            facingDir = 1;
          } else {
            facingDir = nose.x >= shX ? 1 : -1;
          }

          // 1. True Sagittal Torso Forward Lean (Hip -> Shoulder vector, or Shoulder horizontal depth)
          const hipVis = Math.max(lHip?.visibility ?? 0, rHip?.visibility ?? 0);
          let hipX = shX;
          let hipY = Math.min(0.95, shY + 0.36);
          if (lHip && rHip && hipVis > 0.3) {
            hipX = lHip.x * wL + rHip.x * wR;
            hipY = lHip.y * wL + rHip.y * wR;
            const dySpine = Math.max(0.12, hipY - shY);
            const dxForward = (shX - hipX) * facingDir;
            rawWebcamPose.sideLean = THREE.MathUtils.clamp(
              THREE.MathUtils.radToDeg(Math.atan2(dxForward * canvasSide.width / canvasSide.height, dySpine)),
              -45,
              55
            );
          } else {
            // Upper-body framing fallback: track horizontal shoulder displacement toward piano
            rawWebcamPose.sideLean = THREE.MathUtils.clamp((shX - 0.5) * facingDir * 52, -15, 22);
          }

          // 2. Sagittal Upper-Back Arch / Neck Protraction (Shoulder -> Ear angle minus lower spine lean)
          const aspect = canvasSide.width / canvasSide.height;
          const dyNeck = Math.max(0.06, shY - earY);
          const dxNeckForward = (earX - shX) * facingDir;
          const neckProtractionDeg = THREE.MathUtils.radToDeg(Math.atan2(dxNeckForward * aspect, dyNeck)) - 10;
          rawWebcamPose.sideArch = THREE.MathUtils.clamp(
            neckProtractionDeg - rawWebcamPose.sideLean * 0.45,
            -35,
            45
          );

          // 3. True Sagittal Head Pitch (Ear -> Nose inclination)
          const dxHead = Math.max(0.04, Math.abs(nose.x - earX));
          const dyHead = nose.y - earY;
          rawWebcamPose.sidePitch = THREE.MathUtils.clamp(
            THREE.MathUtils.radToDeg(Math.atan2(dyHead, dxHead * aspect)) - 6,
            -60,
            65
          );

          // 4. Sagittal Upper-Arm Reach (Shoulder -> Elbow forward angle)
          const elb = (lElb?.visibility ?? 0) >= (rElb?.visibility ?? 0) ? lElb : rElb;
          if (elb) {
            const dyArm = Math.max(0.08, elb.y - shY);
            const dxArm = (elb.x - shX) * facingDir;
            rawWebcamPose.sideArmReach = THREE.MathUtils.clamp(
              (THREE.MathUtils.radToDeg(Math.atan2(dxArm, dyArm)) - 18) * 0.45,
              -12,
              15
            );
          }

          rawWebcamPose.sideValid = true; rawWebcamPose.sideLastSeen=now;

          // Draw Sagittal Spine, Neck, Head & Arm vectors on Side PiP
          ctxSide.strokeStyle = '#34d399';
          ctxSide.lineWidth = 3;
          ctxSide.beginPath();
          ctxSide.moveTo(hipX * canvasSide.width, hipY * canvasSide.height);
          ctxSide.lineTo(shX * canvasSide.width, shY * canvasSide.height);
          ctxSide.lineTo(earX * canvasSide.width, earY * canvasSide.height);
          ctxSide.lineTo(nose.x * canvasSide.width, nose.y * canvasSide.height);
          if (elb) {
            ctxSide.moveTo(shX * canvasSide.width, shY * canvasSide.height);
            ctxSide.lineTo(elb.x * canvasSide.width, elb.y * canvasSide.height);
          }
          ctxSide.stroke();

          ctxSide.fillStyle = '#f59e0b';
          for (const pt of [
            { x: hipX, y: hipY },
            { x: shX, y: shY },
            { x: earX, y: earY },
            nose,
            elb,
          ].filter(Boolean)) {
            ctxSide.beginPath();
            ctxSide.arc(pt.x * canvasSide.width, pt.y * canvasSide.height, 4.5, 0, Math.PI * 2);
            ctxSide.fill();
          }
        }
      }
    }

    // -------------------------------------------------------------------------
    // C. FUSE FRONT + SIDE CAMERA READINGS & BROADCAST TO STAGE
    // -------------------------------------------------------------------------
    if (updatedAny) {
      const cYaw = rawWebcamPose.frontYaw - webcamNeutralOffset.frontYaw;
      const cRoll = rawWebcamPose.frontRoll - webcamNeutralOffset.frontRoll;
      const cSway = rawWebcamPose.frontSway - webcamNeutralOffset.frontSway;
      const cFrontPitch = rawWebcamPose.frontPitch - webcamNeutralOffset.frontPitch;
      const cFrontLean = rawWebcamPose.frontLean - webcamNeutralOffset.frontLean;
      const cShL = rawWebcamPose.frontShL - webcamNeutralOffset.frontShL;
      const cShR = rawWebcamPose.frontShR - webcamNeutralOffset.frontShR;
      const cElbL = rawWebcamPose.frontElbL - webcamNeutralOffset.frontElbL;
      const cElbR = rawWebcamPose.frontElbR - webcamNeutralOffset.frontElbR;

      let fusedLean = cFrontLean;
      let fusedPitch = cFrontPitch;
      let fusedArch = 0;
      let armReachDelta = 0;

      if (sideActive && rawWebcamPose.sideValid && now-rawWebcamPose.sideLastSeen<350) {
        const cSideLean = rawWebcamPose.sideLean - webcamNeutralOffset.sideLean;
        const cSideArch = rawWebcamPose.sideArch - webcamNeutralOffset.sideArch;
        const cSidePitch = rawWebcamPose.sidePitch - webcamNeutralOffset.sidePitch;
        armReachDelta = rawWebcamPose.sideArmReach - webcamNeutralOffset.sideArmReach;

        // Fuse Side Cam's true sagittal depth with Front Cam
        fusedLean = cSideLean * 0.95 + cFrontLean * 0.05;
        fusedPitch = cSidePitch * 0.95 + cFrontPitch * 0.05;
        fusedArch = cSideArch;
      }

      STATE.pose.yaw = THREE.MathUtils.clamp(cYaw, -35, 35);
      STATE.pose.pitch = THREE.MathUtils.clamp(fusedPitch * Math.sqrt(Number(document.getElementById('motion-gain')?.value || 1.5)), -42, 48);
      STATE.pose.roll = THREE.MathUtils.clamp(cRoll, -20, 20);
      const movement=Number(document.getElementById('motion-gain')?.value||1.5);
      STATE.pose.sway = THREE.MathUtils.clamp(cSway*movement, -32, 32);
      STATE.pose.lean = THREE.MathUtils.clamp(fusedLean*movement, -24, 32);
      STATE.pose.arch = THREE.MathUtils.clamp(fusedArch*movement, -18, 24);
      STATE.pose.shoulderL = THREE.MathUtils.clamp(cShL*movement, -18, 22);
      STATE.pose.shoulderR = THREE.MathUtils.clamp(cShR*movement, -18, 22);
      STATE.pose.elbowL = THREE.MathUtils.clamp(cElbL + armReachDelta * 0.5, -15, 15);
      STATE.pose.elbowR = THREE.MathUtils.clamp(cElbR + armReachDelta * 0.5, -15, 15);

      document.getElementById('sl-yaw').value = Math.round(STATE.pose.yaw);
      document.getElementById('sl-pitch').value = Math.round(STATE.pose.pitch);
      document.getElementById('sl-sway').value = Math.round(STATE.pose.sway);
      document.getElementById('sl-lean').value = Math.round(STATE.pose.lean);
      const slArch = document.getElementById('sl-arch');
      if (slArch) slArch.value = Math.round(STATE.pose.arch);

      if (labelFront) {
        labelFront.textContent = `Front: Yaw ${Math.round(STATE.pose.yaw)}° · Sway ${Math.round(STATE.pose.sway)}°`;
      }
      if (labelSide && sideActive) {
        labelSide.textContent = `Side: Lean ${Math.round(STATE.pose.lean)}° · Arch ${Math.round(STATE.pose.arch)}° · Pitch ${Math.round(STATE.pose.pitch)}°`;
      }

      if(now-STATE.lastEyeCaptureAt>250) STATE.pose.eyeTracking=0;
      if(now-STATE.lastTrackedPoseAt>350){STATE.pose.armLConfidence=0;STATE.pose.armRConfidence=0;}
      if (STATE.role === 'performer') {
        broadcastWS({
          type: 'pose',
          pose: {
            ...Object.fromEntries(ARM_FIELDS.map(k=>[k,Number((STATE.pose[k]||0).toFixed(4))])),
            yaw: Number(STATE.pose.yaw.toFixed(1)),
            pitch: Number(STATE.pose.pitch.toFixed(1)),
            roll: Number(STATE.pose.roll.toFixed(1)),
            sway: Number(STATE.pose.sway.toFixed(1)),
            lean: Number(STATE.pose.lean.toFixed(1)),
            arch: Number(STATE.pose.arch.toFixed(1)),
            shoulderL: Number(STATE.pose.shoulderL.toFixed(1)),
            shoulderR: Number(STATE.pose.shoulderR.toFixed(1)),
            elbowL: Number(STATE.pose.elbowL.toFixed(1)),
            elbowR: Number(STATE.pose.elbowR.toFixed(1)),
            jaw: Number(STATE.pose.jaw.toFixed(2)),
            smile: Number(STATE.pose.smile.toFixed(2)),
            frown: Number(STATE.pose.frown.toFixed(2)),
            browRaise: Number(STATE.pose.browRaise.toFixed(2)),
            eyeBlinkLeft: Number(STATE.pose.eyeBlinkLeft.toFixed(4)),
            eyeBlinkRight: Number(STATE.pose.eyeBlinkRight.toFixed(4)),
            eyeTracking: STATE.pose.eyeTracking,
          },
        });
      }

      const fps = Math.round(1000 / Math.max(16, now - lastFrameTs));
      lastFrameTs = now;
      fpsEl.textContent = `${sideActive ? '2-Cam' : '1-Cam'} · ${fps} FPS`;
    }

    requestAnimationFrame(step);
  }

  requestAnimationFrame(step);
}

// ============================================================================
// 11. BUILT-IN TWO-HANDED CONCERT DEMO SEQUENCER (PERFORMER STUDIO)
// ============================================================================
const DEMO_SCORE = [
  { beat: 0.0,  notes: [{ m: 36, v: 0.78, d: 1.8 }, { m: 48, v: 0.72, d: 0.9 }, { m: 67, v: 0.85, d: 0.9 }] },
  { beat: 0.5,  notes: [{ m: 55, v: 0.65, d: 0.45 }] },
  { beat: 1.0,  notes: [{ m: 60, v: 0.68, d: 0.8 }, { m: 72, v: 0.88, d: 0.95 }] },
  { beat: 1.5,  notes: [{ m: 55, v: 0.62, d: 0.45 }] },
  { beat: 2.0,  notes: [{ m: 43, v: 0.74, d: 1.8 }, { m: 63, v: 0.75, d: 0.9 }, { m: 75, v: 0.92, d: 0.95 }] },
  { beat: 2.5,  notes: [{ m: 55, v: 0.64, d: 0.45 }] },
  { beat: 3.0,  notes: [{ m: 74, v: 0.82, d: 0.45 }] },
  { beat: 3.5,  notes: [{ m: 72, v: 0.78, d: 0.45 }] },

  { beat: 4.0,  notes: [{ m: 29, v: 0.82, d: 1.9 }, { m: 41, v: 0.76, d: 1.0 }, { m: 68, v: 0.88, d: 0.95 }, { m: 77, v: 0.9, d: 0.95 }] },
  { beat: 4.5,  notes: [{ m: 53, v: 0.66, d: 0.45 }] },
  { beat: 5.0,  notes: [{ m: 56, v: 0.70, d: 0.8 }, { m: 75, v: 0.84, d: 0.45 }] },
  { beat: 5.5,  notes: [{ m: 72, v: 0.80, d: 0.45 }] },
  { beat: 6.0,  notes: [{ m: 31, v: 0.84, d: 1.9 }, { m: 43, v: 0.78, d: 1.0 }, { m: 62, v: 0.76, d: 0.9 }, { m: 71, v: 0.86, d: 0.9 }, { m: 79, v: 0.92, d: 0.95 }] },
  { beat: 6.5,  notes: [{ m: 55, v: 0.68, d: 0.45 }] },
  { beat: 7.0,  notes: [{ m: 77, v: 0.82, d: 0.45 }] },
  { beat: 7.5,  notes: [{ m: 74, v: 0.78, d: 0.45 }] },

  { beat: 8.0,  notes: [{ m: 24, v: 0.88, d: 1.9 }, { m: 36, v: 0.84, d: 1.9 }, { m: 60, v: 0.82, d: 0.45 }, { m: 72, v: 0.9, d: 0.45 }] },
  { beat: 8.5,  notes: [{ m: 48, v: 0.72, d: 0.45 }, { m: 75, v: 0.86, d: 0.45 }] },
  { beat: 9.0,  notes: [{ m: 55, v: 0.74, d: 0.45 }, { m: 79, v: 0.90, d: 0.45 }] },
  { beat: 9.5,  notes: [{ m: 63, v: 0.76, d: 0.45 }, { m: 84, v: 0.94, d: 0.65 }] },
  { beat: 10.0, notes: [{ m: 39, v: 0.80, d: 1.8 }, { m: 51, v: 0.76, d: 1.8 }, { m: 82, v: 0.88, d: 0.45 }] },
  { beat: 10.5, notes: [{ m: 79, v: 0.84, d: 0.45 }] },
  { beat: 11.0, notes: [{ m: 75, v: 0.82, d: 0.45 }] },
  { beat: 11.5, notes: [{ m: 70, v: 0.78, d: 0.45 }] },

  { beat: 12.0, notes: [{ m: 32, v: 0.85, d: 1.8 }, { m: 44, v: 0.80, d: 1.8 }, { m: 63, v: 0.84, d: 0.9 }, { m: 68, v: 0.86, d: 0.9 }, { m: 75, v: 0.90, d: 0.9 }] },
  { beat: 13.0, notes: [{ m: 31, v: 0.82, d: 0.9 }, { m: 55, v: 0.76, d: 0.9 }, { m: 67, v: 0.84, d: 0.9 }, { m: 74, v: 0.88, d: 0.9 }] },
  { beat: 14.0, notes: [{ m: 24, v: 0.92, d: 1.9 }, { m: 36, v: 0.88, d: 1.9 }, { m: 48, v: 0.84, d: 1.9 }, { m: 60, v: 0.86, d: 1.9 }, { m: 67, v: 0.88, d: 1.9 }, { m: 72, v: 0.94, d: 1.9 }] },
];

let demoTimer = null;
let demoTimeouts = [];

function toggleConcertDemo() {
  const btn = document.getElementById('btn-demo');
  if (STATE.demoPlaying) {
    stopConcertDemo();
    return;
  }

  STATE.demoPlaying = true;
  btn.textContent = '⏹ Stop Concert Demo';
  btn.classList.add('active');

  const bpm = 92;
  const secPerBeat = 60 / bpm;
  const loopBeats = 16;

  function scheduleLoop() {
    if (!STATE.demoPlaying) return;
    for (const step of DEMO_SCORE) {
      const tOn = setTimeout(() => {
        if (!STATE.demoPlaying) return;
        for (const n of step.notes) {
          triggerNoteOn(n.m, n.v);
          const tOff = setTimeout(() => {
            triggerNoteOff(n.m);
          }, n.d * secPerBeat * 1000);
          demoTimeouts.push(tOff);
        }
      }, step.beat * secPerBeat * 1000);
      demoTimeouts.push(tOn);
    }
    demoTimer = setTimeout(scheduleLoop, loopBeats * secPerBeat * 1000);
  }

  scheduleLoop();
}

function stopConcertDemo() {
  STATE.demoPlaying = false;
  if (demoTimer) clearTimeout(demoTimer);
  demoTimeouts.forEach((t) => clearTimeout(t));
  demoTimeouts = [];
  clearAllActiveNotes();
  const btn = document.getElementById('btn-demo');
  if (btn) {
    btn.textContent = '▶ Play Two-Handed Concert Demo';
    btn.classList.remove('active');
  }
}

// ============================================================================
// 12. WEBSOCKET LIVE CONCERT SYNC, RECORDING & ARCHIVE API
// ============================================================================
let mediaRecorder = null;
let visitorMediaSource = null;
let visitorSourceBuffer = null;
let visitorAudioQueue = [];
let wsReconnectTimer = null;

function connectWebSocket() {
  clearTimeout(wsReconnectTimer);
  if (STATE.ws) {
    STATE.ws.onclose = null;
    STATE.ws.close();
  }
  STATE.wsConnected = false;
  STATE.performerAuthorized = false;
  const wsUrl = new URL('./ws', window.location.href).href.replace(/^http/, 'ws');
  const statusText = document.getElementById('ws-status-text');

  try {
    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';
    STATE.ws = ws;

    ws.onopen = () => {
      if (STATE.ws !== ws) return;
      STATE.wsConnected = true;
      statusText.textContent = 'Live Stage Connected';
      ws.send(JSON.stringify({ type: 'role', role: STATE.role }));
    };

    ws.onmessage = (event) => {
      if (STATE.ws !== ws) return;
      if (typeof event.data === 'string') {
        let msg;
        try { msg = JSON.parse(event.data); } catch { return; }
        if (msg.type === 'role_accepted' && msg.role === 'performer') {
          STATE.performerAuthorized = true;
          statusText.textContent = 'Performer Studio Connected';
        } else if (msg.type === 'auth_error') {
          returnToLobby();
          const errEl = document.getElementById('login-error');
          errEl.textContent = msg.error || 'Please sign in again';
          errEl.style.display = 'inline';
          return;
        }
        if (msg.type === 'room_state') {
          STATE.liveShowActive = Boolean(msg.liveShowActive);
          STATE.performerOnline = Boolean(msg.performerOnline);
          STATE.currentShowTitle = msg.currentShowTitle || 'Live Concert';
          STATE.visitorsCount = msg.visitors || 0;
          if (Array.isArray(msg.archives)) {
            STATE.archives = msg.archives;
          }
          renderLobbyAndArchiveUI();
          updateVisitorReplayUI();
        } else if (msg.type === 'show_saved') {
          if (Array.isArray(msg.archives)) {
            STATE.archives = msg.archives;
            renderLobbyAndArchiveUI();
          }
          const recStatus = document.getElementById('rec-status-line');
          if (recStatus && msg.session) {
            recStatus.textContent = `✅ Saved "${msg.session.title}" (${msg.session.noteCount} notes) to Archive!`;
            recStatus.style.color = '#86efac';
          }
        } else if (msg.type === 'midi' || msg.type === 'pose') {
          // If visitor is watching live (not replaying an archive), queue into 1.8s Look-Ahead Buffer!
          if (STATE.role === 'visitor' && !STATE.replay.active) {
            enqueueLiveVisitorEvent(msg);
          }
        }
      } else if (event.data instanceof ArrayBuffer) {
        if (STATE.role === 'visitor' && !STATE.replay.active) {
          setTimeout(() => appendVisitorAudioChunk(event.data), LOOKAHEAD_BUFFER_MS);
        }
      }
    };

    ws.onclose = () => {
      if (STATE.ws !== ws) return;
      STATE.wsConnected = false;
      STATE.performerAuthorized = false;
      if (STATE.role === 'performer') releasePerformerDevices();
      statusText.textContent = 'Reconnecting…';
      wsReconnectTimer = setTimeout(connectWebSocket, 2500);
    };
  } catch (err) {
    statusText.textContent = 'Local Mode';
  }
}

function broadcastWS(payload) {
  if (payload.type !== 'role' && !STATE.performerAuthorized) return;
  if (STATE.ws && STATE.ws.readyState === WebSocket.OPEN) {
    STATE.ws.send(JSON.stringify(payload));
  }
}

async function fetchArchivesAndStatus() {
  try {
    const resp = await fetch('./api/archives');
    if (!resp.ok) return;
    const data = await resp.json();
    STATE.liveShowActive = Boolean(data.liveShowActive);
    STATE.performerOnline = Boolean(data.performerOnline);
    STATE.currentShowTitle = data.currentShowTitle || 'Live Concert';
    STATE.visitorsCount = data.visitors || 0;
    STATE.archives = data.archives || [];
    renderLobbyAndArchiveUI();
  } catch (err) {
    console.error('Failed to fetch archives:', err);
  }
}

function renderLobbyAndArchiveUI() {
  const visitorsBadge = document.getElementById('visitors-badge');
  if (visitorsBadge) {
    visitorsBadge.textContent = `👥 ${STATE.visitorsCount} Visitors`;
  }

  // Update Landing Page Live Banner
  const banner = document.getElementById('lobby-live-banner');
  const titleEl = document.getElementById('lobby-live-title');
  const subEl = document.getElementById('lobby-live-sub');
  const enterBtn = document.getElementById('btn-enter-visitor');

  if (banner && titleEl && subEl && enterBtn) {
    if (STATE.liveShowActive) {
      banner.classList.remove('standby');
      titleEl.textContent = `🔴 LIVE SHOW ON AIR: ${STATE.currentShowTitle}`;
      subEl.textContent = `The pianist is performing live right now (${STATE.visitorsCount} visitors watching). Enter the stage to watch in 3D or VR with 1.8s look-ahead hand anticipation.`;
      enterBtn.textContent = '🔴 Join Live Concert Stage (Visitor / VR)';
    } else {
      banner.classList.add('standby');
      titleEl.innerHTML = `<span>🌙 Stage Standby — No Live Broadcast Right Now</span>`;
      subEl.textContent =
        'Enter the 3D stage to explore the concert piano, or select any recorded performance below to replay in 3D / VR.';
      enterBtn.textContent = '🏛️ Enter 3D Stage (Free View / VR)';
    }
  }

  // Populate Landing Page Archive Cards
  const grid = document.getElementById('archive-grid');
  const select = document.getElementById('visitor-archive-select');
  if (grid) {
    grid.innerHTML = '';
    for (const item of STATE.archives) {
      const card = document.createElement('div');
      card.className = 'archive-card';
      const dur = formatTimeMs(item.durationMs || 0);
      const audioTag = item.hasAudio ? '🎙️ Live Audio + MIDI + Pose' : '🎹 Synth + MIDI + Pose';
      const title = document.createElement('div');
      title.className = 'archive-card-title';
      title.textContent = item.title;
      const meta = document.createElement('div');
      meta.className = 'archive-meta';
      for (const label of [`📅 ${item.createdAt || 'Recorded'}`, `⏱ ${dur}`, `🎵 ${item.noteCount || 0} notes`, audioTag]) {
        const span = document.createElement('span');
        span.textContent = label;
        meta.appendChild(span);
      }
      const details = document.createElement('div');
      details.append(title, meta);
      const replayBtn = document.createElement('button');
      replayBtn.className = 'btn primary';
      replayBtn.style.cssText = 'width:100%; justify-content:center;';
      replayBtn.textContent = '▶ Replay Concert in 3D / VR';
      replayBtn.addEventListener('click', () => startArchiveReplay(item.id));
      card.append(details, replayBtn);
      grid.appendChild(card);
    }
  }

  if (select) {
    const currentId = STATE.replay.session ? STATE.replay.session.id : '';
    select.innerHTML = '<option value="">📼 Switch Archived Performance…</option>';
    if (STATE.liveShowActive) {
      const liveOpt = document.createElement('option');
      liveOpt.value = '__live__';
      liveOpt.textContent = `🔴 Watch Live: ${STATE.currentShowTitle}`;
      select.appendChild(liveOpt);
    }
    for (const item of STATE.archives) {
      const opt = document.createElement('option');
      opt.value = item.id;
      opt.textContent = `${item.title} (${formatTimeMs(item.durationMs || 0)})`;
      if (item.id === currentId) opt.selected = true;
      select.appendChild(opt);
    }
  }
}

// ============================================================================
// 13. PERFORMER LIVE BROADCAST & RECORDING CONTROLS
// ============================================================================
let showAudioRecorder = null;
let externalMicStream = null;
let pendingAudioChunkSends = [];
let audioSendChain=Promise.resolve();

function getSupportedRecorderMimeType() {
  if (!window.MediaRecorder) return '';
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
  ];
  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported(c)) return c;
  }
  return '';
}

function startUnifiedAudioRecorder() {
  if (showAudioRecorder && showAudioRecorder.state !== 'inactive') return;
  showAudioRecorder = null;
  pendingAudioChunkSends = [];

  const recStream = synth.getRecordingStream();
  if (!recStream || !window.MediaRecorder) return;

  try {
    const mimeType = getSupportedRecorderMimeType();
    const opts = mimeType ? { mimeType, audioBitsPerSecond: 128000 } : { audioBitsPerSecond: 128000 };
    const recorder = new MediaRecorder(recStream, opts);
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0 && STATE.performerAuthorized && STATE.ws && STATE.ws.readyState === WebSocket.OPEN) {
        const p = audioSendChain.then(()=>e.data.arrayBuffer()).then((buf) => {
          if (STATE.performerAuthorized && STATE.ws && STATE.ws.readyState === WebSocket.OPEN) {
            STATE.ws.send(buf);
          }
        }).catch(() => {});
        audioSendChain=p;
        pendingAudioChunkSends.push(p);
        p.finally(() => {
          const index = pendingAudioChunkSends.indexOf(p);
          if (index >= 0) pendingAudioChunkSends.splice(index, 1);
        });
      }
    };
    recorder.start(200);
    showAudioRecorder = recorder;
  } catch (err) {
    console.warn('Could not start unified show audio recorder:', err);
  }
}

async function stopUnifiedAudioRecorderAndFlush() {
  if (!showAudioRecorder || showAudioRecorder.state === 'inactive') {
    await Promise.allSettled(pendingAudioChunkSends);
    pendingAudioChunkSends = [];
    return;
  }
  await new Promise((resolve) => {
    const rec = showAudioRecorder;
    showAudioRecorder = null;
    const timeout = setTimeout(()=>{rec.ondataavailable=null;resolve();},3000);
    rec.addEventListener(
      'stop',
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true }
    );
    try {
      rec.stop();
    } catch (_) {
      clearTimeout(timeout);
      resolve();
    }
  });
  await Promise.allSettled(pendingAudioChunkSends);
  pendingAudioChunkSends = [];
}

async function toggleRecordShow() {
  if (!STATE.performerAuthorized) {
    document.getElementById('rec-status-line').textContent = 'Wait for the performer connection before starting a show.';
    return;
  }
  const btn = document.getElementById('btn-record-show');
  const titleInput = document.getElementById('show-title-input');
  const timerEl = document.getElementById('rec-timer');
  const recStatus = document.getElementById('rec-status-line');

  if (STATE.recordingShow) {
    STATE.recordingShow = false;
    if (STATE.recordTimerInterval) clearInterval(STATE.recordTimerInterval);
    btn.classList.remove('danger');
    btn.classList.add('primary');
    btn.textContent = '⏺ Start Live Show & Record to Archive';
    timerEl.textContent = 'Saving…';

    // Stop and flush final audio chunks BEFORE telling server to finalize the recording
    await stopUnifiedAudioRecorderAndFlush();
    broadcastWS({ type: 'stop_show' });
    timerEl.textContent = 'Saved';

    // If live external audio streaming is still toggled on, resume live streaming recorder
    if (STATE.micStreaming) {
      startUnifiedAudioRecorder();
    }
    return;
  }

  synth.ensureContext();
  const title = (titleInput.value || '').trim() || 'Live Studio Concert';
  btn.disabled=true;
  // Flush the previous monitor stream before the server opens the new recording.
  await stopUnifiedAudioRecorderAndFlush();
  btn.disabled=false;
  if(!STATE.performerAuthorized)return;
  STATE.recordingShow = true;
  STATE.recordStartTime = performance.now();
  broadcastWS({ type: 'start_show', title, hasRecordedSynth: true, motionVersion:2 });

  // Start fresh MediaRecorder at t=0 so chunk #0 includes the WebM EBML header & captures Synth + Mic
  startUnifiedAudioRecorder();

  btn.classList.remove('primary');
  btn.classList.add('danger');
  btn.textContent = '⏹ Stop Show & Save to Archive';
  recStatus.textContent = '🔴 Broadcasting live to visitors & recording synchronized Audio, MIDI, and Pose…';
  recStatus.style.color = '#fca5a5';

  if (STATE.recordTimerInterval) clearInterval(STATE.recordTimerInterval);
  STATE.recordTimerInterval = setInterval(() => {
    const elapsed = performance.now() - STATE.recordStartTime;
    timerEl.textContent = `🔴 REC ${formatTimeMs(elapsed)}`;
  }, 500);
}

async function populateAudioInputs() {
  const select = document.getElementById('audio-input-select');
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const audioInputs = devices.filter((d) => d.kind === 'audioinput');
    if (audioInputs.length > 0) {
      select.innerHTML = '';
      audioInputs.forEach((d, idx) => {
        const opt = document.createElement('option');
        opt.value = d.deviceId;
        opt.textContent = d.label || `Audio Input ${idx + 1} (Pianoteq / Interface)`;
        select.appendChild(opt);
      });
    }
  } catch (_) {}
}

async function toggleLiveAudioStream() {
  const btn = document.getElementById('btn-mic-stream');
  const statusEl = document.getElementById('audio-status');
  const select = document.getElementById('audio-input-select');

  if (STATE.micStreaming) {
    STATE.micStreaming = false;
    synth.detachExternalStream();
    if (externalMicStream) {
      externalMicStream.getTracks().forEach((t) => t.stop());
      externalMicStream = null;
    }
    if (!STATE.recordingShow && showAudioRecorder && showAudioRecorder.state !== 'inactive') {
      try {
        showAudioRecorder.stop();
      } catch (_) {}
      showAudioRecorder = null;
    }
    btn.classList.remove('active');
    btn.textContent = '🎙️ Stream Audio In';
    statusEl.textContent = STATE.synthEnabled ? 'Synth On' : 'Muted';
    return;
  }

  try {
    const constraints = {
      audio: {
        deviceId: select.value ? { exact: select.value } : undefined,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    externalMicStream = stream;
    await populateAudioInputs();

    // Attach external stream into the unified WebAudio recording bus (mixed with synth)
    synth.attachExternalStream(stream);
    if (!showAudioRecorder || showAudioRecorder.state === 'inactive') {
      startUnifiedAudioRecorder();
    }

    STATE.micStreaming = true;
    btn.classList.add('active');
    btn.textContent = '🔴 Streaming Audio Live';
    statusEl.textContent = 'Live Audio + Synth';
  } catch (err) {
    statusEl.textContent = 'Audio Input Denied';
  }
}

function appendVisitorAudioChunk(buffer) {
  if (!window.MediaSource || !MediaSource.isTypeSupported('audio/webm;codecs=opus')) return;
  if (!visitorMediaSource) {
    visitorMediaSource = new MediaSource();
    const audioEl = new Audio();
    audioEl.src = URL.createObjectURL(visitorMediaSource);
    audioEl.play().catch(() => {});
    visitorMediaSource.addEventListener('sourceopen', () => {
      visitorSourceBuffer = visitorMediaSource.addSourceBuffer('audio/webm;codecs=opus');
      visitorSourceBuffer.mode = 'sequence';
      visitorSourceBuffer.addEventListener('updateend', () => {
        if (visitorAudioQueue.length > 0 && !visitorSourceBuffer.updating) {
          visitorSourceBuffer.appendBuffer(visitorAudioQueue.shift());
        }
      });
    });
  }
  if (visitorSourceBuffer && !visitorSourceBuffer.updating) {
    try {
      visitorSourceBuffer.appendBuffer(buffer);
    } catch (_) {}
  } else {
    visitorAudioQueue.push(buffer);
  }
}

// ============================================================================
// 14. NAVIGATION & UI EVENT BINDINGS
// ============================================================================
function enterVisitorStage(autoPlayArchiveIfStandby = true) {
  if (STATE.role === 'performer') logoutPerformer();
  const entering=STATE.viewMode!=='visitor';
  STATE.viewMode = 'visitor';
  STATE.role = 'visitor';
  if(entering)setCameraPreset('stage');
  document.body.className = 'mode-visitor';
  synth.ensureContext();
  broadcastWS({ type: 'role', role: 'visitor' });

  // If no live show is currently active and no archive is playing yet, optionally start the featured archive
  if (autoPlayArchiveIfStandby && !STATE.liveShowActive && !STATE.replay.active && STATE.archives.length > 0) {
    startArchiveReplay(STATE.archives[0].id);
  } else {
    updateVisitorReplayUI();
  }
}

function releasePerformerDevices() {
  STATE.performerAuthorized = false;
  document.getElementById('ws-status-text').textContent = STATE.wsConnected ? 'Stage Connected' : 'Disconnected';
  STATE.recordingShow = false;
  clearInterval(STATE.recordTimerInterval);
  STATE.recordTimerInterval = null;
  if (showAudioRecorder && showAudioRecorder.state !== 'inactive') showAudioRecorder.stop();
  showAudioRecorder = null;
  STATE.webcamActive = false;
  stopWebcamStreams();
  STATE.micStreaming = false;
  synth.detachExternalStream();
  if (externalMicStream) externalMicStream.getTracks().forEach(track => track.stop());
  externalMicStream = null;
  document.getElementById('btn-mic-stream').textContent = '🎙️ Stream Audio In';
  document.getElementById('btn-mic-stream').classList.remove('active');
  document.getElementById('webcam-pip').classList.remove('visible');
  document.getElementById('webcam-pip-side')?.classList.remove('visible');
  document.getElementById('btn-webcam').textContent = '📷 Start Tracking';
  document.getElementById('btn-webcam').classList.remove('active');
  document.getElementById('btn-record-show').textContent = '⏺ Start Live Show & Record to Archive';
  document.getElementById('btn-record-show').classList.remove('danger');
  document.getElementById('btn-record-show').classList.add('primary');
  document.getElementById('rec-timer').textContent = '';
}

function logoutPerformer() {
  releasePerformerDevices();
  fetch('./api/logout', { method: 'POST' }).catch(() => {});
}

function returnToLobby() {
  if (STATE.role === 'performer') logoutPerformer();
  stopConcertDemo();
  stopArchiveReplay();
  STATE.viewMode = 'lobby';
  STATE.role = 'visitor';
  document.body.className = 'mode-lobby';
  broadcastWS({ type: 'role', role: 'visitor' });
  fetchArchivesAndStatus();
}

async function attemptPerformerLogin() {
  const pwInput = document.getElementById('performer-password');
  const errEl = document.getElementById('login-error');
  const password = pwInput.value;

  try {
    const resp = await fetch('./api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    const data = await resp.json();
    if (resp.ok && data.ok) {
      errEl.style.display = 'none';
      stopArchiveReplay();
      STATE.viewMode = 'performer';
      STATE.role = 'performer';
      document.body.className = 'mode-performer';
      document.getElementById('stage-header-title').textContent = '🎹 Performer Studio';
      synth.ensureContext();
      // Reconnect so the handshake carries the new HttpOnly session cookie.
      connectWebSocket();
    } else {
      errEl.textContent = data.error || 'Unable to sign in';
      errEl.style.display = 'inline';
    }
  } catch (err) {
    errEl.textContent = 'Unable to reach the server';
    errEl.style.display = 'inline';
  } finally {
    pwInput.value = '';
  }
}

function bindUIEvents() {
  // Landing Page Buttons
  document.getElementById('btn-enter-visitor').addEventListener('click', () => enterVisitorStage(true));
  document.getElementById('btn-performer-login').addEventListener('click', attemptPerformerLogin);
  document.getElementById('performer-password').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') attemptPerformerLogin();
  });

  // Return to Lobby
  document.getElementById('btn-back-lobby').addEventListener('click', returnToLobby);

  // Camera Presets
  document.querySelectorAll('[data-cam]').forEach((btn) => {
    btn.addEventListener('click', () => setCameraPreset(btn.dataset.cam));
  });

  // Visitor Replay Transport & Archive Switcher
  document.getElementById('btn-replay-playpause').addEventListener('click', () => {
    if (!STATE.replay.active) return;
    STATE.replay.paused = !STATE.replay.paused;
    STATE.replay.clock.lastNow=performance.now();
    if(!STATE.replay.paused&&STATE.replay.playheadMs>=STATE.replay.session.durationMs)seekArchiveReplay(0);
    if (STATE.replay.audioEl) {
      if (STATE.replay.paused) STATE.replay.audioEl.pause();
      else STATE.replay.audioEl.play().catch(() => {});
    }
    updateVisitorReplayUI();
  });

  document.getElementById('replay-scrubber').addEventListener('input', (e) => {
    if (!STATE.replay.active || !STATE.replay.session) return;
    const pct = parseFloat(e.target.value) / 1000;
    seekArchiveReplay(pct * STATE.replay.session.durationMs);
  });

  document.getElementById('visitor-archive-select').addEventListener('change', (e) => {
    const val = e.target.value;
    if (!val) return;
    if (val === '__live__') {
      stopArchiveReplay();
    } else {
      startArchiveReplay(val);
    }
  });

  // Visitor Volume & Mute
  const btnMute = document.getElementById('btn-visitor-mute');
  btnMute.addEventListener('click', () => {
    STATE.muted = !STATE.muted;
    btnMute.textContent = STATE.muted ? '🔇' : '🔊';
    synth.setVolume(STATE.masterVolume);
  });

  const slVisVol = document.getElementById('sl-visitor-volume');
  slVisVol.addEventListener('input', () => {
    STATE.masterVolume = parseFloat(slVisVol.value) / 100;
    document.getElementById('sl-volume').value = slVisVol.value;
    synth.setVolume(STATE.masterVolume);
  });

  // Performer Studio Controls
  document.getElementById('btn-record-show').addEventListener('click', toggleRecordShow);
  document.getElementById('btn-demo').addEventListener('click', toggleConcertDemo);
  document.getElementById('btn-webcam').addEventListener('click', toggleWebcamTracking);

  const btnCalib = document.getElementById('btn-webcam-calibrate');
  if (btnCalib) {
    btnCalib.addEventListener('click', calibrateNeutralPosture);
  }

  for (const selId of ['webcam-front-select', 'webcam-side-select']) {
    const selEl = document.getElementById(selId);
    if (selEl) {
      selEl.addEventListener('change', () => {
        if (STATE.webcamActive) {
          startOrRestartWebcamStreams().catch((err) => console.warn('Camera switch error:', err));
        }
      });
    }
  }

  for (const [id, key] of [
    ['sl-yaw', 'yaw'],
    ['sl-pitch', 'pitch'],
    ['sl-sway', 'sway'],
    ['sl-lean', 'lean'],
    ['sl-arch', 'arch'],
  ]) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.addEventListener('input', () => {
      STATE.pose[key] = parseFloat(el.value);
      if (STATE.role === 'performer') {
        broadcastWS({ type: 'pose', pose: STATE.pose });
      }
    });
  }

  const btnSynth = document.getElementById('btn-synth-toggle');
  btnSynth.addEventListener('click', () => {
    STATE.synthEnabled = !STATE.synthEnabled;
    btnSynth.classList.toggle('active', STATE.synthEnabled);
    document.getElementById('audio-status').textContent = STATE.synthEnabled ? 'Synth On' : 'Synth Off';
  });

  document.getElementById('btn-mic-stream').addEventListener('click', toggleLiveAudioStream);

  const slVol = document.getElementById('sl-volume');
  slVol.addEventListener('input', () => {
    STATE.masterVolume = parseFloat(slVol.value) / 100;
    slVisVol.value = slVol.value;
    synth.setVolume(STATE.masterVolume);
  });

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  if (navigator.mediaDevices?.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', () => {
      populateVideoInputs();
      populateAudioInputs();
    });
  }
}

// ============================================================================
// 15. MAIN RENDER LOOP
// ============================================================================
const clock = new THREE.Clock();

function updateNaturalBlink(dt) {
  STATE.nextBlink -= dt;
  if (STATE.blinkTime < 0 && STATE.nextBlink <= 0) {
    STATE.blinkTime = 0;
    STATE.blinkCount += 1;
  }
  let amount = 0;
  if (STATE.blinkTime >= 0) {
    STATE.blinkTime += dt;
    const time = STATE.blinkTime;
    amount = time < 0.075 ? time / 0.075 : time < 0.09 ? 1 : Math.max(0, 1 - (time - 0.09) / 0.13);
    if (time >= 0.22) {
      STATE.blinkTime = -1;
      STATE.nextBlink = 3.8 + Math.random() * 3.8;
    }
  }
  const fresh = STATE.replay.active || performance.now() - (STATE.webcamActive ? STATE.lastEyeCaptureAt : STATE.lastTrackedPoseAt) < 350;
  const tracked = fresh && STATE.pose.eyeTracking > .5;
  for (const [side,field] of [['L','eyeBlinkLeft'],['R','eyeBlinkRight']]) {
    // Fast smoothing preserves short blinks; a small dead zone keeps open lids steady.
    const target = STATE.blinkHold ? 1 : tracked ? THREE.MathUtils.clamp(((STATE.pose[field]||0)-.05)/.85,0,1) : amount;
    STATE.eyeClosure[side] += (target-STATE.eyeClosure[side])*(1-Math.exp(-dt*40));
  }
  for (const mesh of STATE.blinkMeshes) {
    mesh.morphTargetInfluences[mesh.morphTargetDictionary.Blink] = 0;
    mesh.morphTargetInfluences[mesh.morphTargetDictionary.BlinkLeft] = STATE.eyeClosure.L;
    mesh.morphTargetInfluences[mesh.morphTargetDictionary.BlinkRight] = STATE.eyeClosure.R;
  }
}

const direction = createStageDirection({scene,camera,controls,renderer,state:STATE,presets:CAM_PRESETS,lighting:{ambientLight,keySpot,rimLight,keyboardFill},cancelTransition:()=>{camTransition=null;}});
function updateExpressions(dt) {
  for (const [field,morph] of [['smile','Smile'],['frown','Frown'],['browRaise','BrowRaise'],['jaw','OpenMouth']]) {
    const target=THREE.MathUtils.clamp(Number(STATE.pose[field])||0,0,1);
    STATE.smoothedPose[field]+=(target-STATE.smoothedPose[field])*(1-Math.exp(-dt*12));
    for(const mesh of STATE.blinkMeshes){const index=mesh.morphTargetDictionary[morph];if(index!==undefined)mesh.morphTargetInfluences[index]=STATE.smoothedPose[field];}
  }
}
let renderAverage=1/60,qualitySlow=0,qualityFast=0;
const preferredPixelRatio=Math.min(window.devicePixelRatio,2);
renderer.setAnimationLoop(() => {
  const dt = Math.min(0.05, clock.getDelta());
  const elapsed = clock.getElapsedTime();
  if(!renderer.xr.isPresenting){
    renderAverage+=(dt-renderAverage)*.035;
    qualitySlow=renderAverage>1/48?qualitySlow+dt:0;
    qualityFast=renderAverage<1/58?qualityFast+dt:0;
    if(qualitySlow>1.5&&renderer.getPixelRatio()>1){renderer.setPixelRatio(Math.max(1,renderer.getPixelRatio()-.25));qualitySlow=qualityFast=0;}
    else if(qualityFast>10&&renderer.getPixelRatio()<preferredPixelRatio){renderer.setPixelRatio(Math.min(preferredPixelRatio,renderer.getPixelRatio()+.25));qualityFast=qualitySlow=0;}
  }

  if (camTransition) {
    camTransition.progress = Math.min(1, camTransition.progress + dt * 3.2);
    const t = 1 - Math.pow(1 - camTransition.progress, 3);
    camera.position.lerpVectors(camTransition.startPos, camTransition.endPos, t);
    controls.target.lerpVectors(camTransition.startTarget, camTransition.endTarget, t);
    camera.fov = THREE.MathUtils.lerp(camTransition.startFov, camTransition.endFov, t);
    camera.updateProjectionMatrix();
    if (camTransition.progress >= 1) camTransition = null;
  }

  if (!renderer.xr.isPresenting) {
    controls.update();
  }

  updateAvatarAndPianoAnimation(dt, elapsed);
  updateNaturalBlink(dt);
  updateExpressions(dt);
  direction.update(dt, elapsed);
  direction.renderScreens(dt);
  renderer.render(scene, camera);
});

// Boot Application
bindUIEvents();
loadStageAndAvatar();
fetchArchivesAndStatus();
initWebMIDI();
populateAudioInputs();
populateVideoInputs();
connectWebSocket();

// Measure the surrounding controls so studio and cameras never cover the piano ribbon.
const studioChrome = new ResizeObserver(entries => {
  for (const {target} of entries) {
    const height = target.getBoundingClientRect().height;
    if (target.matches('.topbar')) {
      document.documentElement.style.setProperty('--studio-top', `${height + 28}px`);
    } else if (target.matches('.piano-dock')) {
      document.documentElement.style.setProperty('--piano-dock-height', `${height || 96}px`);
    } else {
      document.documentElement.style.setProperty('--studio-cameras-height', `${height}px`);
    }
  }
});
for (const selector of ['.topbar','.piano-dock','.webcam-pip-dock']) {
  studioChrome.observe(document.querySelector(selector));
}

// Visitor controls stay out of the concert until explicitly opened.
const visitorControls = document.getElementById('visitor-controls-toggle');

// Reuse the existing controls and listeners; restore their original homes in the studio.
const visitorHud=document.createElement('section');
visitorHud.id='visitor-hud';visitorHud.setAttribute('aria-label','Concert controls');
document.querySelector('#stage-direction > button').classList.add('btn');
const cameraDetails=document.createElement('details');
cameraDetails.innerHTML='<summary>Camera &amp; viewing</summary>';
const noteLightLabel=document.createElement('label');
noteLightLabel.style.cssText='display:flex;gap:9px;align-items:center;padding:10px 0;color:#d8e0eb;font-size:13px';
const noteLightSwitch=document.createElement('input');noteLightSwitch.type='checkbox';noteLightSwitch.id='visitor-note-lights';
noteLightSwitch.onchange=()=>{STATE.visitorNoteLights=noteLightSwitch.checked;};
noteLightLabel.append(noteLightSwitch,document.createTextNode('Light played notes'));
cameraDetails.append(noteLightLabel);
const sceneryDetails=document.createElement('details');
sceneryDetails.innerHTML='<summary>Room &amp; lighting</summary>';
visitorHud.append(cameraDetails,sceneryDetails);document.body.append(visitorHud);
const hudParts=[['.brand-bar',visitorHud],['.visitor-bottom-bar',visitorHud],
 ['.cam-bar',cameraDetails],['#stage-direction',sceneryDetails],
 ['#stage-direction > button',cameraDetails]].map(([selector,target])=>{
 const node=document.querySelector(selector),home=document.createComment('control home');
 node.before(home);return {node,home,target};
});
function arrangeVisitorHud(){
 const visiting=document.body.classList.contains('mode-visitor');
 for(const {node,home,target}of hudParts){
  if(visiting){if(node.parentNode!==target){
   if(target===visitorHud)target.insertBefore(node,cameraDetails);else target.append(node);
  }}else if(node.previousSibling!==home)home.after(node);
 }
}
new MutationObserver(arrangeVisitorHud).observe(document.body,{attributes:true,attributeFilter:['class']});
arrangeVisitorHud();
visitorControls.setAttribute('aria-controls','visitor-hud');
document.getElementById('replay-scrubber').setAttribute('aria-label','Playback position');
document.getElementById('sl-visitor-volume').setAttribute('aria-label','Volume');
document.getElementById('visitor-archive-select').setAttribute('aria-label','Choose a recording');

function closeVisitorControls() {
  if (visitorHud.contains(document.activeElement)) visitorControls.focus();
  document.body.classList.remove('visitor-controls-open');
  visitorControls.setAttribute('aria-expanded', 'false');
  visitorControls.textContent = 'Concert controls';
}
visitorControls.addEventListener('click', () => {
  const open = document.body.classList.toggle('visitor-controls-open');
  visitorControls.setAttribute('aria-expanded', String(open));
  visitorControls.textContent = open ? 'Hide controls' : 'Concert controls';
});
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeVisitorControls(); });
new MutationObserver(() => {
  if (!document.body.classList.contains('visitor-controls-open')) {
    visitorControls.setAttribute('aria-expanded', 'false');
    visitorControls.textContent = 'Concert controls';
  }
}).observe(document.body, {attributes:true, attributeFilter:['class']});
