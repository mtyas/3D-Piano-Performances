import * as THREE from 'three';


export const STYLES = {
  Classic:{colors:[0xd9ae69,0x896a42,0xb7c8df],wall:0x171b25,fabric:0x352733,key:0xffedda,rim:0x9dbce5,speed:.035},
  Midnight:{colors:[0x578bd3,0xadbfe3,0xd6b578],wall:0x101c31,fabric:0x142743,key:0xf0f3ff,rim:0x698fe8,speed:.025},
  Burgundy:{colors:[0xd8af73,0xc77583,0x8c455d],wall:0x24171f,fabric:0x491e32,key:0xffeddf,rim:0xc87a9c,speed:.025},
  Emerald:{colors:[0x6fae9e,0xd5bb87,0x6d8892],wall:0x102724,fabric:0x16483d,key:0xfff1dc,rim:0x73b5aa,speed:.025},
  Gallery:{colors:[0xe8d9bd,0xa9c7d4,0xc3beb6],wall:0x30333a,fabric:0x353d49,key:0xf8f5ee,rim:0xb8d7ea,speed:.02},
  '60s':{colors:[0xf26645,0xf7c948,0x37b3ae],wall:0x24232c,fabric:0x344642,key:0xffefdc,rim:0x8dc8ce,speed:.14},
  Bauhaus:{colors:[0xe33b32,0xe9bd32,0x3478cb],wall:0x20212a,fabric:0x28314b,key:0xfff0dc,rim:0xa6bde0,speed:.07},
  '70s':{colors:[0xd77a37,0x998547,0xb44e36],wall:0x25221c,fabric:0x483223,key:0xffe9cb,rim:0xa8b197,speed:.09},
  Calm:{colors:[0x608c9d,0x89afa4,0xaaa0bf],wall:0x19252d,fabric:0x263d46,key:0xf1f4ee,rim:0xa8c8d0,speed:.025},
  Modern:{colors:[0x427ae0,0xc66ad9,0x5fd1cb],wall:0x151e2c,fabric:0x29334b,key:0xf4f0ed,rim:0x8e9fe0,speed:.1},
};

