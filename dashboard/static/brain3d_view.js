// Memory Graph "3D" explorer: a real cortex mesh (baked from the fsaverage pial surface, see
// tools/bake_brain_mesh.py) with the live RepoQL / Tencent topics and links inside it.
// Rest view: opaque glowing-blue tissue, topics sit on the folds. Zoom in: the tissue fades to a ghost shell and the
// topics sink into the volume. Raw WebGL, static GPU buffers, one draw call per layer, no per-frame allocation.
// Positions come from the same layout as Brain mode (x, y in BRAIN_MASK space); only the depth is added here.
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const sstep=(a,b,x)=>{const t=clamp((x-a)/(b-a),0,1);return t*t*(3-2*t)};
function hash(v){let h=2166136261;for(const c of String(v))h=Math.imul(h^c.charCodeAt(0),16777619);return (h>>>0)/4294967295}
const MESH_URL=new URL('./brain_mesh.bin',import.meta.url).href+'?v=1';

// ---- column-major 4x4 helpers ------------------------------------------------------------------------------
const mul=(a,b)=>{const o=new Float32Array(16);for(let c=0;c<4;c++)for(let r=0;r<4;r++){let s=0;for(let k=0;k<4;k++)s+=a[k*4+r]*b[c*4+k];o[c*4+r]=s}return o};
const persp=(fov,asp,n,f)=>{const t=1/Math.tan(fov/2);return new Float32Array([t/asp,0,0,0,0,t,0,0,0,0,(f+n)/(n-f),-1,0,0,2*f*n/(n-f),0])};
const rotX=a=>{const c=Math.cos(a),s=Math.sin(a);return new Float32Array([1,0,0,0,0,c,s,0,0,-s,c,0,0,0,0,1])};
const rotY=a=>{const c=Math.cos(a),s=Math.sin(a);return new Float32Array([c,0,-s,0,0,1,0,0,s,0,c,0,0,0,0,1])};
const trans=(x,y,z)=>new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,x,y,z,1]);

const BRAIN_VS=`attribute vec3 a_pos;attribute vec3 a_nrm;attribute float a_sulc;
uniform mat4 u_mvp;uniform mat4 u_view;uniform float u_inv;
varying vec3 v_n;varying vec3 v_v;varying float v_s;
void main(){vec3 p=a_pos*u_inv;v_n=(u_view*vec4(a_nrm,0.)).xyz;v_v=(u_view*vec4(p,1.)).xyz;v_s=a_sulc;gl_Position=u_mvp*vec4(p,1.);}`;
// Cortex shading. Fold depth (sulc) darkens the sulci, and where the derivatives extension exists its gradient
// also tilts the normal so the fold walls pick up light and shadow like real relief. Colours are unchanged.
const brainFS=dx=>(dx?'#extension GL_OES_standard_derivatives : enable\n':'')+`
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec3 v_n;varying vec3 v_v;varying float v_s;uniform float u_alpha;
void main(){vec3 n=normalize(v_n);if(!gl_FrontFacing)n=-n;
`+(dx?`vec3 dpx=dFdx(v_v),dpy=dFdy(v_v);float dsx=dFdx(v_s),dsy=dFdy(v_s);
vec3 r1=cross(dpy,n),r2=cross(n,dpx);float det=dot(dpx,r1);
vec3 gr=sign(det)*(dsx*r1+dsy*r2);n=normalize(abs(det)*n-38.*gr);
`:'')+`vec3 V=normalize(-v_v);
float f=clamp(dot(n,V),0.,1.);float rim=pow(1.-f,2.3);
vec3 L=normalize(vec3(-.35,.55,.75));
float nl=dot(n,L);float light=clamp(mix(.5+.5*nl,max(nl,0.),.55),0.,1.);
float sul=smoothstep(.3,.9,v_s);
float ao=1.-.72*sul;float crown=1.+.14*(1.-sul);
vec3 H=normalize(L+V);float spec=pow(max(dot(n,H),0.),48.)*(1.-.9*sul);
float fill=max(dot(n,normalize(vec3(.6,-.35,.45))),0.);
vec3 body=mix(vec3(.04,.15,.40),vec3(.19,.56,.96),light)*ao*crown+vec3(.03,.11,.26)*fill*ao;
vec3 col=body+vec3(.22,.72,1.)*rim*.8*(1.-.4*sul)+vec3(.5,.88,1.)*spec*.16;
float a=u_alpha+(1.-u_alpha)*(.07+.5*rim);if(!gl_FrontFacing)a*=.5;
gl_FragColor=vec4(col,a);}`;
const PT_VS=`attribute vec3 a_p0;attribute vec3 a_p1;attribute vec4 a_c;attribute float a_s;
uniform mat4 u_mvp;uniform float u_in;uniform float u_time;uniform float u_k;uniform float u_dpr;
varying vec4 v_c;varying float v_big;
void main(){vec3 p=mix(a_p0,a_p1,u_in);vec4 c=u_mvp*vec4(p,1.);v_big=smoothstep(6.5,13.,a_c.w);
float tw=.85+.15*sin(u_time*1.6+a_c.r*31.+a_p0.x*.07);
float grow=a_s>1.5?2.2:(a_s>.5?1.5:1.);
gl_PointSize=clamp(a_c.w*grow*u_k/max(c.w,1.),1.6*u_dpr,46.*u_dpr);
float al=a_s<-.5?.28:(a_s>.5?1.:(.5+.3*tw+.2*v_big));
v_c=vec4(a_c.rgb,al);gl_Position=c;}`;
const PT_FS=`precision mediump float;varying vec4 v_c;varying float v_big;uniform float u_over;
void main(){vec2 q=gl_PointCoord-.5;float d=length(q)*2.;if(d>1.)discard;
float core=smoothstep(1.,.35,d);float halo=exp(-d*d*3.2)*.5;
vec3 rgb=mix(v_c.rgb,vec3(1.,.95,.85),smoothstep(.4,0.,d)*(.07+.55*v_big));
float ring=smoothstep(.1,0.,abs(d-.8))*v_big;halo*=1.+1.4*v_big;
float a=(core*.9+halo+ring*.8)*v_c.a;gl_FragColor=vec4(rgb*a,clamp(a,0.,1.)*u_over);}`;
const LN_VS=`attribute vec3 a_p0;attribute vec3 a_p1;attribute vec4 a_e;attribute vec4 a_c;
uniform mat4 u_mvp;uniform float u_in;uniform float u_time;uniform float u_ea;uniform float u_xo;varying vec4 v_c;
void main(){vec3 p=mix(a_p0,a_p1,u_in);
float k=fract(u_time*.16+a_e.y);float dd=abs(a_e.x-k);dd=min(dd,1.-dd);float pulse=smoothstep(.14,0.,dd);
vec4 c=a_c;float flag=a_e.z;
if(flag>1.5){c=vec4(1.,.86,.62,.9);}else if(flag<-.5){c.a*=.25;}
if(u_xo>.5&&a_e.w<.5&&flag<1.5)c.a*=.07;
c.rgb*=1.+(a_e.w>.5?2.6:1.5)*pulse;c.a*=(.6+.9*pulse)*u_ea;v_c=c;gl_Position=u_mvp*vec4(p,1.);}`;
const LN_FS=`precision mediump float;varying vec4 v_c;uniform float u_over;void main(){gl_FragColor=vec4(v_c.rgb*v_c.a,v_c.a*u_over);}`;

