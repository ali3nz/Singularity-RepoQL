// Mobile-only, self-contained WebGL cortex. The anatomy is an illustrative
// procedural surface; only node/edge overlays come from the authenticated
// /api/unified/graph response. No fabricated memory relationships or metrics.
const TAU = 2 * Math.PI;
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
function hash(v) {
  let h = 2166136261;
  for (const c of String(v)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}
function rand(id) { return hash(id) / 4294967295; }

// The grooves are physical surface relief, not an image mapped onto a sphere.
// Different frequencies give broad gyri and fine sulci on both hemispheres.
function sulci(theta, phi, side) {
  const broad = Math.sin(13 * theta + 3.6 * Math.sin(4 * phi + side))
    * Math.sin(9 * phi + 1.8 * Math.sin(3 * theta));
  const medium = Math.sin(21 * theta + 4.1 * Math.sin(5 * phi))
    * Math.cos(17 * phi + 2.1 * Math.cos(2 * theta + side));
  const fine = Math.cos(31 * theta + 7 * phi) * Math.sin(25 * phi - 4 * theta);
  const depth = Math.pow(Math.max(0, broad * .62 + medium * .3 + fine * .08), 2);
  return { relief: .065 * broad + .026 * medium + .012 * fine - .095 * depth,
    groove: clamp(depth * 1.75, 0, 1) };
}
function hemisphericPoint(side, theta, phi) {
  const s = Math.sin(phi), c = Math.cos(phi);
  const { relief, groove } = sulci(theta, phi, side);
  const lateral = Math.cos(theta) * s;
  const front = Math.sin(theta) * s;
  // Anterior frontal expansion, tapered occipital pole, temporal underside.
  const frontBulge = 1 + .10 * Math.max(0, front) - .04 * Math.max(0, -front);
  const temporal = .13 * Math.exp(-((c + .42) ** 2) / .09) * Math.max(0, lateral);
  const radius = 1 + relief;
  const x = side * (.055 + 1.12 * Math.max(0, lateral) * radius);
  const y = 1.00 * c * radius - .05 - temporal;
  const z = 1.18 * front * frontBulge * radius;
  return { x, y, z, groove };
}
function buildAnatomy(highDetail=true) {
  const out = [];
  function quad(a,b,c,d,side) { triangle(a,b,c,side); triangle(a,c,d,side); }
  function triangle(a,b,c,side) {
    const ux=b.x-a.x, uy=b.y-a.y, uz=b.z-a.z;
    const vx=c.x-a.x, vy=c.y-a.y, vz=c.z-a.z;
    let nx=uy*vz-uz*vy, ny=uz*vx-ux*vz, nz=ux*vy-uy*vx;
    const m=Math.hypot(nx,ny,nz)||1;nx/=m;ny/=m;nz/=m;
    // Face orientation is corrected by using both sides in the WebGL renderer.
    for(const p of [a,b,c])out.push(p.x,p.y,p.z,nx,ny,nz,p.groove||0,side);
  }
  for(const side of [-1,1]) {
    const rows=highDetail?56:26, cols=highDetail?76:40;
    for(let i=1;i<rows-1;i++) {
      const p0=Math.PI*i/rows,p1=Math.PI*(i+1)/rows;
      for(let j=0;j<cols;j++) {
        const t0=-Math.PI/2 + Math.PI*j/cols;
        const t1=-Math.PI/2 + Math.PI*(j+1)/cols;
        const a=hemisphericPoint(side,t0,p0),b=hemisphericPoint(side,t1,p0);
        const c=hemisphericPoint(side,t1,p1),d=hemisphericPoint(side,t0,p1);
        quad(a,b,c,d,side);
      }
    }
  }
  // Distinct, ridged cerebellum and tapered brainstem are genuine geometry.
  for(let kind=0;kind<2;kind++) {
    const rings=kind?28:22, slices=kind?32:48;
    function point(i,j) {
      const p=Math.PI*i/rings,t=TAU*j/slices;
      if(kind) {
        const r=.16+.01*Math.sin(11*t);
        return {x:r*Math.sin(p)*Math.cos(t),y:-.94-.62*i/rings,z:-.14+r*Math.sin(p)*Math.sin(t),groove:.22};
      }
      const fold=1+.07*Math.cos(16*p);
      return {x:.57*Math.sin(p)*Math.cos(t)*fold,y:-.76+.31*Math.cos(p),z:-.69+.29*Math.sin(p)*Math.sin(t),groove:.35+.32*Math.pow(Math.cos(16*p),2)};
    }
    for(let i=0;i<rings;i++)for(let j=0;j<slices;j++)quad(point(i,j),point(i,j+1),point(i+1,j+1),point(i+1,j),2+kind);
  }
  return new Float32Array(out);
}
const VERT=`attribute vec3 position; attribute vec3 normal; attribute float groove; attribute float region;
uniform mat3 rotation; uniform vec2 aspect; uniform float magnification;
varying vec3 vNormal; varying float vGroove; varying float vRegion; varying float vDepth;
void main(){
  vec3 p=rotation*position;
  vNormal=normalize(rotation*normal);
  vGroove=groove;vRegion=region;vDepth=p.z;
  gl_Position=vec4(p.x*magnification*aspect.x,p.y*magnification*aspect.y,clamp(-p.z*.20,-.99,.99),1.);
}`;
const FRAG=`precision mediump float;
varying vec3 vNormal; varying float vGroove; varying float vRegion; varying float vDepth;
void main(){
  vec3 cyan=vec3(.015,.81,.96),purple=vec3(.67,.25,.97);
  vec3 base=vRegion<-.5?cyan:vRegion<1.5?purple:vec3(.38,.35,.80);
  float light=.30+.70*abs(dot(normalize(vNormal),normalize(vec3(-.35,.73,1.))));
  float spec=pow(abs(dot(normalize(vNormal),normalize(vec3(.18,.35,1.)))),15.)*.28;
  float cortex=1.-vGroove*.56;
  vec3 col=base*(.42+.70*light)*cortex+spec*vec3(.75,.91,1.);
  gl_FragColor=vec4(col,1.);
}`;
function shader(gl,kind,source) {
  const s=gl.createShader(kind);gl.shaderSource(s,source);gl.compileShader(s);
  if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(s)||'shader error');return s;
}
function rotation(yaw,pitch) {
  const a=Math.cos(yaw),b=Math.sin(yaw),c=Math.cos(pitch),d=Math.sin(pitch);
  // Column-major R_y * R_x.
  return new Float32Array([a,0,b,b*d,c,-a*d,-b,c*d,a*c]);
}
function rotate(m,p){return {x:m[0]*p.x+m[3]*p.y+m[6]*p.z,y:m[1]*p.x+m[4]*p.y+m[7]*p.z,z:m[2]*p.x+m[5]*p.y+m[8]*p.z};}