export function createStageDirection({scene,camera,controls,renderer,state,presets,lighting,cancelTransition}) {
  const group=new THREE.Group();group.name='Concert architecture';scene.add(group);
  const hall=new THREE.Group(),theatre=new THREE.Group(),gallery=new THREE.Group(),garden=new THREE.Group();
  group.add(hall,theatre,gallery,garden);
  const wall=new THREE.MeshStandardMaterial({color:0x171b25,emissive:0x171b25,emissiveIntensity:.25,roughness:.92});
  const timber=new THREE.MeshStandardMaterial({color:0x846548,emissive:0x302116,emissiveIntensity:.3,roughness:.65,metalness:.12});
  const trim=new THREE.MeshStandardMaterial({color:0xc5a475,metalness:.72,roughness:.30});
  const fabric=new THREE.MeshStandardMaterial({color:0x352733,emissive:0x352733,emissiveIntensity:.35,roughness:1,side:THREE.DoubleSide});
  const accentMaterials=[0,1,2].map(()=>new THREE.MeshStandardMaterial({color:0xffffff,emissive:0xffffff,emissiveIntensity:.65,roughness:.55}));
  const box=new THREE.BoxGeometry(1,1,1);
  function block(parent,material,pos,size){const m=new THREE.Mesh(box,material);m.position.set(...pos);m.scale.set(...size);m.receiveShadow=true;parent.add(m);return m;}
  // A solid curved acoustic shell gives the room depth and a coherent silhouette.
  const shell=new THREE.Mesh(new THREE.CylinderGeometry(3.35,3.35,3.55,64,1,true,Math.PI/2,Math.PI),wall);
  shell.position.y=1.70;shell.material.side=THREE.DoubleSide;group.add(shell);
  for(let i=0;i<37;i++){
    const a=-Math.PI*.48+i/36*Math.PI*.96,r=3.18;
    const slat=block(hall,timber,[Math.sin(a)*r,1.45,-Math.cos(a)*r],[.065,2.85,.14]);slat.rotation.y=-a;
    if(i%6===0){const strip=block(hall,accentMaterials[(i/6)%3],[Math.sin(a)*3.07,1.55,-Math.cos(a)*3.07],[.018,2.65,.025]);strip.rotation.y=-a;}
  }
  // Sewn curtain folds are actual geometry, rather than transparent silhouettes.
  for(const sign of [-1,1]){
    const geo=new THREE.PlaneGeometry(1.25,3.05,48,20),p=geo.attributes.position;
    for(let i=0;i<p.count;i++)p.setZ(i,.065*Math.cos(p.getX(i)*Math.PI*12));geo.computeVertexNormals();
    const curtain=new THREE.Mesh(geo,fabric);curtain.position.set(sign*2.15,1.5,-2.10);theatre.add(curtain);
    block(theatre,trim,[sign*2.15,3.05,-2.08],[1.35,.07,.12]);
    for(let i=0;i<3;i++){
      const pillar=block(gallery,wall,[sign*(1.5+i*.48),1.4,-2.7+i*.22],[.31,2.8,.28]);pillar.rotation.y=-sign*.12;
      block(gallery,accentMaterials[i],[sign*(1.5+i*.48),1.4,-2.53+i*.22],[.018,2.55,.015]);
    }
    for(let n=0;n<2;n++){
      const x=sign*(2.25+n*.45),z=-1.15-n*.9;
      block(garden,timber,[x,.16,z],[.38,.32,.38]);
      const stem=new THREE.Mesh(new THREE.CylinderGeometry(.018,.026,1.55,8),timber);stem.position.set(x,.97,z);garden.add(stem);
      const leafMat=new THREE.MeshStandardMaterial({color:0x2e5c46,roughness:.9,side:THREE.DoubleSide});
      for(let j=0;j<12;j++){
        const leaf=new THREE.Mesh(new THREE.SphereGeometry(1,12,8),leafMat),a=j*2.4;
        leaf.scale.set(.09,.27,.035);leaf.position.set(x+Math.sin(a)*.14,.45+j*.095,z+Math.cos(a)*.14);leaf.rotation.set(.5*Math.cos(a),a,.65*Math.sin(a));garden.add(leaf);
      }
    }
  }
  // Discreet overhead rigging and perimeter practicals.
  block(group,trim,[0,3.34,-1.6],[5.1,.045,.045]);
  for(const x of [-2.65,2.65])block(group,timber,[x,.045,-.3],[.12,.11,4.0]);
  const washes=[];
  for(let i=0;i<4;i++){
    const x=-2.2+i*1.47;
    const light=new THREE.SpotLight(0xffffff,3,7,.46,.85,1.6);light.position.set(x,.15,-1.65);light.target.position.set(x,2.35,-Math.sqrt(3.3*3.3-x*x));scene.add(light,light.target);washes.push(light);
    const housing=new THREE.Mesh(new THREE.CylinderGeometry(.08,.09,.13,12),trim);housing.position.copy(light.position);group.add(housing);
  }
  const screens=createStageScreens({scene,renderer,state,presets,decoration:group});
  let style='Classic',scenery='Concert Hall',cinematic=false,shot=0,shotTime=0;
  const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
  const shots=['3q','hands','face','orbit','overhead'];
  let fromPos=camera.position.clone(),fromTarget=controls.target.clone(),fromFov=camera.fov;
  function setStyle(name){
    if(!STYLES[name])return;style=name;const s=STYLES[name];
    wall.color.setHex(s.wall);wall.emissive.setHex(s.wall);fabric.color.setHex(s.fabric);fabric.emissive.setHex(s.fabric);
    accentMaterials.forEach((m,i)=>{m.color.setHex(s.colors[i]);m.emissive.setHex(s.colors[i]);});
    washes.forEach((l,i)=>l.color.setHex(s.colors[i%3]));
    if(lighting){lighting.keySpot.color.setHex(s.key);lighting.keySpot.intensity=5.2;lighting.keySpot.penumbra=.85;lighting.keySpot.target.position.set(0,1.05,.12);scene.add(lighting.keySpot.target);
      lighting.rimLight.color.setHex(s.rim);lighting.rimLight.intensity=3.0;lighting.rimLight.target.position.set(0,1.15,0);scene.add(lighting.rimLight.target);
      lighting.ambientLight.intensity=.9;lighting.keyboardFill.intensity=1.4;}
    scene.background.setHex(s.wall);scene.fog.color.setHex(s.wall);scene.fog.density=.035;
  }
  function setScenery(name){scenery=name;hall.visible=['Concert Hall','Mixed','City','Town'].includes(name);theatre.visible=name==='Velvet Theatre';gallery.visible=['Light Gallery','Shapes'].includes(name);garden.visible=['Garden Pavilion','Trees'].includes(name);}
  function setCinematic(on){cinematic=Boolean(on)&&!renderer.xr.isPresenting;button.setAttribute('aria-pressed',String(cinematic));button.textContent=cinematic?'Stop cinematic camera':'Cinematic camera';if(cinematic){document.querySelectorAll('[data-cam]').forEach(b=>b.classList.remove('active'));shot=0;cancelTransition();state.cameraMode='cinematic';shotTime=0;fromPos.copy(camera.position);fromTarget.copy(controls.target);fromFov=camera.fov;}}
  const panel=document.createElement('div');panel.id='stage-direction';panel.style.cssText='position:fixed;right:16px;bottom:18px;z-index:35;display:flex;gap:10px;padding:10px;background:#10151ddd;border:1px solid #ffffff25;border-radius:12px;color:white;flex-wrap:wrap;max-width:360px;font:13px system-ui';
  function select(labelText,aria,items,value,onChange){const label=document.createElement('label');label.textContent=labelText+' ';const el=document.createElement('select');el.setAttribute('aria-label',aria);for(const [key,text] of items){const o=document.createElement('option');o.value=key;o.textContent=text;el.append(o);}el.value=value;el.onchange=()=>onChange(el.value);label.append(el);panel.append(label);return el;}
  select('Lighting','Stage lighting style',Object.keys(STYLES).map(n=>[n,n==='Classic'?'Warm recital':n==='Gallery'?'Gallery white':n]),style,setStyle);
  select('Set','Room scenery',['Concert Hall','Velvet Theatre','Light Gallery','Garden Pavilion'].map(n=>[n,n]),scenery,setScenery);
  select('Camera screens','In-world camera screens',[['0','Off'],['3','3 screens'],['4','4 screens']],'3',screens.setCount);
  const button=document.createElement('button');button.textContent='Cinematic camera';button.setAttribute('aria-pressed','false');button.onclick=()=>setCinematic(!cinematic);panel.append(button);document.body.append(panel);
  const css=document.createElement('style');css.textContent='#stage-direction label{display:flex;flex-direction:column;gap:5px;font-size:12px;color:#cbd1db}#stage-direction button,#stage-direction select{background:#202630;color:#eee;border:1px solid #ffffff30;border-radius:7px;padding:7px;font:inherit}#stage-direction button[aria-pressed=true]{background:#ae7836}';document.head.append(css);
  controls.addEventListener('start',()=>setCinematic(false));document.querySelectorAll('[data-cam]').forEach(b=>b.addEventListener('click',()=>setCinematic(false)));
  renderer.xr.addEventListener('sessionstart',()=>setCinematic(false));setStyle(style);setScenery(scenery);
  return {setStyle,setScenery,setCinematic,renderScreens:dt=>screens.render(dt),update(dt,time){
    const energy=Math.min(1,[...state.activeNotes.values()].reduce((v,n)=>v+n.velocity,0)/5);
    washes.forEach((l,i)=>{const target=24+energy*2.0+(reduced?0:Math.sin(time*.12+i)*.35);l.intensity+=(target-l.intensity)*(1-Math.exp(-dt*2));});
    panel.style.display=state.viewMode==='visitor'?'flex':'none';button.hidden=state.role==='performer';if(cinematic&&state.role==='performer')setCinematic(false);
    if(!cinematic||renderer.xr.isPresenting)return;
    shotTime+=dt;const duration=style==='Calm'?14:10;
    if(shotTime>duration){shot=(shot+1)%shots.length;shotTime=0;fromPos.copy(camera.position);fromTarget.copy(controls.target);fromFov=camera.fov;}
    const preset=presets[shots[shot]]||presets['3q'];const t=Math.min(1,shotTime/(reduced?4:3.2)),ease=t*t*(3-2*t);
    camera.position.lerpVectors(fromPos,new THREE.Vector3(...preset.pos),ease);controls.target.lerpVectors(fromTarget,new THREE.Vector3(...preset.target),ease);
    if(shots[shot]==='orbit'&&!reduced){const a=-.7+shotTime/duration*Math.PI*2;camera.position.lerp(new THREE.Vector3(Math.sin(a)*2.3,1.55,Math.cos(a)*2.3),ease);controls.target.set(0,.92,.2);}
    camera.fov=THREE.MathUtils.lerp(fromFov,preset.fov,ease);camera.updateProjectionMatrix();camera.lookAt(controls.target);
  }};
}