function program(gl,vs,fs){const mk=(t,s)=>{const sh=gl.createShader(t);gl.shaderSource(sh,s);gl.compileShader(sh);if(!gl.getShaderParameter(sh,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(sh));return sh};
  const p=gl.createProgram();gl.attachShader(p,mk(gl.VERTEX_SHADER,vs));gl.attachShader(p,mk(gl.FRAGMENT_SHADER,fs));gl.linkProgram(p);
  if(!gl.getProgramParameter(p,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(p));
  const u={},a={};const nu=gl.getProgramParameter(p,gl.ACTIVE_UNIFORMS),na=gl.getProgramParameter(p,gl.ACTIVE_ATTRIBUTES);
  for(let i=0;i<nu;i++){const n=gl.getActiveUniform(p,i).name;u[n]=gl.getUniformLocation(p,n)}
  for(let i=0;i<na;i++){const n=gl.getActiveAttrib(p,i).name;a[n]=gl.getAttribLocation(p,n)}
  return {p,u,a}}

async function loadMesh(){
  const res=await fetch(MESH_URL);if(!res.ok)throw new Error('brain mesh '+res.status);
  const buf=await res.arrayBuffer(),dv=new DataView(buf);
  if(dv.getUint32(0,true)!==0x314e5242)throw new Error('brain mesh format');
  const nV=dv.getUint32(4,true),nT=dv.getUint32(8,true),scale=dv.getFloat32(12,true),nL=dv.getUint32(16,true);let o=20;
  const pos=new Int16Array(buf.slice(o,o+nV*6));o+=nV*6;
  const nrm=new Int8Array(buf.slice(o,o+nV*3));o+=nV*3;
  const sul=new Uint8Array(buf.slice(o,o+nV));o+=nV;
  const idx=new Uint16Array(buf.slice(o,o+nT*6));
  return {nV,nT,nL,scale,pos,nrm,sul,idx};
}
// Top/bottom surface height per (x, y) cell, so a topic laid out in 2D gets a depth inside the real cortex.
function heightMap(mesh){
  const CELL=8,X0=-340,Y0=-420,GW=Math.ceil(680/CELL),GH=Math.ceil(840/CELL),top=new Float32Array(GW*GH).fill(-1e9),bot=new Float32Array(GW*GH).fill(1e9);
  const inv=1/mesh.scale;
  for(let i=0;i<mesh.nV;i++){const x=mesh.pos[i*3]*inv,y=mesh.pos[i*3+1]*inv,z=mesh.pos[i*3+2]*inv;
    const gx=Math.floor((x-X0)/CELL),gy=Math.floor((y-Y0)/CELL);if(gx<0||gy<0||gx>=GW||gy>=GH)continue;
    const k=gy*GW+gx;if(z>top[k])top[k]=z;if(z<bot[k])bot[k]=z}
  for(let pass=0;pass<4;pass++)for(let gy=0;gy<GH;gy++)for(let gx=0;gx<GW;gx++){const k=gy*GW+gx;if(top[k]>-1e8)continue;
    let t=-1e9,b=1e9;for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){const x=gx+dx,y=gy+dy;if(x<0||y<0||x>=GW||y>=GH)continue;const q=y*GW+x;if(top[q]>-1e8){t=Math.max(t,top[q]);b=Math.min(b,bot[q])}}
    if(t>-1e8){top[k]=t;bot[k]=b}}
  return {has(x,y){const gx=clamp(Math.floor((x-X0)/CELL),0,GW-1),gy=clamp(Math.floor((y-Y0)/CELL),0,GH-1);return top[gy*GW+gx]>-1e8},at(x,y){const gx=clamp(Math.floor((x-X0)/CELL),0,GW-1),gy=clamp(Math.floor((y-Y0)/CELL),0,GH-1),k=gy*GW+gx;
    return top[k]>-1e8?{top:top[k],bot:bot[k]}:{top:120,bot:-120}}};
}

export async function createBrain3D(base,{onPick}={}){
  const host=base.parentElement;if(!host)throw new Error('no host');
  const canvas=document.createElement('canvas');canvas.className='memory-3d-live';canvas.tabIndex=0;canvas.setAttribute('role','img');
  canvas.setAttribute('aria-label','Rotatable 3D brain with live RepoQL and Tencent memory topics. Drag to rotate, shift-drag or two-finger drag to move, scroll or pinch to zoom toward a point, tap a topic to inspect.');
  Object.assign(canvas.style,{position:'absolute',display:'none',touchAction:'none',cursor:'grab',outline:'none',borderRadius:'inherit',background:'#03060c'});
  if(getComputedStyle(host).position==='static')host.style.position='relative';
  base.after(canvas);
  const gl=canvas.getContext('webgl',{antialias:true,alpha:false,powerPreference:'high-performance'});
  if(!gl){canvas.remove();throw new Error('webgl unavailable')}
  const overlay=document.createElement('div');Object.assign(overlay.style,{position:'absolute',display:'none',pointerEvents:'none',font:'600 12px system-ui,sans-serif'});
  overlay.innerHTML='<span data-k="rq" style="position:absolute;left:14px;top:12px;color:#ffb36b"></span><span data-k="tx" style="position:absolute;right:14px;top:12px;color:#ff8f8f"></span><span data-k="cap" style="position:absolute;left:12px;bottom:12px;padding:6px 12px;border-radius:13px;background:rgba(3,8,17,.78);color:#a9d8ea;font-size:11px"></span><span data-k="lab" style="position:absolute;left:0;top:0;display:none;padding:3px 8px;border-radius:7px;background:rgba(10,14,22,.86);color:#fff;font-size:12px;white-space:nowrap;max-width:60%;overflow:hidden;text-overflow:ellipsis"></span><span data-k="load" style="position:absolute;left:0;right:0;top:46%;text-align:center;color:#a9d8ea;font-size:13px"></span>';
  canvas.after(overlay);
  // Topic names stay hidden until a node is clicked; this chip turns the up-close name tags on (remembered per browser).
  let showNames=false;try{showNames=localStorage.getItem('repoql.brain3d.names')==='1'}catch{}
  const nameBtn=document.createElement('button');nameBtn.type='button';
  Object.assign(nameBtn.style,{position:'absolute',right:'12px',bottom:'12px',padding:'6px 12px',border:'1px solid rgba(169,216,234,.35)',borderRadius:'13px',background:'rgba(3,8,17,.78)',color:'#a9d8ea',font:'600 11px system-ui,sans-serif',cursor:'pointer',pointerEvents:'auto'});
  const syncNameBtn=()=>{nameBtn.textContent=showNames?'Names: on':'Names: off';nameBtn.setAttribute('aria-pressed',String(showNames))};syncNameBtn();
  nameBtn.addEventListener('pointerdown',e=>e.stopPropagation());
  nameBtn.addEventListener('click',()=>{showNames=!showNames;try{localStorage.setItem('repoql.brain3d.names',showNames?'1':'0')}catch{}syncNameBtn();schedule()});
  overlay.appendChild(nameBtn);
  // Cross-system focus: dims every link inside one system so only RepoQL<->Tencent links stand out.
  let crossOnly=false;try{crossOnly=localStorage.getItem('repoql.brain3d.cross')==='1'}catch{}
  const xBtn=document.createElement('button');xBtn.type='button';xBtn.style.cssText=nameBtn.style.cssText;xBtn.style.bottom='52px';
  let xCount=0;const syncX=()=>{xBtn.textContent=(crossOnly?'Cross links only: on':'Cross links only: off')+(xCount?' · '+xCount.toLocaleString():'');xBtn.setAttribute('aria-pressed',String(crossOnly))};syncX();
  xBtn.addEventListener('pointerdown',e=>e.stopPropagation());
  xBtn.addEventListener('click',()=>{crossOnly=!crossOnly;try{localStorage.setItem('repoql.brain3d.cross',crossOnly?'1':'0')}catch{}syncX();schedule()});
  overlay.appendChild(xBtn);
  const q=k=>overlay.querySelector(`[data-k="${k}"]`);
  q('load').textContent='Loading brain…';canvas.style.display='block';overlay.style.display='block';sync2d();
  let mesh;try{mesh=await loadMesh()}catch(e){canvas.remove();overlay.remove();throw e}
  const hm=heightMap(mesh);
  const hasDx=!!gl.getExtension('OES_standard_derivatives');let bp;try{bp=program(gl,BRAIN_VS,brainFS(hasDx))}catch(e){bp=program(gl,BRAIN_VS,brainFS(false))}
  const pp=program(gl,PT_VS,PT_FS),lp=program(gl,LN_VS,LN_FS);
  const mkBuf=(target,data,usage)=>{const b=gl.createBuffer();gl.bindBuffer(target,b);gl.bufferData(target,data,usage||gl.STATIC_DRAW);return b};
  const bPos=mkBuf(gl.ARRAY_BUFFER,mesh.pos),bNrm=mkBuf(gl.ARRAY_BUFFER,mesh.nrm),bSul=mkBuf(gl.ARRAY_BUFFER,mesh.sul),bIdx=mkBuf(gl.ELEMENT_ARRAY_BUFFER,mesh.idx);
  q('load').textContent='';
  const coarse=window.matchMedia?.('(pointer:coarse)')?.matches===true;
  const reduced=window.matchMedia?.('(prefers-reduced-motion: reduce)');
  // ---- state ---------------------------------------------------------------------------------------------
  const FOV=34*Math.PI/180;let W=1,H=1,dpr=1,D0=1400,aspect=1;
  let yaw=0,pitch=0,dist=D0,distTarget=D0,userMoved=false,tx=0,ty=0;
  let version=-1,activeId=null,nodes=[],nodeIdx=new Map(),edges=[],gNodes=null,gLines=null,neighbours=new Set();
  let disposed=false,shown=true,onScreen=true,raf=0,lastT=0,interacting=false,easing=false,lastTap=0;
  const t0=performance.now();
  function sync2d(){const w=base.clientWidth,h=base.clientHeight;for(const el of [canvas,overlay]){el.style.left=base.offsetLeft+'px';el.style.top=base.offsetTop+'px';el.style.width=w+'px';el.style.height=h+'px'}}
  function resize(){sync2d();dpr=Math.min(window.devicePixelRatio||1,coarse?1.75:2);const w=canvas.clientWidth,h=canvas.clientHeight;if(!w||!h)return;
    W=w;H=h;aspect=w/h;const nw=Math.round(w*dpr),nh=Math.round(h*dpr);if(canvas.width!==nw||canvas.height!==nh){canvas.width=nw;canvas.height=nh}
    const f=Math.tan(FOV/2);D0=Math.max(392/f,314*1.02/(f*aspect))+150;
    if(!userMoved){dist=distTarget=D0}else{distTarget=clamp(distTarget,D0*.14,D0*1.7)}schedule()}
  // ---- graph buffers -------------------------------------------------------------------------------------
  const COL={rq:[1,.56,.16],tx:[1,.26,.3],mem:[.5,.9,.7]};
  const sysOf=n=>n.source_system==='tencent'?'tx':n.source_system==='memories'?'mem':'rq';
  function setGraph(rendered,ver,aId){
    if(ver!==version){version=ver;buildGraph(rendered)}
    if(aId!==activeId||ver!==version)setActive(aId);
  }
  function buildGraph(rendered){
    nodes=rendered.nodes;nodeIdx=new Map();const n=nodes.length;
    const p0=new Float32Array(n*3),p1=new Float32Array(n*3),col=new Float32Array(n*4);
    nodes.forEach((nd,i)=>nodeIdx.set(nd.id,i));
    // connection counts drive size, brightness and how little a topic is nudged when the layout is spread out
    const deg=new Float32Array(n);for(const e of rendered.edges){const a=nodeIdx.get(e.source),b=nodeIdx.get(e.target);if(a!==undefined&&b!==undefined){deg[a]++;deg[b]++}}
    let mxd=1;for(let i=0;i<n;i++){deg[i]=Math.max(deg[i],nodes[i].degree||0);if(deg[i]>mxd)mxd=deg[i]}
    const hub=new Float32Array(n);for(let i=0;i<n;i++)hub[i]=Math.log1p(deg[i])/Math.log1p(mxd);
    // spread: relax overlapping topics apart (small ones move most, hubs hold their place) while a spring keeps each
    // community near its layout position, and nothing leaves the cortex footprint
    const X=new Float32Array(n),Y=new Float32Array(n),X0=new Float32Array(n),Y0=new Float32Array(n);
    nodes.forEach((nd,i)=>{X[i]=X0[i]=nd.x;Y[i]=Y0[i]=-nd.y});
    const R=coarse?15:13,cell=R,gw=Math.ceil(700/cell)+2;
    for(let it=0;it<16&&n>1;it++){
      const grid=new Map();for(let i=0;i<n;i++){const k=Math.floor((X[i]+350)/cell)+gw*Math.floor((Y[i]+430)/cell);let a=grid.get(k);if(!a)grid.set(k,a=[]);a.push(i)}
      const dX=new Float32Array(n),dY=new Float32Array(n);
      for(let i=0;i<n;i++){const cx=Math.floor((X[i]+350)/cell),cy=Math.floor((Y[i]+430)/cell);
        for(let oy=-1;oy<=1;oy++)for(let ox=-1;ox<=1;ox++){const a=grid.get(cx+ox+gw*(cy+oy));if(!a)continue;
          for(const j of a){if(j<=i)continue;let dx=X[i]-X[j],dy=Y[i]-Y[j],d=Math.hypot(dx,dy);const want=R*(.7+.5*Math.max(hub[i],hub[j]));if(d>=want)continue;
            if(d<.01){dx=hash('sx'+i+j)-.5;dy=hash('sy'+i+j)-.5;d=Math.hypot(dx,dy)||1}
            const push=(want-d)*.5/d,mi=1/(1+hub[i]*4),mj=1/(1+hub[j]*4),m=mi+mj;
            dX[i]+=dx*push*mi/m*2;dY[i]+=dy*push*mi/m*2;dX[j]-=dx*push*mj/m*2;dY[j]-=dy*push*mj/m*2}}}
      for(let i=0;i<n;i++){const m=1/(1+hub[i]*4);let nx=X[i]+dX[i]+(X0[i]-X[i])*.035*(1+hub[i]*3),ny=Y[i]+dY[i]+(Y0[i]-Y[i])*.035*(1+hub[i]*3);
        if(hm.has(nx,ny)){X[i]=nx;Y[i]=ny}else if(hm.has(X0[i]*.5+nx*.5,Y0[i]*.5+ny*.5)){X[i]=X0[i]*.5+nx*.5;Y[i]=Y0[i]*.5+ny*.5}}
    }
    nodes.forEach((nd,i)=>{const h=hm.at(X[i],Y[i]),hh=hash(nd.id);
      p0.set([X[i],Y[i],h.top+2],i*3);
      // hubs sink less so they stay readable from outside; the rest fill the thickness of the cortex
      const dz=(.16+.6*hash('z'+nd.id))*(1-.55*hub[i]);p1.set([X[i],Y[i],h.top-(h.top-h.bot)*dz],i*3);
      const c=COL[sysOf(nd)];col.set([c[0],c[1],c[2],2.8+12.5*Math.pow(hub[i],1.35)+hh*.6],i*4)});
    // edges: cross-system links first (drawn as a 3-strand braid in a gradient between the two systems' colours),
    // then the links between the best-connected topics; faint, short links in the same system are what gets dropped
    const cap=coarse?2200:3400,list=rendered.edges.filter(e=>nodeIdx.has(e.source)&&nodeIdx.has(e.target));
    const imp=e=>Math.sqrt(hub[nodeIdx.get(e.source)]*hub[nodeIdx.get(e.target)]);
    list.sort((a,b)=>((b.source_system==='cross')-(a.source_system==='cross'))||(imp(b)-imp(a)));edges=list.slice(0,cap);
    const SEG=coarse?5:7,vertsPer=SEG*2;let V=0;const range=[];
    edges.forEach(e=>{const st=e.source_system==='cross'?3:1;range.push([V,st*vertsPer]);V+=st*vertsPer});
    const e0=new Float32Array(V*3),e1=new Float32Array(V*3),eE=new Float32Array(V*4),eC=new Float32Array(V*4);
    let w=0;const curve=(a0,b0,lift,j,t)=>{const mt=1-t;return [mt*mt*a0[0]+2*mt*t*(((a0[0]+b0[0])/2)+j[0])+t*t*b0[0],mt*mt*a0[1]+2*mt*t*(((a0[1]+b0[1])/2)+j[1])+t*t*b0[1],mt*mt*a0[2]+2*mt*t*(((a0[2]+b0[2])/2)+lift+j[2])+t*t*b0[2]]};
    const shift=(P,dx,dy)=>[P[0]+dx,P[1]+dy,P[2]];
    let crossCount=0;
    edges.forEach((e,ei)=>{const a=nodeIdx.get(e.source),b=nodeIdx.get(e.target);
      const A0=[p0[a*3],p0[a*3+1],p0[a*3+2]],B0=[p0[b*3],p0[b*3+1],p0[b*3+2]],A1=[p1[a*3],p1[a*3+1],p1[a*3+2]],B1=[p1[b*3],p1[b*3+1],p1[b*3+2]];
      const len=Math.hypot(A0[0]-B0[0],A0[1]-B0[1]);const lift=Math.min(36,len*.12);
      const hj=hash(e.id||e.source+e.target),j=[(hj-.5)*len*.18,(hash('y'+(e.id||e.source))-.5)*len*.18,(hash('w'+(e.id||e.target))-.5)*30];
      const cross=e.source_system==='cross',ph=hash('p'+(e.id||ei)),im=imp(e);
      const ca=COL[sysOf(nodes[a])],cb=COL[sysOf(nodes[b])];
      const sys=e.source_system==='tencent'?COL.tx:COL.rq;
      const nx=-(B0[1]-A0[1])/(len||1),ny=(B0[0]-A0[0])/(len||1);
      const strands=cross?[-1.5,0,1.5]:[0];if(cross)crossCount++;
      for(const off of strands){const ox=nx*off,oy=ny*off;
        for(let s=0;s<SEG;s++){const ta=s/SEG,tb=(s+1)/SEG;
          for(let k=0;k<2;k++){const t=k?tb:ta,s0=curve(shift(A0,ox,oy),shift(B0,ox,oy),lift,j,t),s1=curve(shift(A1,ox,oy),shift(B1,ox,oy),0,j,t);
            e0.set(s0,w*3);e1.set(s1,w*3);eE.set([t,ph,0,cross?1:0],w*4);
            if(cross){const m=t,mid=Math.sin(Math.PI*m)*.75;eC.set([ca[0]+(cb[0]-ca[0])*m+(1-(ca[0]+(cb[0]-ca[0])*m))*mid,ca[1]+(cb[1]-ca[1])*m+(.9-(ca[1]+(cb[1]-ca[1])*m))*mid,ca[2]+(cb[2]-ca[2])*m+(.6-(ca[2]+(cb[2]-ca[2])*m))*mid,off===0?.8:.4],w*4)}
            else eC.set([sys[0],sys[1],sys[2],.045+.4*Math.pow(im,1.1)],w*4);
            w++}}}});
    free();
    gNodes={n,b0:mkBuf(gl.ARRAY_BUFFER,p0),b1:mkBuf(gl.ARRAY_BUFFER,p1),bc:mkBuf(gl.ARRAY_BUFFER,col),bs:mkBuf(gl.ARRAY_BUFFER,new Float32Array(n),gl.DYNAMIC_DRAW),state:new Float32Array(n),p0,p1};
    gLines={V,b0:mkBuf(gl.ARRAY_BUFFER,e0),b1:mkBuf(gl.ARRAY_BUFFER,e1),be:mkBuf(gl.ARRAY_BUFFER,eE),bc:mkBuf(gl.ARRAY_BUFFER,eC),bf:null,eE,SEG:vertsPer,range};
    const cnt={rq:0,tx:0,mem:0};for(const nd of nodes)cnt[sysOf(nd)]++;
    q('rq').textContent=`RepoQL · ${cnt.rq.toLocaleString()}`;q('tx').textContent=`Tencent · ${cnt.tx.toLocaleString()}`;
    q('cap').textContent=`${n.toLocaleString()}${rendered.omitted?' of '+rendered.totalVisibleBeforeProjection.toLocaleString():''} topics · ${rendered.edges.length.toLocaleString()} links · 3D view`;xCount=crossCount;syncX();
    activeId=undefined;schedule();
  }
  function free(){for(const g of [gNodes,gLines]){if(!g)continue;for(const k of ['b0','b1','bc','bs','be'])if(g[k])gl.deleteBuffer(g[k])}gNodes=gLines=null}
  function setActive(id){
    activeId=id||null;neighbours=new Set();const lab=q('lab');
    if(activeId&&nodeIdx.has(activeId)){const nd=nodes[nodeIdx.get(activeId)];lab.textContent=String(nd.display_label||nd.label||nd.id).slice(0,48)}else lab.style.display='none';
    if(activeId)for(const e of edges){if(e.source===activeId)neighbours.add(e.target);else if(e.target===activeId)neighbours.add(e.source)}
    if(!gNodes)return;
    const st=gNodes.state;for(let i=0;i<nodes.length;i++){const id=nodes[i].id;st[i]=!activeId?0:id===activeId?2:neighbours.has(id)?1:-1}
    gl.bindBuffer(gl.ARRAY_BUFFER,gNodes.bs);gl.bufferData(gl.ARRAY_BUFFER,st,gl.DYNAMIC_DRAW);
    // edge flags: 2 = touches the selection, -1 = faded
    const flags=new Float32Array(gLines.V);
    for(let i=0;i<edges.length;i++){const hit=!activeId?0:(edges[i].source===activeId||edges[i].target===activeId)?2:-1,[r0,rn]=gLines.range[i];for(let k=0;k<rn;k++)flags[r0+k]=hit}
    const eE=gLines.eE;for(let i=0;i<gLines.V;i++)eE[i*4+2]=flags[i];
    gl.bindBuffer(gl.ARRAY_BUFFER,gLines.be);gl.bufferData(gl.ARRAY_BUFFER,eE,gl.DYNAMIC_DRAW);schedule();
  }
  // ---- drawing -------------------------------------------------------------------------------------------
  let mvp=null,view=null;
  function matrices(){const proj=persp(FOV,aspect,6,5000);view=mul(trans(0,0,-dist),mul(mul(rotX(pitch),rotY(yaw)),trans(-tx,-ty,0)));mvp=mul(proj,view)}
  function layers(){const r=dist/D0;return {alpha:sstep(.38,.72,r),inside:1-sstep(.42,.62,r)}}
  const attr=(loc,buf,size,type,norm,off)=>{if(loc<0)return;gl.bindBuffer(gl.ARRAY_BUFFER,buf);gl.enableVertexAttribArray(loc);gl.vertexAttribPointer(loc,size,type||gl.FLOAT,!!norm,0,off||0)};
  // u16 indices are local to each hemisphere, so each half is drawn with its own attribute offset
  function drawShell(){const half=mesh.nT/2;for(let h=0;h<2;h++){const v0=h?mesh.nL:0;
    attr(bp.a.a_pos,bPos,3,gl.SHORT,false,v0*6);attr(bp.a.a_nrm,bNrm,3,gl.BYTE,true,v0*3);attr(bp.a.a_sulc,bSul,1,gl.UNSIGNED_BYTE,true,v0);
    gl.drawElements(gl.TRIANGLES,half*3,gl.UNSIGNED_SHORT,h*half*6)}}
  const offAttrs=p=>{for(const k in p.a)gl.disableVertexAttribArray(p.a[k])};
  function render(now){
    if(!W||!H)return;matrices();const {alpha,inside}=layers();
    gl.viewport(0,0,canvas.width,canvas.height);gl.clearColor(.012,.024,.05,1);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);gl.depthFunc(gl.LEQUAL);
    const prepass=alpha>.85&&inside<.02;
    // shell: depth prepass (hides topics behind the tissue when seen from outside), then the lit surface
    gl.useProgram(bp.p);gl.uniformMatrix4fv(bp.u.u_mvp,false,mvp);gl.uniformMatrix4fv(bp.u.u_view,false,view);gl.uniform1f(bp.u.u_inv,1/mesh.scale);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,bIdx);
    if(prepass){gl.enable(gl.CULL_FACE);gl.cullFace(gl.BACK);gl.colorMask(false,false,false,false);gl.depthMask(true);gl.uniform1f(bp.u.u_alpha,1);drawShell();gl.colorMask(true,true,true,true)}
    gl.disable(gl.CULL_FACE);gl.enable(gl.BLEND);gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);gl.depthMask(false);
    gl.uniform1f(bp.u.u_alpha,alpha);drawShell();offAttrs(bp);
    // neural layers: additive light
    const over=sstep(.45,.8,alpha);gl.blendFunc(gl.ONE,gl.ONE_MINUS_SRC_ALPHA);const time=(now-t0)/1000;
    if(gLines&&gLines.V){gl.useProgram(lp.p);gl.uniformMatrix4fv(lp.u.u_mvp,false,mvp);gl.uniform1f(lp.u.u_in,inside);gl.uniform1f(lp.u.u_time,time);gl.uniform1f(lp.u.u_over,over);gl.uniform1f(lp.u.u_xo,crossOnly?1:0);gl.uniform1f(lp.u.u_ea,.55+.45*(1-over));
      attr(lp.a.a_p0,gLines.b0,3);attr(lp.a.a_p1,gLines.b1,3);attr(lp.a.a_e,gLines.be,4);attr(lp.a.a_c,gLines.bc,4);gl.drawArrays(gl.LINES,0,gLines.V);offAttrs(lp)}
    if(gNodes&&gNodes.n){gl.useProgram(pp.p);gl.uniformMatrix4fv(pp.u.u_mvp,false,mvp);gl.uniform1f(pp.u.u_in,inside);gl.uniform1f(pp.u.u_time,time);gl.uniform1f(pp.u.u_over,over);
      gl.uniform1f(pp.u.u_k,canvas.height/(2*Math.tan(FOV/2)));gl.uniform1f(pp.u.u_dpr,canvas.width/Math.max(1,W));
      attr(pp.a.a_p0,gNodes.b0,3);attr(pp.a.a_p1,gNodes.b1,3);attr(pp.a.a_c,gNodes.bc,4);attr(pp.a.a_s,gNodes.bs,1);gl.drawArrays(gl.POINTS,0,gNodes.n);offAttrs(pp)}
    gl.disable(gl.BLEND);gl.depthMask(true);
    nameTags(inside);
    const lab=q('lab');
    if(activeId&&gNodes&&nodeIdx.has(activeId)){const sp=project(nodeIdx.get(activeId),inside);
      if(sp&&sp.x>0&&sp.x<W&&sp.y>0&&sp.y<H){lab.style.display='block';lab.style.transform=`translate(${Math.round(clamp(sp.x+10,4,W-lab.offsetWidth-4))}px,${Math.round(clamp(sp.y-26,4,H-34))}px)`}else lab.style.display='none'}
  }
  // up close, name the biggest topics that are on screen (greedy, no overlap) so zooming in reveals something readable
  const tags=[];let tagK=0;
  function nameTags(inside){const r=dist/D0,want=showNames&&r<.62&&gNodes&&nodes.length;
    if(!want){for(const t of tags)t.style.display='none';return}
    const cand=[];for(let i=0;i<nodes.length;i++){const sp=project(i,inside);if(!sp||sp.x<20||sp.x>W-20||sp.y<24||sp.y>H-34)continue;
      const wgt=(nodes[i].degree||0)+(nodes[i].id===activeId?1e6:0)-sp.w*.002;cand.push([wgt,sp,i])}
    cand.sort((a,b)=>b[0]-a[0]);const boxes=[],max=coarse?9:16;let n=0;
    for(const [,sp,i] of cand){if(n>=max)break;const nd=nodes[i],txt=String(nd.display_label||nd.label||nd.id).slice(0,26),bw=txt.length*6.4+10,x=sp.x+8,y=sp.y-8;
      if(boxes.some(b=>x<b[0]+b[2]&&x+bw>b[0]&&y<b[1]+b[3]&&y+16>b[1]))continue;boxes.push([x,y,bw,16]);
      let t=tags[n];if(!t){t=document.createElement('span');Object.assign(t.style,{position:'absolute',left:0,top:0,padding:'1px 5px',borderRadius:'6px',background:'rgba(3,8,17,.72)',color:'#e6f4ff',font:'600 11px system-ui,sans-serif',whiteSpace:'nowrap',pointerEvents:'none'});overlay.appendChild(t);tags.push(t)}
      if(t.textContent!==txt)t.textContent=txt;t.style.display='block';t.style.transform=`translate(${Math.round(Math.min(x,W-bw-2))}px,${Math.round(y)}px)`;n++}
    for(let k=n;k<tags.length;k++)tags[k].style.display='none'}
  // ---- loop: on demand while idle, 30 fps ambient shimmer, 60 fps while touching --------------------------
  const visible=()=>!disposed&&shown&&onScreen&&!document.hidden&&canvas.isConnected;
  function schedule(){if(raf||!visible())return;raf=requestAnimationFrame(loop)}
  function loop(t){raf=0;if(!visible())return;
    easing=Math.abs(distTarget-dist)>.5;
    if(easing)dist+=(distTarget-dist)*Math.min(1,.2*((t-lastT)/16.7||1));
    const gap=(interacting||easing)?0:(reduced?.matches?400:coarse?50:33);
    if(t-lastT<gap){raf=requestAnimationFrame(loop);return}
    lastT=t;render(t);raf=requestAnimationFrame(loop)}
  const seen=typeof IntersectionObserver==='function'?new IntersectionObserver(es=>{onScreen=es.some(e=>e.isIntersecting);if(onScreen)schedule()}):null;seen?.observe(canvas);
  const onVis=()=>{if(!document.hidden)schedule()};document.addEventListener('visibilitychange',onVis);
  const ro=typeof ResizeObserver==='function'?new ResizeObserver(()=>resize()):null;ro?.observe(base);
  // ---- input -----------------------------------------------------------------------------------------------
  const ptr=new Map();let pinch=0,moved=0,downAt=0,panning=false;
  function onDown(e){if(e.pointerType==='mouse'&&e.button>2)return;canvas.setPointerCapture(e.pointerId);ptr.set(e.pointerId,{x:e.clientX,y:e.clientY});interacting=true;moved=0;downAt=performance.now();panning=e.pointerType==='mouse'&&(e.button!==0||e.shiftKey||e.ctrlKey||e.metaKey);
    if(ptr.size===2){const [a,b]=[...ptr.values()];pinch=Math.hypot(a.x-b.x,a.y-b.y)}schedule()}
  function onMove(e){const p=ptr.get(e.pointerId);if(!p)return;const dx=e.clientX-p.x,dy=e.clientY-p.y;p.x=e.clientX;p.y=e.clientY;
    if(ptr.size===1){moved+=Math.abs(dx)+Math.abs(dy);if(panning){panBy(dx,dy)}else{yaw+=dx*.0075;pitch=clamp(pitch+dy*.0075,-1.45,1.45)}userMoved=true}
    else if(ptr.size===2){const [a,b]=[...ptr.values()],d=Math.hypot(a.x-b.x,a.y-b.y);if(pinch>0){const r=canvas.getBoundingClientRect(),mx=(a.x+b.x)/2-r.left,my=(a.y+b.y)/2-r.top;zoomTo(distTarget*pinch/d,mx,my);dist=distTarget;panBy(dx/2,dy/2)}pinch=d;moved+=9}
    schedule()}
  function onUp(e){if(!ptr.has(e.pointerId))return;ptr.delete(e.pointerId);if(ptr.size<2)pinch=0;
    if(!ptr.size){interacting=false;const tapped=moved<8&&performance.now()-downAt<450;
      if(tapped){const now=performance.now();if(now-lastTap<320){reset();lastTap=0}else{lastTap=now;pick(e)}}}
    schedule()}
  function onWheel(e){e.preventDefault();const r=canvas.getBoundingClientRect();zoomTo(distTarget*Math.exp(e.deltaY*.0012),e.clientX-r.left,e.clientY-r.top);schedule()}
  function onKey(e){const k=e.key;if(k==='+'||k==='=')zoomBy(1.2);else if(k==='-')zoomBy(1/1.2);else if(k==='0')reset();else if(k==='ArrowLeft')yaw-=.12;else if(k==='ArrowRight')yaw+=.12;else if(k==='ArrowUp')pitch=clamp(pitch-.12,-1.45,1.45);else if(k==='ArrowDown')pitch=clamp(pitch+.12,-1.45,1.45);else return;e.preventDefault();schedule()}
  canvas.addEventListener('pointerdown',onDown);canvas.addEventListener('pointermove',onMove);canvas.addEventListener('pointerup',onUp);canvas.addEventListener('pointercancel',onUp);
  canvas.addEventListener('wheel',onWheel,{passive:false});canvas.addEventListener('keydown',onKey);canvas.addEventListener('contextmenu',e=>e.preventDefault());
  function project(i,inside){const g=gNodes;const x=g.p0[i*3]*(1-inside)+g.p1[i*3]*inside,y=g.p0[i*3+1]*(1-inside)+g.p1[i*3+1]*inside,z=g.p0[i*3+2]*(1-inside)+g.p1[i*3+2]*inside;
    const m=mvp,cx=m[0]*x+m[4]*y+m[8]*z+m[12],cy=m[1]*x+m[5]*y+m[9]*z+m[13],cw=m[3]*x+m[7]*y+m[11]*z+m[15];
    if(cw<=0)return null;return {x:(cx/cw*.5+.5)*W,y:(1-(cy/cw*.5+.5))*H,w:cw}}
  function pick(e){if(!gNodes||!mvp)return;const r=canvas.getBoundingClientRect(),px=e.clientX-r.left,py=e.clientY-r.top,{inside}=layers();
    let best=-1,bd=(coarse?26:16)**2;
    for(let i=0;i<nodes.length;i++){const s=project(i,inside);if(!s)continue;const d=(s.x-px)**2+(s.y-py)**2;if(d<bd){bd=d;best=i}}
    onPick?.(best>=0?nodes[best].id:null)}
  // camera orbits a target (tx,ty) on the brain's mid-plane; zoom moves that target toward the point under the pointer
  const rotT=(v)=>{const R=mul(rotX(pitch),rotY(yaw));return [0,1,2].map(i=>R[i*4]*v[0]+R[i*4+1]*v[1]+R[i*4+2]*v[2])};
  const clampT=()=>{tx=clamp(tx,-330,330);ty=clamp(ty,-420,420)};
  function planePoint(px,py){const f=Math.tan(FOV/2),nx=(px/W*2-1)*f*aspect,ny=(1-py/H*2)*f,d=rotT([nx,ny,-1]),o=rotT([0,0,dist]);
    if(Math.abs(d[2])<1e-4)return null;const s=-(o[2]+0)/d[2];if(!(s>0))return null;return [o[0]+tx+d[0]*s,o[1]+ty+d[1]*s]}
  function zoomTo(newTarget,px,py){newTarget=clamp(newTarget,D0*.14,D0*1.7);const k=1-newTarget/distTarget,P=planePoint(px,py);
    if(P&&k>0){tx+=(P[0]-tx)*k;ty+=(P[1]-ty)*k;clampT()}else if(k<0){const g=distTarget/newTarget;tx*=g;ty*=g}
    distTarget=newTarget;userMoved=true}
  function panBy(dx,dy){const sc=2*dist*Math.tan(FOV/2)/H,m=rotT([-dx*sc,dy*sc,0]);tx+=m[0];ty+=m[1];clampT();userMoved=true}
  function zoomBy(f){distTarget=clamp(distTarget/f,D0*.14,D0*1.7);userMoved=true;schedule()}
  function reset(){yaw=0;pitch=0;tx=0;ty=0;userMoved=false;distTarget=D0;schedule()}
  function focusNode(id){const i=nodeIdx.get(id);if(i===undefined||!gNodes)return;const x=gNodes.p0[i*3],y=gNodes.p0[i*3+1];
    tx=x;ty=y;clampT();yaw=0;pitch=0;distTarget=Math.min(distTarget,D0*.5);userMoved=true;schedule()}
  resize();
  return {
    setGraph,focusNode,zoomBy,fit:reset,resize,
    show(){shown=true;canvas.style.display='block';overlay.style.display='block';resize();schedule()},
    hide(){shown=false;canvas.style.display='none';overlay.style.display='none';cancelAnimationFrame(raf);raf=0},
    stats(){return {dist,D0,nodes:nodes.length,edges:edges.length,verts:mesh.nV,tris:mesh.nT}},
    setView(v){if(v.yaw!==undefined)yaw=v.yaw;if(v.pitch!==undefined)pitch=v.pitch;if(v.zoomRatio!==undefined){distTarget=dist=D0*v.zoomRatio;userMoved=true}schedule()},
    dispose(){disposed=true;cancelAnimationFrame(raf);seen?.disconnect();ro?.disconnect();document.removeEventListener('visibilitychange',onVis);free();
      for(const b of [bPos,bNrm,bSul,bIdx])gl.deleteBuffer(b);gl.getExtension('WEBGL_lose_context')?.loseContext();canvas.remove();overlay.remove()}
  };
}