function memoryPosition(n) {
  const side=n.source_system==='tencent'?1:-1;
  const key=n.id||n.label;
  const phi=.39+rand(key+'|lat')*1.82;
  const theta=-1.10+rand(key+'|az')*2.20;
  const p=hemisphericPoint(side,theta,phi);
  return {x:p.x*1.08,y:p.y*1.08,z:p.z*1.08};
}
export function createMemoryBrain3D(host,{onSelect}={}) {
  if(!host) return null;
  const canvas=document.createElement('canvas'),overlay=document.createElement('canvas');
  canvas.className='memory-3d-surface';overlay.className='memory-3d-links';
  canvas.setAttribute('role','img');canvas.tabIndex=0;
  canvas.setAttribute('aria-label','Rotatable illustrative 3D brain with real RepoQL and Tencent memory nodes and relationships. Drag to rotate, pinch to zoom, tap a node to inspect.');
  host.append(canvas,overlay);
  const gl=canvas.getContext('webgl',{alpha:true,antialias:true,preserveDrawingBuffer:false});
  // WebGL is preferred on iOS and Android. Canvas 2D still renders a
  // rotatable three-dimensional mesh when GPUs are disabled or unavailable.
  const software=!gl, surface=software?canvas.getContext('2d'):null;
  if(software&&!surface){canvas.remove();overlay.remove();return null;}
  const softwareMesh=software?buildAnatomy(false):null;
  let program,buffer,vertCount;
  try {if(!software){
    program=gl.createProgram();gl.attachShader(program,shader(gl,gl.VERTEX_SHADER,VERT));gl.attachShader(program,shader(gl,gl.FRAGMENT_SHADER,FRAG));gl.linkProgram(program);
    if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(program)||'link failed');
    // The phone GPU needs far fewer triangles for a screen-sized projection.
    const mesh=buildAnatomy(!window.matchMedia?.('(max-width:760px)').matches);vertCount=mesh.length/8;
    buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,mesh,gl.STATIC_DRAW);
    gl.useProgram(program);
    const stride=8*4;
    for(const [name,size,offset] of [['position',3,0],['normal',3,3],['groove',1,6],['region',1,7]]){
      const location=gl.getAttribLocation(program,name);gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location,size,gl.FLOAT,false,stride,offset*4);
    }
    gl.enable(gl.DEPTH_TEST);gl.disable(gl.CULL_FACE);
  }} catch(error) {console.warn('3D brain unavailable',error);canvas.remove();overlay.remove();return null;}
  const ctx=overlay.getContext('2d');
  let visible={nodes:[],edges:[]},yaw=-.18,pitch=-.10,zoom=1,disposed=false,raf=0;
  let viewNodes=[],selected=null,nodePositions=new Map(),nodeSources=new Map();
  const pointers=new Map();let gesture=null;
  const locRot=gl?gl.getUniformLocation(program,'rotation'):null,locAsp=gl?gl.getUniformLocation(program,'aspect'):null,locZoom=gl?gl.getUniformLocation(program,'magnification'):null;
  function size(){if(disposed)return;const r=host.getBoundingClientRect(),d=Math.min(devicePixelRatio||1,1.5);
    const width=Math.max(1,Math.round(r.width*d)),height=Math.max(1,Math.round(r.height*d));
    if(canvas.width===width&&canvas.height===height)return;
    for(const c of [canvas,overlay]){c.width=width;c.height=height;}
    if(gl)gl.viewport(0,0,canvas.width,canvas.height);frame();}
  function frame(){if(disposed||raf)return;raf=requestAnimationFrame(()=>{raf=0;draw();});}
  function draw(){if(disposed||document.hidden||host.hidden||!host.isConnected)return;const w=canvas.clientWidth,h=canvas.clientHeight;if(!w||!h)return;
    const m=rotation(yaw,pitch),scale=Math.min(w/3.15,h/2.9)*zoom;
    // Match the WebGL orthographic projection exactly in CSS pixels.
    const aspect=[scale*2/w,scale*2/h];
    if(gl){
      gl.clearColor(.008,.025,.085,0);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
      gl.useProgram(program);gl.uniformMatrix3fv(locRot,false,m);
      gl.uniform2fv(locAsp,aspect);gl.uniform1f(locZoom,1);gl.drawArrays(gl.TRIANGLES,0,vertCount);
    }else{
      const d=canvas.width/w;surface.setTransform(d,0,0,d,0,0);surface.clearRect(0,0,w,h);
      const faces=[];
      for(let i=0;i<softwareMesh.length;i+=24){
        const v=[];
        for(let j=0;j<3;j++){
          const k=i+j*8,q=rotate(m,{x:softwareMesh[k],y:softwareMesh[k+1],z:softwareMesh[k+2]});
          v.push({x:w/2+q.x*scale,y:h/2-q.y*scale,z:q.z});
        }
        const k=i,region=softwareMesh[k+7],groove=softwareMesh[k+6];
        const n=rotate(m,{x:softwareMesh[k+3],y:softwareMesh[k+4],z:softwareMesh[k+5]});
        const lighting=.38+.62*Math.abs(n.x*.15+n.y*.34+n.z*.88);
        faces.push({v,depth:(v[0].z+v[1].z+v[2].z)/3,region,groove,lighting});
      }
      faces.sort((a,b)=>a.depth-b.depth);
      for(const f of faces){const base=f.region<-.5?[12,209,247]:f.region<1.5?[171,68,247]:[106,101,204];
        const intensity=(.48+.64*f.lighting)*(1-.57*f.groove),r=clamp(Math.round(base[0]*intensity),0,255),g=clamp(Math.round(base[1]*intensity),0,255),b=clamp(Math.round(base[2]*intensity),0,255);
        surface.fillStyle=`rgb(${r},${g},${b})`;
        surface.beginPath();surface.moveTo(f.v[0].x,f.v[0].y);surface.lineTo(f.v[1].x,f.v[1].y);surface.lineTo(f.v[2].x,f.v[2].y);surface.closePath();surface.fill();
      }
    }
    ctx.setTransform(1,0,0,1,0,0);ctx.clearRect(0,0,overlay.width,overlay.height);
    const d=overlay.width/w;ctx.setTransform(d,0,0,d,0,0);
    const project=p=>{const q=rotate(m,p);return {x:w/2+q.x*scale,y:h/2-q.y*scale,z:q.z}};
    const positions=new Map();viewNodes=[];
    for(const n of visible.nodes||[]){const p=project(nodePositions.get(n.id));
      // A node on the far side of the cortex must not look selectable through the brain.
      if(p.z < -.06)continue;
      positions.set(n.id,p);viewNodes.push({...p,id:n.id,n});}
    // Draw only actual response edges between the currently visible surface nodes.
    // The source data and complete record inspector are not changed.
    // Keep the overlay bounded on phones; every record remains available
    // via the source-backed topic explorer.
    let shown=0;const selectedId=selected;
    for(const e of visible.edges||[]){if(shown>=(selectedId?600:130))break;
      if(selectedId&&e.source!==selectedId&&e.target!==selectedId)continue;
      const a=positions.get(e.source),b=positions.get(e.target);if(!a||!b)continue;shown++;
      const cross=e.source_system==='cross'||nodeSources.get(e.source)!==nodeSources.get(e.target);
      ctx.strokeStyle=cross?'rgba(245,171,255,.37)':'rgba(74,212,255,.14)';ctx.lineWidth=cross?1:.65;
      ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.quadraticCurveTo((a.x+b.x)/2,(a.y+b.y)/2-7,b.x,b.y);ctx.stroke();
    }
    for(const p of viewNodes){const highlight=p.id===selected;
      const c=p.n.source_system==='tencent'?'#cc7cff':p.n.source_system==='memories'?'#6bffcf':'#46ebff';
      const radius=highlight?6.2:clamp(2.1+Math.log2(1+Number(p.n.degree||0))*.35,2.1,4.8);
      ctx.shadowColor=c;ctx.shadowBlur=highlight?18:8;ctx.fillStyle=c;
      ctx.beginPath();ctx.arc(p.x,p.y,radius,0,TAU);ctx.fill();ctx.shadowBlur=0;
      if(highlight){ctx.strokeStyle='#fff';ctx.lineWidth=1.5;ctx.stroke();const label=String(p.n.display_label||p.n.label||'').slice(0,43);
        ctx.font='600 12px system-ui';const textWidth=Math.min(w-25,ctx.measureText(label).width+18);
        const tx=clamp(p.x-textWidth/2,7,w-textWidth-7),ty=clamp(p.y-29,12,h-30);
        ctx.fillStyle='rgba(3,10,24,.90)';ctx.fillRect(tx,ty-12,textWidth,22);
        ctx.fillStyle='#f3faff';ctx.fillText(label,tx+7,ty+3,textWidth-12);}
    }
  }
  function pxy(e){const r=canvas.getBoundingClientRect();return {x:e.clientX-r.left,y:e.clientY-r.top};}
  function down(e){if(e.pointerType==='mouse'&&e.button!==0)return;canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
    if(pointers.size===1)gesture={x:e.clientX,y:e.clientY,travel:0};
    else gesture={distance:distance(),initialZoom:zoom,travel:50};}
  function distance(){const [a,b]=[...pointers.values()];return a&&b?Math.hypot(a.x-b.x,a.y-b.y):1;}
  function move(e){if(!pointers.has(e.pointerId))return;
    const prev=pointers.get(e.pointerId);pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
    if(pointers.size>1){zoom=clamp((gesture?.initialZoom||zoom)*distance()/Math.max(1,gesture?.distance||1),.7,2.5);frame();return;}
    const dx=e.clientX-prev.x,dy=e.clientY-prev.y;
    yaw+=dx*.008;pitch=clamp(pitch+dy*.007,-1.28,1.28);
    if(gesture)gesture.travel+=Math.abs(dx)+Math.abs(dy);frame();}
  function up(e){const tapped=e.type==='pointerup'&&pointers.size===1&&gesture?.travel<8;
    pointers.delete(e.pointerId);if(!pointers.size){gesture=null;}else gesture={distance:distance(),initialZoom:zoom,travel:50};
    if(tapped){const p=pxy(e);let nearest=null,dist=17;
      for(const n of viewNodes){const d=Math.hypot(p.x-n.x,p.y-n.y);if(d<dist){nearest=n;dist=d;}}
      selected=nearest?.id||null;onSelect?.(selected);frame();}}
  function wheel(e){e.preventDefault();zoom=clamp(zoom*Math.exp(-e.deltaY*.0014),.7,2.5);frame();}
  function key(e){if(e.key==='ArrowLeft'||e.key==='ArrowRight'){yaw+=(e.key==='ArrowLeft'?-1:1)*.16;frame();e.preventDefault();}
    if(e.key==='ArrowUp'||e.key==='ArrowDown'){pitch=clamp(pitch+(e.key==='ArrowUp'?-1:1)*.12,-1.28,1.28);frame();e.preventDefault();}
    if(e.key==='+'||e.key==='='){zoom=clamp(zoom*1.12,.7,2.5);frame();e.preventDefault();}
    if(e.key==='-'){zoom=clamp(zoom/1.12,.7,2.5);frame();e.preventDefault();}}
  const visibility=()=>{if(!document.hidden)frame();};
  document.addEventListener('visibilitychange',visibility);
  const watcher=new ResizeObserver(size);watcher.observe(host);
  canvas.addEventListener('pointerdown',down);canvas.addEventListener('pointermove',move);
  canvas.addEventListener('pointerup',up);canvas.addEventListener('pointercancel',up);
  canvas.addEventListener('wheel',wheel,{passive:false});canvas.addEventListener('keydown',key);
  return {
    setGraph(data){visible=data||{nodes:[],edges:[]};
      nodePositions=new Map((visible.nodes||[]).map(n=>[n.id,memoryPosition(n)]));
      nodeSources=new Map((visible.nodes||[]).map(n=>[n.id,n.source_system]));
      if(!nodeSources.has(selected))selected=null;frame();},
    select(id){selected=id;frame();},
    zoomBy(f){zoom=clamp(zoom*f,.7,2.5);frame();},
    rotateBy(angle){yaw+=angle;frame();},
    reset(){yaw=-.18;pitch=-.10;zoom=1;frame();},
    dispose(){disposed=true;if(raf)cancelAnimationFrame(raf);watcher.disconnect();
      document.removeEventListener('visibilitychange',visibility);
      canvas.removeEventListener('pointerdown',down);canvas.removeEventListener('pointermove',move);
      canvas.removeEventListener('pointerup',up);canvas.removeEventListener('pointercancel',up);
      canvas.removeEventListener('wheel',wheel);canvas.removeEventListener('keydown',key);
      if(gl){gl.deleteBuffer(buffer);gl.deleteProgram(program);}canvas.remove();overlay.remove();}
  };
}