// Independent cameras render the SAME animated scene; the display wall is hidden
// during captures, so screens never film themselves or recursively render screens.
export function createStageScreens({scene,renderer,state,presets,decoration}) {
  const group=new THREE.Group();group.name='In-world camera screens';scene.add(group);
  const views=[['Concert', '3q'],['Hands & keys','hands'],['Portrait','face'],['Overhead','overhead']];
  const screens=[];let count=3,next=0,accumulator=0,frameTime=1/60,monitorDetails=null;
  function labelTexture(text){
    const c=document.createElement('canvas');c.width=512;c.height=48;const x=c.getContext('2d');
    x.fillStyle='#0c111a';x.fillRect(0,0,512,48);x.fillStyle='#d2b780';x.font='500 19px system-ui';x.fillText(text.toUpperCase(),18,32);
    const t=new THREE.CanvasTexture(c);t.colorSpace=THREE.SRGBColorSpace;return t;
  }
  for(const [title,key] of views){
    const rig=new THREE.Group();group.add(rig);
    const target=new THREE.WebGLRenderTarget(512,288,{depthBuffer:true,stencilBuffer:false});
    // Render targets use the linear working space, then the final view applies
    // the display conversion exactly once (including in XR).
    const screen=new THREE.Mesh(new THREE.PlaneGeometry(1.24,.6975),new THREE.MeshBasicMaterial({map:target.texture,toneMapped:true,side:THREE.DoubleSide}));
    screen.position.z=.034;rig.add(screen);
    const frame=new THREE.Mesh(new THREE.BoxGeometry(1.31,.80,.055),new THREE.MeshStandardMaterial({color:0x11151d,metalness:.65,roughness:.32}));rig.add(frame);
    const titleMesh=new THREE.Mesh(new THREE.PlaneGeometry(1.24,.10),new THREE.MeshBasicMaterial({map:labelTexture(title),toneMapped:false}));titleMesh.position.set(0,-.405,.035);rig.add(titleMesh);
    for(const x of [-.56,.56]){
      const cable=new THREE.Mesh(new THREE.CylinderGeometry(.006,.006,1,6),new THREE.MeshStandardMaterial({color:0x30343c,roughness:.6}));cable.position.x=x;rig.add(cable);cable.userData.cable=true;
    }
    const preset=presets[key],cam=new THREE.PerspectiveCamera(preset.fov,16/9,.05,30);cam.position.set(...preset.pos);cam.lookAt(new THREE.Vector3(...preset.target));
    screens.push({rig,target,cam,screen});
  }
  function setCount(value){
    count=[0,3,4].includes(Number(value))?Number(value):3;
    const layout=count===4?[[-1.65,2.42,-1.20],[1.65,2.42,-1.20],[-1.65,1.48,-1.20],[1.65,1.48,-1.20]]:
      [[-1.65,1.85,-1.20],[1.65,1.85,-1.20],[0,2.66,-1.35]];
    screens.forEach((s,i)=>{
      s.rig.visible=i<count;if(i>=count)return;
      s.rig.position.set(...layout[i]);s.rig.rotation.y=layout[i][0]<-.1?.20:layout[i][0]>.1?-.20:0;
      for(const c of s.rig.children)if(c.userData.cable){const length=Math.max(.12,3.32-layout[i][1]-.40);c.scale.y=length;c.position.y=.4+length/2;}
    });
    group.visible=count>0;next=0;accumulator=count;
  }
  setCount(3);
  return {setCount,group,render(dt){
    if(!count||!state.calib)return;
    frameTime+=(dt-frameTime)*.04;
    // Main animation gets priority; monitor refresh adapts instead of stalling it.
    const fps=frameTime>1/50?12:(count===4?15:20);
    accumulator=Math.min(count,accumulator+dt*count*fps);
    // At most one capture per frame, avoiding a twice-rendered avatar spike.
    let passes=Math.min(1,Math.floor(accumulator));
    if(!passes)return;
    const oldTarget=renderer.getRenderTarget(),xr=renderer.xr.enabled,shadow=renderer.shadowMap.autoUpdate;
    const viewport=renderer.getViewport(new THREE.Vector4()),scissor=renderer.getScissor(new THREE.Vector4()),scissorTest=renderer.getScissorTest();
    const decorationVisible=decoration.visible;
    const head=state.bones.head,neck=state.bones.neck,hs=head?.scale.clone(),ns=neck?.scale.clone();
    const meshes=(state.headOnlyMeshes||[]).map(m=>[m,m.visible]);
    // The scalp already supplies the hair silhouette/colour. Sub-pixel fibers
    // account for 423,600 triangles and are unnecessary on 512px monitor feeds.
    if(!monitorDetails){monitorDetails=[];scene.traverse(o=>{if(o.isMesh&&o.material?.name==='NaturalHairFibers')monitorDetails.push(o);});}
    const details=monitorDetails.map(m=>[m,m.visible]);
    try{
      group.visible=false;decoration.visible=false;renderer.xr.enabled=false;renderer.shadowMap.autoUpdate=false;renderer.setScissorTest(false);
      head?.scale.setScalar(1);neck?.scale.setScalar(1);for(const [m] of meshes)m.visible=true;for(const [m] of details)m.visible=false;scene.updateMatrixWorld(true);
      while(passes--){const s=screens[next%count];renderer.setRenderTarget(s.target);renderer.clear();renderer.render(scene,s.cam);next++;accumulator--;}
    }finally{
      if(head)head.scale.copy(hs);if(neck)neck.scale.copy(ns);for(const [m,visible] of meshes)m.visible=visible;for(const [m,visible] of details)m.visible=visible;scene.updateMatrixWorld(true);
      renderer.setRenderTarget(oldTarget);renderer.setViewport(viewport);renderer.setScissor(scissor);renderer.setScissorTest(scissorTest);
      renderer.xr.enabled=xr;renderer.shadowMap.autoUpdate=shadow;decoration.visible=decorationVisible;group.visible=count>0;
    }
  }};
}

import { interpolatePose } from './replay-timing.js';

const BODY_FIELDS = ['yaw','pitch','roll','sway','lean','arch','shoulderL','shoulderR','elbowL','elbowR',
  ...['L','R'].flatMap(s=>['Upper','Lower'].flatMap(p=>['X','Y','Z'].map(a=>`arm${s}${p}${a}`)))];

// A symmetric window uses the poses already available in the live look-ahead
// queue or archive. It removes camera jitter without delaying the music or blinks.
export function sampleSmoothPose(frames,index,time) {
  const a=frames[index],b=frames[index+1];
  const center=interpolatePose(a,b,time,frames[index-1],frames[index+2]);
  if(!a || !b || b.t-a.t>=500 || time<a.t || time>b.t)return center;
  const totals={},weights={};let cursor=Math.max(0,index-8);
  for(let offset=-180;offset<=180;offset+=30){
    const t=Math.max(frames[0].t,Math.min(frames.at(-1).t,time+offset));
    while(cursor>0&&frames[cursor].t>t)cursor--;
    while(cursor+1<frames.length&&frames[cursor+1].t<=t)cursor++;
    const left=frames[cursor],right=frames[cursor+1];
    // Never smooth across a lost-tracking interval.
    if(right&&right.t-left.t>=500)continue;
    const pose=interpolatePose(left,right,t,frames[cursor-1],frames[cursor+2]);
    const w=Math.exp(-.5*(offset/75)**2);
    for(const field of BODY_FIELDS)if(Number.isFinite(pose[field])){
      totals[field]=(totals[field]||0)+w*pose[field];weights[field]=(weights[field]||0)+w;
    }
  }
  for(const field of BODY_FIELDS)if(weights[field])center[field]=totals[field]/weights[field];
  return center;
}

// Exact critically damped spring: continuous position AND velocity when a new
// webcam measurement arrives. No frame-rate-dependent lerp or spring overshoot.
export class PoseDamper {
  constructor(response=.12){this.response=response;this.channels=new Map();}
  update(field,target,dt,current=0){
    target=Number.isFinite(target)?target:0;
    let c=this.channels.get(field);
    if(!c){c={x:current,v:0};this.channels.set(field,c);}
    const omega=2/this.response,t=Math.max(0,Math.min(.05,dt)),e=Math.exp(-omega*t);
    const delta=c.x-target,temp=(c.v+omega*delta)*t;
    c.x=target+(delta+temp)*e;c.v=(c.v-omega*temp)*e;
    return c.x;
  }
  reset(){this.channels.clear();}
}
