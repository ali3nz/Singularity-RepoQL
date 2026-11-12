// Self-contained visualization utilities. No provider calls, credentials, CDN, or framework.
// Pure layout/filter/series functions are exported for regression tests.
import {BRAIN_MASK} from './brain_asset.js';
const TAU = Math.PI * 2;
// Charcoal skin: quieter hues, thinner glow and a slow idle float. Other themes keep the neon look.
const isCalm = () => document.documentElement?.dataset?.theme === 'charcoal';
const CALM = {bg:'#111113', dot:'rgba(200,200,210,.06)', active:'rgba(236,236,239,.9)',
  rq:'#8fbfe6', rqMajor:'#d3e6f6', tx:'#b9a7e3', txMajor:'#e6def7', mem:'#9ad3b0', memMajor:'#deF2e6',
  rqEdge:'127,176,220', txEdge:'168,150,214', cross:'214,170,112',
  label:'#c9c9d0', labelBg:'rgba(14,14,16,.82)', caption:'#a8a8b0', captionBg:'rgba(20,20,23,.86)'};
const COLORS = {repoql:'#50b8ff', tencent:'#bd98ff', cross:'#ffbb62'};
const hash = text => {let h=2166136261;for(const c of String(text)){h=Math.imul(h^c.charCodeAt(0),16777619)}return h>>>0};
const rand = key => (hash(key)%100000)/100000;
const valid = n => Number.isFinite(Number(n)) && n!==null && n!==undefined && n!=='';
export const numeric = v => valid(v) ? Number(v) : null;

export function filterGraph(graph, opts={}) {
  const enabled = new Set(opts.sources || ['repoql','tencent']);
  const query = String(opts.query||'').trim().toLowerCase();
  const nodes = (graph?.nodes||[]).filter(n=>enabled.has(n.source_system));
  const allowed = new Set(nodes.map(n=>n.id));
  const edges=(graph?.edges||[]).filter(e=>allowed.has(e.source)&&allowed.has(e.target)&&(opts.cross!==false||e.source_system!=='cross'));
  if(!query)return {nodes,edges};
  const matched=new Set(nodes.filter(n=>[n.label,n.display_label,n.source_id,n.category,n.annotation_notes].some(x=>String(x||'').toLowerCase().includes(query))).map(n=>n.id));
  for(const e of edges){if([e.type,e.display_label,e.provenance,e.annotation_notes].some(x=>String(x||'').toLowerCase().includes(query))){matched.add(e.source);matched.add(e.target)}}
  // Include only direct neighbors of the actual search hits; prevent multi-hop chain expansion.
  const visible=new Set(matched);
  for(const e of edges)if(matched.has(e.source)||matched.has(e.target)){visible.add(e.source);visible.add(e.target)}
  return {nodes:nodes.filter(n=>visible.has(n.id)),edges:edges.filter(e=>visible.has(e.source)&&visible.has(e.target)),matches:matched};
}

// The overview is a deterministic *view* of real source records, not an
// aggregated/synthetic knowledge graph. Its omissions are explicit in the UI.
// Searching bypasses this projection so operators can still reach quiet nodes.
export function focusGraph(graph, maxNodes=72) {
  const nodes=graph?.nodes||[], edges=graph?.edges||[];
  const limit=Math.max(1,Math.min(250,Math.floor(Number(maxNodes)||72)));
  if(nodes.length<=limit)return {nodes:[...nodes],edges:[...edges],omitted:0};
  const ids=new Set(nodes.map(n=>n.id)),degrees=new Map(nodes.map(n=>[n.id,0]));
  for(const edge of edges)if(ids.has(edge.source)&&ids.has(edge.target)){
    degrees.set(edge.source,degrees.get(edge.source)+1);
    degrees.set(edge.target,degrees.get(edge.target)+1);
  }
  const rank=(a,b)=>(degrees.get(b.id)||0)-(degrees.get(a.id)||0)||String(a.id).localeCompare(String(b.id));
  const groups=new Map();
  for(const node of nodes){const name=node.source_system||'other';if(!groups.has(name))groups.set(name,[]);groups.get(name).push(node);}
  for(const group of groups.values())group.sort(rank);
  const selected=new Set();
  // Keep each available source represented even in strongly imbalanced indexes.
  for(const group of groups.values())if(group.length&&selected.size<limit)selected.add(group[0].id);
  // Round-robin across sources prevents one high-degree source from hiding others.
  for(let i=1;selected.size<limit;i++){
    let added=false;
    for(const group of groups.values())if(group[i]&&selected.size<limit){selected.add(group[i].id);added=true;}
    if(!added)break;
  }
  const viewNodes=nodes.filter(n=>selected.has(n.id));
  return {nodes:viewNodes,edges:edges.filter(e=>selected.has(e.source)&&selected.has(e.target)),omitted:nodes.length-viewNodes.length};
}

export function layoutGraph(graph) {
  // Deterministic, bounded community layout. Connected hub clusters are spatially
  // distinct; unlike the former two concentric circles this retains cross links.
  const nodes=graph?.nodes||[], edges=graph?.edges||[];
  const byId=new Map(nodes.map(n=>[n.id,n]));
  const adjacent=new Map(nodes.map(n=>[n.id,new Set()]));
  for(const e of edges){if(adjacent.has(e.source)&&adjacent.has(e.target)){
    adjacent.get(e.source).add(e.target);adjacent.get(e.target).add(e.source);
  }}
  const deg=id=>adjacent.get(id)?.size||0;
  // Pick distributed local centers. High degree candidates and their immediate
  // neighbors become distinct communities, avoiding a single massive starburst.
  const positioned=[];
  for(const system of ['repoql','tencent','memories']) {
    const group=nodes.filter(n=>n.source_system===system);
    if(!group.length)continue;
    const sorted=[...group].sort((a,b)=>deg(b.id)-deg(a.id)||a.id.localeCompare(b.id));
    const targetCenters=Math.max(1,Math.min(24,Math.ceil(Math.sqrt(group.length)/3.0)));
    const seeds=[],seeded=new Set();
    for(const n of sorted){
      if(seeds.length>=targetCenters)break;
      if(!seeded.has(n.id)){
        seeds.push(n.id);seeded.add(n.id);
        for(const id of adjacent.get(n.id)||[])seeded.add(id);
      }
    }
    // When a graph is a giant, add extra high-degree seeds for visible subclusters.
    for(const n of sorted){if(seeds.length>=targetCenters)break;if(!seeds.includes(n.id))seeds.push(n.id)}
    const clusters=new Map(seeds.map(id=>[id,[]]));
    for(const n of group){
      let best=seeds[0],score=-Infinity;
      for(let i=0;i<seeds.length;i++){
        const id=seeds[i];
        const immediate=adjacent.get(n.id)?.has(id)?1:0;
        const common=immediate?0:[...adjacent.get(n.id)||[]].filter(x=>adjacent.get(id)?.has(x)).length;
        const val=immediate*100+common*8+Math.min(deg(id),80)*.06+(hash(n.id+id)%1000)*.00001;
        if(val>score){score=val;best=id;}
      }
      clusters.get(best).push(n);
    }
    const shift=nodes.every(n=>n.source_system===system)?0:system==='repoql'?-355:system==='tencent'?355:0;
    const spread=145+Math.sqrt(group.length)*8;
    const communityIds=[...clusters.keys()];
    communityIds.forEach((id,j)=>{
      const community=clusters.get(id).sort((a,b)=>deg(b.id)-deg(a.id)||a.id.localeCompare(b.id));
      const theta=j*2.399963229728653, orbit=j===0?0:Math.sqrt(j/communityIds.length)*spread;
      const cx=shift+Math.cos(theta)*orbit,cy=Math.sin(theta)*orbit*.78;
      const width=Math.max(26,Math.min(175,Math.sqrt(community.length)*16));
      for(let k=0;k<community.length;k++){
        const n=community[k],r=k===0?0:9+Math.sqrt(k)*12;
        const angle=k*2.399963229728653+rand(n.id)*.14;
        positioned.push({...n,x:cx+Math.cos(angle)*Math.min(r,width),y:cy+Math.sin(angle)*Math.min(r,width),
          degree:deg(n.id),r:Math.min(7.5,Math.max(1.9,2.2+Math.log2(1+deg(n.id))*.85)),community:id});
      }
    });
  }
  return positioned;
}

// Lateral brain silhouette (front = left, y grows downward). Star-shaped about
// the origin, so every point with rho < 1 along any angle lies inside.
export const BRAIN = {a:330, b:228, cerebellum:{x:178, y:148, rx:96, ry:58, rot:-.22}};
const bump=(t,c,w)=>{const d=Math.atan2(Math.sin(t-c),Math.cos(t-c))/w;return Math.exp(-d*d)};
export function brainRadius(theta) {
  const {a,b}=BRAIN, c=Math.cos(theta), s=Math.sin(theta);
  let r=(a*b)/Math.sqrt((b*c)**2+(a*s)**2);
  if(s>0)r*=1-.24*s*s;                 // flatter base
  r*=1+.17*bump(theta,2.2,.3);          // temporal lobe, lower front
  r*=1-.075*bump(theta,2.78,.11);       // notch between frontal base and temporal pole
  r*=1-.13*bump(theta,1.22,.26);        // notch above the cerebellum
  r*=1+.05*bump(theta,.18,.38);         // occipital pole
  r*=1+.04*bump(theta,-2.35,.5);        // frontal dome
  return r;
}
export function brainOutline(steps=180) {
  // A faint lobulated edge makes the silhouette read as cortex rather than a smooth blob.
  return Array.from({length:steps},(_,i)=>{const t=-Math.PI+i/steps*TAU,r=brainRadius(t)*(1+.009*Math.sin(t*21)+.005*Math.sin(t*37+1));return {x:Math.cos(t)*r,y:Math.sin(t)*r}});
}

// Brain mode uses a top-down render of a real cortex surface: left hemisphere RepoQL, right Tencent.
// World units match BRAIN_MASK: the image is BRAIN_MASK.w x BRAIN_MASK.h, centred on the origin.
const BUNDLE_BAND=64;
// Cross-system links share channels and cross the midline together, as commissural fibres do.
export function crossControls(a,b){
  const by=v=>Math.max(-192,Math.min(192,Math.round(v/BUNDLE_BAND)*BUNDLE_BAND)),k=.72,s=.8;
  return {c1:{x:a.x*(1-k),y:a.y+(by(a.y)-a.y)*s},c2:{x:b.x*(1-k),y:b.y+(by(b.y)-b.y)*s}};
}
const maskRows=BRAIN_MASK.hemis.map(rows=>new Map(rows.map(r=>[Math.round(r[0]/BRAIN_MASK.step),r])));
// True when the point is inside the hemisphere, at least the mask margin from its edge.
export function insideHemisphere(hemi,x,y){
  const r=maskRows[hemi]?.get(Math.round(y/BRAIN_MASK.step));if(!r)return false;
  for(let i=1;i<r.length;i+=2)if(x>=r[i]&&x<=r[i+1])return true;
  return false;
}
// Even, slightly organic slots filling the whole hemisphere: a jittered hex grid whose
// spacing is solved so it yields at least n points.
function hemisphereSlots(hemi,n){
  if(n<=0)return [];
  const rows=BRAIN_MASK.hemis[hemi];
  const grid=s=>{const out=[];const ys=rows[0][0],ye=rows[rows.length-1][0],dy=s*.866;let iy=0;
    const xs=hemi?0:-BRAIN_MASK.w/2,xe=hemi?BRAIN_MASK.w/2:0;
    for(let y=ys;y<=ye;y+=dy,iy++){let ix=0;
      for(let x=xs+(iy%2?s/2:0);x<=xe;x+=s,ix++){
        if(!insideHemisphere(hemi,x,y))continue;
        const key=`${hemi}|${iy}|${ix}`,jx=x+(rand(key+'x')-.5)*s*.55,jy=y+(rand(key+'y')-.5)*s*.55;
        out.push(insideHemisphere(hemi,jx,jy)?{x:jx,y:jy,key}:{x,y,key});
      }}
    return out};
  let lo=2,hi=400;
  for(let i=0;i<16;i++){const m=(lo+hi)/2;if(grid(m).length>=n)lo=m;else hi=m}
  const slots=grid(lo);
  // Trim any surplus evenly, never from one region.
  return slots.map(p=>[rand(p.key+'t'),p]).sort((a,b)=>a[0]-b[0]).slice(0,n).map(v=>v[1]);
}

// Deterministic brain-shaped layout of the SAME real memory nodes and edges.
// It changes coordinates only, never invents neural relationships or data.
// Compared with the prior direct radial projection, this fills the silhouette
// more evenly, keeps both hemispheres populated, and still preserves stable
// cluster neighbourhoods from the source layout.
export function layoutNeuralGraph(graph) {
  const original=layoutGraph(graph);
  if(!original.length)return [];
  // Hemispheres follow source ownership. Memories line the midline on both sides.
  const left=[],right=[],middle=[];
  for(const node of original)(node.source_system==='tencent'?right:node.source_system==='memories'?middle:left).push(node);
  const byGroup=(a,b)=>String(a.community||'').localeCompare(String(b.community||''))||(a.y-b.y)||String(a.id).localeCompare(String(b.id));
  middle.sort(byGroup);
  const memL=middle.filter((_,i)=>i%2===0),memR=middle.filter((_,i)=>i%2===1);
  const placed=new Map();
  for(const [hemi,own,mem] of [[0,left,memL],[1,right,memR]]){
    const slots=hemisphereSlots(hemi,own.length+mem.length).sort((a,b)=>Math.abs(a.x)-Math.abs(b.x));
    const inner=slots.slice(0,mem.length).sort((a,b)=>a.y-b.y),outer=slots.slice(mem.length);
    // Slots run around the hemisphere's centre, so each community becomes one contiguous patch.
    const cx=outer.reduce((t,p)=>t+p.x,0)/Math.max(1,outer.length),cy=outer.reduce((t,p)=>t+p.y,0)/Math.max(1,outer.length);
    outer.sort((a,b)=>Math.atan2(a.y-cy,a.x-cx)-Math.atan2(b.y-cy,b.x-cx));
    [...own].sort(byGroup).forEach((node,i)=>placed.set(node.id,{...node,x:outer[i].x,y:outer[i].y,hemisphere:hemi,zone:hemi}));
    mem.forEach((node,i)=>placed.set(node.id,{...node,x:inner[i].x,y:inner[i].y,hemisphere:hemi,zone:2}));
  }
  return original.map(node=>placed.get(node.id));
}

export function relationshipDetails(graph, nodeId) {
  const byId=new Map((graph?.nodes||[]).map(n=>[n.id,n]));
  return (graph?.edges||[]).filter(e=>e.source===nodeId||e.target===nodeId).map(e=>({
    ...e, otherId:e.source===nodeId?e.target:e.source,
    other:byId.get(e.source===nodeId?e.target:e.source)||null,
    direction:e.source===nodeId?'outgoing':'incoming'
  }));
}

export function closestGraphEdge(edges, positions, point, tolerance=9, bundled=false) {
  const map=new Map(positions.map(n=>[n.id,n]));let best=null,bestDistance=tolerance;
  for(const e of edges){const a=map.get(e.source),b=map.get(e.target);if(!a||!b)continue;
    if(bundled&&e.source_system==='cross'){
      const {c1,c2}=crossControls(a,b);
      for(let i=0;i<=16;i++){const u=i/16,q=1-u,x=q*q*q*a.x+3*q*q*u*c1.x+3*q*u*u*c2.x+u*u*u*b.x,y=q*q*q*a.y+3*q*q*u*c1.y+3*q*u*u*c2.y+u*u*u*b.y;
        const d=Math.hypot(point.x-x,point.y-y);if(d<bestDistance){best=e;bestDistance=d}}
      continue;
    }
    const dx=b.x-a.x,dy=b.y-a.y,length=dx*dx+dy*dy;
    if(length<1)continue;
    const t=Math.min(1,Math.max(0,((point.x-a.x)*dx+(point.y-a.y)*dy)/length));
    const distance=Math.hypot(point.x-a.x-t*dx,point.y-a.y-t*dy);
    if(distance<bestDistance){best=e;bestDistance=distance;}
  }
  return best;
}

export function dailySeries(events, key='input_tokens') {
  const days=new Map();
  for(const event of events||[]){const date=String(event.day||event.timestamp||'').slice(0,10);if(!/^\d{4}-\d{2}-\d{2}$/.test(date))continue;
    if(!days.has(date))days.set(date,{day:date,value:0,samples:0});
    const val=numeric(event[key]??(key==='value'?event.value:null));
    if(val!==null){days.get(date).value+=val;days.get(date).samples++}
  }
  return [...days.values()].sort((a,b)=>a.day.localeCompare(b.day)).map(v=>({...v,value:v.samples?v.value:null}));
}

export function sparkChart(target, rows, series, {height=220, empty='No measured samples in this period'}={}) {
  // Rows are {day, metric1, metric2}, null = missing. No inferred usage or spend.
  const data=(rows||[]).filter(r=>r&&r.day).slice(-100);
  const keys=(series||[]).filter(s=>data.some(r=>numeric(r[s.key])!==null));
  if(!target)return;
  if(!data.length||!keys.length){target.innerHTML=`<div class="chart-empty">${empty}</div>`;return}
  const width=Math.max(360,Math.round(target.clientWidth||900)),top=20,bottom=height-31,left=52,right=width-16;
  const ceiling=Math.max(1,...data.flatMap(r=>keys.map(k=>numeric(r[k.key])||0)))*1.14;
  const x=i=>left+(right-left)*(data.length===1?.5:i/(data.length-1));
  const y=n=>bottom-(bottom-top)*Math.max(0,Number(n))/ceiling;
  const compact=n=>n>=1e6?(n/1e6).toFixed(1)+'m':n>=1e3?(n/1e3).toFixed(1)+'k':Number(n).toFixed(n<10?1:0);
  const hlines=[0,.25,.5,.75,1].map(p=>`<line x1="${left}" x2="${right}" y1="${y(p*ceiling)}" y2="${y(p*ceiling)}" stroke="#213247" stroke-width="1" stroke-dasharray="3 6"/><text x="${left-11}" y="${y(p*ceiling)+4}" text-anchor="end" font-size="11" fill="#8394ae">${compact(p*ceiling)}</text>`).join('');
  const lines=keys.map(k=>{
    let paths=[],segment=[];
    for(let i=0;i<data.length;i++){const v=numeric(data[i][k.key]);if(v===null){if(segment.length){paths.push(segment.join(' '));segment=[]}continue}segment.push(`${segment.length?'L':'M'}${x(i).toFixed(2)} ${y(v).toFixed(2)}`)}
    if(segment.length)paths.push(segment.join(' '));
    return paths.map(p=>`<path d="${p}" fill="none" stroke="${k.color}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>`).join('')+
      data.map((r,i)=>numeric(r[k.key])!==null?`<circle cx="${x(i)}" cy="${y(r[k.key])}" r="3.1" fill="${k.color}" stroke="#0c1624" stroke-width="1.5"><title>${r.day}: ${k.label} ${Number(r[k.key]).toLocaleString('en-US')}</title></circle>`:'').join('');
  }).join('');
  const times=[0,Math.floor((data.length-1)/2),data.length-1].filter((v,i,a)=>a.indexOf(v)===i).map(i=>`<text x="${x(i)}" y="${height-7}" fill="#8394ae" font-size="11" text-anchor="middle">${data[i].day.slice(5)}</text>`).join('');
  target.innerHTML=`<div class="ob-chart-legend">${keys.map(k=>`<span><i style="background:${k.color}"></i>${k.label}</span>`).join('')}</div><svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="Measured historical trend chart">${hlines}${lines}${times}</svg>`;
}


// Colour the grey cortex photo once: cool blue on the RepoQL (left) hemisphere, violet on Tencent (right).
let tintedCache=null;
function tintedBrain(img){
  if(tintedCache&&tintedCache.src===img)return tintedCache.canvas;
  const w=img.naturalWidth,h=img.naturalHeight,c=document.createElement('canvas');c.width=w;c.height=h;
  const o=c.getContext('2d');o.drawImage(img,0,0,w,h);
  o.globalCompositeOperation='source-atop';
  const g=o.createLinearGradient(0,0,w,0);
  g.addColorStop(0,'rgba(34,170,255,.62)');g.addColorStop(.46,'rgba(60,120,255,.5)');
  g.addColorStop(.54,'rgba(150,90,255,.5)');g.addColorStop(1,'rgba(200,80,255,.62)');
  o.fillStyle=g;o.fillRect(0,0,w,h);
  o.globalCompositeOperation='lighter';o.globalAlpha=.18;o.drawImage(img,0,0,w,h);
  tintedCache={src:img,canvas:c};return c;
}
// One decoded brain image is shared by every graph on the page.
let brainImage=null;
function getBrainImage(onload){
  if(!brainImage){brainImage=new Image();brainImage.decoding='async';brainImage.src=new URL('./brain_top.webp',import.meta.url).href}
  if(!brainImage.complete)brainImage.addEventListener('load',onload,{once:true});
  return brainImage;
}

export function createKnowledgeGraph(canvas,{onSelect,mode='network'}={}) {
  let ctx=canvas.getContext('2d');const mainCtx=ctx;
  let graph={nodes:[],edges:[]},positions=[],rendered={nodes:[],edges:[]};
  let selected=null,selectedEdge=null,hovered=null,hoveredEdge=null;
  let zoom=1,pan={x:0,y:0},drag=null,raf=0,disposed=false;
  let viewMode=mode==='neural'||mode==='3d'?'neural':'network',frameAt=0;
  // 3D: a WebGL cortex (brain3d_view.js) loaded on demand; it reuses this graph's filters, layout and selection.
  let three=null,use3d=false,want3d=false,modePromise=Promise.resolve();
  const pointers=new Map();let pinch=null;
  const reduced=window.matchMedia?.('(prefers-reduced-motion: reduce)');
  let opts={sources:['repoql','tencent','memories'],cross:true,query:'',detail:'all',connections:'all'};
  let renderVersion=0,counts={rq:0,tx:0,mem:0},fitZoom=1;
  function recalc(){
    const filtered=filterGraph(graph,opts);
    const simplified=opts.detail==='overview'&&!String(opts.query||'').trim()
      ? focusGraph(filtered,72):filtered;
    renderVersion++;
    rendered={...simplified,nodes:simplified.nodes,edges:simplified.edges,omitted:simplified.omitted||0,
      totalVisibleBeforeProjection:filtered.nodes.length};
    const map=new Map(positions.map(p=>[p.id,p]));
    rendered.nodes=rendered.nodes.map(n=>map.get(n.id)).filter(Boolean);
    counts={rq:0,tx:0,mem:0};for(const n of rendered.nodes)counts[n.source_system==='tencent'?'tx':n.source_system==='memories'?'mem':'rq']++;
    if(selected&&!rendered.nodes.some(n=>n.id===selected.id))selected=null;
    if(selectedEdge&&!rendered.edges.some(e=>e===selectedEdge||(e.id!=null&&e.id===selectedEdge.id)))selectedEdge=null;
    schedule();
  }
  const coarse=window.matchMedia?.('(pointer:coarse)')?.matches===true;
  let onScreen=true,animTimer=0;
  // Only the travelling pulses animate, and only while the graph is on screen.
  // Brain mode is always alive while it is on screen (operator 2026-11-11): the impulses keep travelling
  // without any drag or click. It stops when the tab is hidden, the canvas is off screen or the page is left.
  const animating=()=>!use3d&&viewMode==='neural'&&!document.hidden&&onScreen&&canvas.isConnected&&!canvas.hidden&&(pulseList.length>0||rendered.nodes.length>0);
  function schedule(){
    if(disposed||raf||document.hidden||canvas.hidden||!canvas.isConnected)return;
    clearTimeout(animTimer);
    raf=requestAnimationFrame(()=>{
      raf=0;if(disposed||document.hidden||canvas.hidden||!canvas.isConnected)return;
      draw();
      if(animating())animTimer=setTimeout(schedule,coarse?80:50);
    });
  }
  // ---- Render caches. The whole scene (brain, links, nodes) is one bitmap, repainted only when
  // the view, selection or data change. Dragging moves the bitmap. Nothing is sampled or dropped.
  const spriteCache=new Map();
  function glowSprite(color,end='rgba(0,0,0,0)'){const ck=color+'|'+end;let c=spriteCache.get(ck);if(c)return c;
    c=document.createElement('canvas');c.width=c.height=48;const o=c.getContext('2d');
    const g=o.createRadialGradient(24,24,0,24,24,24);g.addColorStop(0,color);g.addColorStop(1,end);
    o.fillStyle=g;o.fillRect(0,0,48,48);spriteCache.set(ck,c);return c;}
  function drawGlow(color,x,y,r,end){ctx.drawImage(glowSprite(color,end),x-r,y-r,r*2,r*2)}
  let scene=null,sceneKey='',sceneView=null,interactAt=0,settleTimer=0,pulseList=[],userMoved=false;
  function markInteract(){userMoved=true;interactAt=performance.now();clearTimeout(settleTimer);settleTimer=setTimeout(()=>schedule(),170)}
  let bg=null,bgKey='';
  function background(w,h,d,neural,calm){
    const caption=`${rendered.nodes.length.toLocaleString()}${rendered.omitted?' of '+rendered.totalVisibleBeforeProjection.toLocaleString():''} topics · ${opts.connections==='focus'?'links on focus':rendered.edges.length.toLocaleString()+' links'} · ${neural?'brain view':'network view'}`;
    const key=[w,h,d,neural,calm,caption,counts.rq,counts.tx,counts.mem,fitZoom].join('|');
    if(bg&&bgKey===key)return bg;
    bg||=document.createElement('canvas');bg.width=Math.round(w*d);bg.height=Math.round(h*d);bgKey=key;
    const o=bg.getContext('2d');o.setTransform(d,0,0,d,0,0);
    o.fillStyle=calm?CALM.bg:'#02060c';o.fillRect(0,0,w,h);
    const v=o.createRadialGradient(w*.5,h*.45,0,w*.5,h*.45,Math.max(w,h)*.7);
    v.addColorStop(0,calm?'rgba(38,38,46,.45)':neural?'rgba(40,24,92,.55)':'rgba(10,40,64,.6)');v.addColorStop(.6,calm?'rgba(20,20,24,.15)':'rgba(5,16,30,.3)');v.addColorStop(1,calm?'rgba(0,0,0,.4)':'rgba(0,0,0,.6)');
    o.fillStyle=v;o.fillRect(0,0,w,h);
    o.font='600 11px system-ui, sans-serif';const cw=o.measureText(caption).width+26;
    o.fillStyle=calm?CALM.captionBg:'rgba(3,8,17,.78)';o.strokeStyle=calm?'rgba(255,255,255,.08)':'rgba(80,200,255,.25)';o.beginPath();o.roundRect?.(12,h-38,Math.min(cw,w-24),26,13);o.fill();o.stroke();
    o.fillStyle=calm?CALM.caption:'#a9d8ea';o.fillText(caption,25,h-21);
    if(neural){o.font='600 12px system-ui, sans-serif';o.textAlign='center';
      const off=Math.max(118,Math.min(w/2-50,fitZoom*BRAIN_MASK.w*.34));
      for(const [x,name,c,col] of [[-off,'RepoQL',counts.rq,calm?CALM.rqMajor:'#8fe9ff'],[0,'Memories',counts.mem,calm?CALM.memMajor:'#a8f5c8'],[off,'Tencent',counts.tx,calm?CALM.txMajor:'#d2bcff']]){
        o.fillStyle=col;o.fillText(`${name} · ${c.toLocaleString()}`,w/2+x,21)}
      o.textAlign='left';}
    return bg;
  }
  // Links without an id must not all match an empty selection.
  const edgeKeyOf=e=>e?(e.id??`${e.source}>${e.target}`):'';
  const sameEdge=(x,e)=>!!x&&(x===e||(x.id!=null&&x.id===e.id));
  function paintScene(w,h,neural,calm,activeId){
    const map=new Map(rendered.nodes.map(n=>[n.id,n]));
    const lw=1/Math.sqrt(Math.max(.4,zoom)),pulses=[];
    if(neural){const img=getBrainImage(()=>{sceneKey='';schedule()});
      if(img.complete&&img.naturalWidth)ctx.drawImage(tintedBrain(img),-BRAIN_MASK.w/2,-BRAIN_MASK.h/2,BRAIN_MASK.w,BRAIN_MASK.h);}
    ctx.globalCompositeOperation='lighter';ctx.lineCap='round';
    // Parallel links between one pair fan out, so additive blending cannot stack them into a solid white line.
    const pairSeen=new Map();
    for(const e of rendered.edges){const a=map.get(e.source),b=map.get(e.target);if(!a||!b)continue;
      const pk=e.source<e.target?`${e.source}|${e.target}`:`${e.target}|${e.source}`,pi=pairSeen.get(pk)||0;pairSeen.set(pk,pi+1);
      const fan=(pi%2?1:-1)*Math.ceil(pi/2);
      const connected=activeId&&(e.source===activeId||e.target===activeId);
      const picked=sameEdge(selectedEdge,e)||sameEdge(hoveredEdge,e);
      if(opts.connections==='focus'&&!connected&&!picked)continue;
      const active=picked||connected;
      const faded=activeId&&!active;
      ctx.beginPath();ctx.moveTo(a.x,a.y);
      const isCross=e.source_system==='cross',bundle=neural&&isCross;
      // Cross-system links are bundled into shared channels; others keep a slight curve.
      const mx=(a.x+b.x)/2,my=(a.y+b.y)/2,bend=(rand(e.id||e.source+e.target)-.5)*(neural?.12:.35)+fan*.035;
      let k=bundle?crossControls(a,b):null;
      if(k&&fan)k={c1:{x:k.c1.x,y:k.c1.y+fan*7},c2:{x:k.c2.x,y:k.c2.y+fan*7}};
      if(k)ctx.bezierCurveTo(k.c1.x,k.c1.y,k.c2.x,k.c2.y,b.x,b.y);
      else ctx.quadraticCurveTo(mx-(b.y-a.y)*bend,my+(b.x-a.x)*bend,b.x,b.y);
      // Within-system links rest faint; cross-system links carry the visual weight.
      if(calm){
        ctx.strokeStyle=active?CALM.active:isCross?`rgba(${CALM.cross},${faded?.08:neural?.34:.34})`:
          e.source_system==='tencent'?`rgba(${CALM.txEdge},${faded?.05:neural?.12:.2})`:`rgba(${CALM.rqEdge},${faded?.05:neural?.12:.2})`;
      }else ctx.strokeStyle=active?'rgba(190,250,255,.95)':isCross?`rgba(255,196,110,${faded?.10:.42})`:
        e.source_system==='tencent'?`rgba(170,130,255,${faded?.05:neural?.13:.26})`:`rgba(70,215,250,${faded?.05:neural?.13:.26})`;
      ctx.lineWidth=(active?1.8:isCross?1.05:.7)*lw;ctx.stroke();
      if(neural&&pulses.length<(coarse?110:260)&&(active||hash(e.id||`${e.source}:${e.target}`)%(isCross?(coarse?3:2):(coarse?14:9))===0))
        pulses.push({a,b,k,cx:mx-(b.y-a.y)*bend,cy:my+(b.x-a.x)*bend,active,ph:rand(e.id||e.source+e.target)});
    }
    pulseList=pulses;
    const linked=new Set();if(activeId)for(const e of rendered.edges){if(e.source===activeId)linked.add(e.target);if(e.target===activeId)linked.add(e.source)}
    // Importance sets size in Brain mode. Cores stay under the mask margin, so they cannot cross the outline.
    const boost=Math.max(1,Math.min(1.9,.8/zoom));
    const rr=n=>neural?Math.min(9.5,boost*(n.degree>8?Math.min(11,n.r*(1.15+Math.min(.6,(n.degree-8)/80))):Math.min(n.r,5)*.85)):n.r*boost;
    for(const n of rendered.nodes){const highlight=n.id===activeId,near=linked.has(n.id);
      if(activeId&&!highlight&&!near&&n.degree<=8)continue;
      const tx=n.source_system==='tencent',mem=n.source_system==='memories';
      const size=calm?(highlight?28:rr(n)*(n.degree>8?4.4:2.8)):(highlight?34:rr(n)*(n.degree>8?5.2:3.2));
      drawGlow(calm?(highlight?'rgba(236,236,239,.35)':tx?`rgba(${CALM.txEdge},.16)`:mem?'rgba(154,211,176,.14)':`rgba(${CALM.rqEdge},.16)`)
        :highlight?'rgba(230,252,255,.55)':tx?'rgba(170,130,255,.30)':mem?'rgba(120,235,170,.32)':'rgba(60,220,255,.30)',n.x,n.y,size);}
    ctx.globalCompositeOperation='source-over';
    const labels=[];
    for(const n of rendered.nodes){const highlight=n.id===activeId,near=linked.has(n.id),major=n.degree>8,tx=n.source_system==='tencent',mem=n.source_system==='memories';
      ctx.globalAlpha=activeId&&!highlight&&!near?.35:(neural&&!major&&!highlight?.88:1);
      ctx.fillStyle=calm?(highlight?'#ffffff':major?(tx?CALM.txMajor:mem?CALM.memMajor:CALM.rqMajor):(tx?CALM.tx:mem?CALM.mem:CALM.rq)):highlight?'#ffffff':major?(tx?'#e3d6ff':mem?'#d9f7e6':'#d5fbff'):(tx?'#b79bff':mem?'#8ef0b6':'#5fe3fb');
      const nr=rr(n);
      ctx.beginPath();ctx.arc(n.x,n.y,nr+(highlight?1.5:0),0,TAU);ctx.fill();
      if(highlight||major){ctx.lineWidth=1.2*lw;ctx.strokeStyle=calm?'rgba(200,200,212,.3)':tx?'rgba(190,160,255,.8)':mem?'rgba(150,240,190,.8)':'rgba(140,240,255,.8)';ctx.beginPath();ctx.arc(n.x,n.y,nr+(highlight?4:1.5),0,TAU);ctx.stroke();}
      ctx.globalAlpha=1;
      // Names appear for the hovered/selected node; once zoomed in, hub names appear too.
      if(highlight)labels.push([n,highlight,1e9,nr]);
      else if(major&&zoom>=fitZoom*2)labels.push([n,false,n.degree,nr]);
    }
    labels.sort((a,b)=>b[2]-a[2]);const placedLabels=[];let budget=Math.round(10*Math.max(1,zoom*zoom));
    const scale=1/Math.max(.5,zoom);
    for(const [n,highlight,prio,nr] of labels){if(prio<1e6&&budget--<=0)break;const text=String(n.display_label||n.label||'').slice(0,30);
      ctx.font=`${highlight?'600':'500'} ${((highlight?13:11)*scale).toFixed(1)}px system-ui, sans-serif`;const tw=ctx.measureText(text).width;
      // Flip to the node's left when the name would run off the panel.
      let lx=n.x+nr+6*scale;const sx=w/2+pan.x+zoom*lx;
      if(sx+(tw+8*scale)*zoom>w-4)lx=n.x-nr-6*scale-tw;
      lx=Math.max((4-w/2-pan.x)/zoom+4*scale,lx);
      const ly=n.y-6*scale,box={x:lx-4*scale,y:ly-11*scale,w:tw+8*scale,h:16*scale};
      if(!highlight&&placedLabels.some(o=>box.x<o.x+o.w&&o.x<box.x+box.w&&box.y<o.y+o.h&&o.y<box.y+box.h))continue;
      placedLabels.push(box);
      ctx.fillStyle=calm?CALM.labelBg:'rgba(2,8,16,.78)';ctx.beginPath();ctx.roundRect?.(box.x,box.y,box.w,box.h,4*scale);ctx.fill();
      ctx.fillStyle=highlight?'#ffffff':calm?CALM.label:'#bcd6e6';ctx.fillText(text,lx,ly+scale);}
    if(selectedEdge){const a=map.get(selectedEdge.source),b=map.get(selectedEdge.target);if(a&&b){let mx=(a.x+b.x)/2,my=(a.y+b.y)/2;
      if(neural&&selectedEdge.source_system==='cross'){const {c1,c2}=crossControls(a,b);mx=(a.x+3*c1.x+3*c2.x+b.x)/8;my=(a.y+3*c1.y+3*c2.y+b.y)/8}
      drawGlow('rgba(255,195,90,.6)',mx,my,12);ctx.fillStyle='#ffe2a8';ctx.beginPath();ctx.arc(mx,my,4,0,TAU);ctx.fill();}}
  }
  function draw(){const w=canvas.clientWidth,h=canvas.clientHeight;if(!w||!h)return;
    if(use3d){three?.setGraph(rendered,renderVersion,selected?.id||null);return}
    const now=performance.now(),neural=viewMode==='neural',calm=isCalm(),d=Math.min(window.devicePixelRatio||1,2);
    const activeId=selected?.id||hovered?.id,m=Math.round(Math.min(w,h)*.3);
    const nv=[renderVersion,w,h,d,calm,neural,activeId||'',edgeKeyOf(selectedEdge),edgeKeyOf(hoveredEdge),opts.connections].join('|');
    const viewChanged=!sceneView||sceneView.zoom!==zoom||sceneView.px!==pan.x||sceneView.py!==pan.y;
    if(!scene||nv!==sceneKey||(viewChanged&&now-interactAt>=150)){
      scene||=document.createElement('canvas');
      const lw0=Math.round((w+2*m)*d),lh0=Math.round((h+2*m)*d);
      if(scene.width!==lw0||scene.height!==lh0){scene.width=lw0;scene.height=lh0}
      const o=scene.getContext('2d');
      o.setTransform(1,0,0,1,0,0);o.clearRect(0,0,scene.width,scene.height);
      o.setTransform(d,0,0,d,0,0);o.translate(m+w/2+pan.x,m+h/2+pan.y);o.scale(zoom,zoom);
      const prev=ctx;ctx=o;try{paintScene(w,h,neural,calm,activeId)}finally{ctx=prev}
      sceneKey=nv;sceneView={zoom,px:pan.x,py:pan.y};
    }
    ctx.setTransform(d,0,0,d,0,0);ctx.globalCompositeOperation='source-over';
    ctx.drawImage(background(w,h,d,neural,calm),0,0,w,h);
    const sc=zoom/sceneView.zoom;
    ctx.save();ctx.translate(w/2+pan.x,h/2+pan.y);ctx.scale(sc,sc);ctx.translate(-w/2-sceneView.px-m,-h/2-sceneView.py-m);
    ctx.drawImage(scene,0,0,w+2*m,h+2*m);ctx.restore();
    if(neural&&rendered.nodes.length){
      // Neurons fire: a rolling subset of nodes flashes in time, drawn over the cached scene each frame.
      ctx.save();ctx.translate(w/2+pan.x,h/2+pan.y);ctx.scale(zoom,zoom);ctx.globalCompositeOperation='lighter';
      const nl=rendered.nodes,step=Math.max(1,Math.floor(nl.length/(coarse?40:90))),fr=Math.max(1,Math.min(1.9,.8/zoom));
      for(let i=0;i<nl.length;i+=step){const n=nl[i],ph=((now*.0006+rand(String(n.id)))%1),k=Math.sin(ph*Math.PI);
        if(k<.15)continue;
        drawGlow(n.source_system==='tencent'?'rgba(214,160,255,.85)':'rgba(130,235,255,.85)',n.x,n.y,(5+9*k)*fr,'rgba(120,120,255,0)');}
      ctx.restore();
    }
    if(neural&&pulseList.length){
      ctx.save();ctx.translate(w/2+pan.x,h/2+pan.y);ctx.scale(zoom,zoom);ctx.globalCompositeOperation='lighter';
      const pr=Math.max(1,Math.min(1.9,.8/zoom));
      for(const p of pulseList){
        const phase=(now*(calm?.00014:.00022)+p.ph)%1,q=1-phase,{a,b}=p;let px,py;
        if(p.k){const {c1,c2}=p.k;px=q*q*q*a.x+3*q*q*phase*c1.x+3*q*phase*phase*c2.x+phase*phase*phase*b.x;py=q*q*q*a.y+3*q*q*phase*c1.y+3*q*phase*phase*c2.y+phase*phase*phase*b.y}
        else{px=q*q*a.x+2*q*phase*p.cx+phase*phase*b.x;py=q*q*a.y+2*q*phase*p.cy+phase*phase*b.y}
        drawGlow(p.active?'rgba(255,255,255,.95)':calm?'rgba(226,232,240,.6)':'rgba(120,255,240,.8)',px,py,(p.active?10:7.5)*pr,calm?'rgba(226,232,240,0)':'rgba(60,240,230,0)');
      }
      ctx.restore();
    }
  }
  function fitView(){if(!rendered.nodes.length)return;
    if(viewMode==='neural'){
      // Frame the brain itself, under the region names.
      const narrow=canvas.clientWidth<520,pad=narrow?14:36,top=30;
      zoom=Math.min(2.2,Math.max(.18,Math.min((canvas.clientWidth-pad)/BRAIN_MASK.w,(canvas.clientHeight-pad-top)/BRAIN_MASK.h)));
      pan={x:0,y:top/2};
    }else{
      const xs=rendered.nodes.map(n=>n.x),ys=rendered.nodes.map(n=>n.y);
      const pad=canvas.clientWidth<520?70:130,spanX=Math.max(...xs)-Math.min(...xs)+pad,spanY=Math.max(...ys)-Math.min(...ys)+pad;
      zoom=Math.min(2.2,Math.max(.18,Math.min(canvas.clientWidth/spanX,canvas.clientHeight/spanY)));
      pan={x:-(Math.min(...xs)+Math.max(...xs))/2*zoom,y:-(Math.min(...ys)+Math.max(...ys))/2*zoom};
    }
    fitZoom=zoom;userMoved=false;schedule()}
  function resize(){if(disposed)return;const d=Math.min(window.devicePixelRatio||1,2);
    canvas.width=Math.max(1,Math.round(canvas.clientWidth*d));canvas.height=Math.max(1,Math.round(canvas.clientHeight*d));ctx.setTransform(d,0,0,d,0,0);
    // Until the user pans or zooms, keep the whole brain framed as the panel settles to its real size.
    if(!userMoved&&canvas.clientWidth>0)fitView();else schedule()}
  function position(e){const rect=canvas.getBoundingClientRect();return {x:(e.clientX-rect.left-rect.width/2-pan.x)/zoom,y:(e.clientY-rect.top-rect.height/2-pan.y)/zoom}}
  function nearestNode(e){const p=position(e);let best=null,dist=12/zoom;for(const n of rendered.nodes){const d=Math.hypot(n.x-p.x,n.y-p.y);if(d<dist){dist=d;best=n}}return best}
  function nearestEdge(e){return closestGraphEdge(rendered.edges,rendered.nodes,position(e),Math.min(15,7/zoom),viewMode==='neural')}
  function notify(){onSelect?.(selected,rendered.edges,selectedEdge)}
  const clampZoom=value=>Math.max(.12,Math.min(8,value));
  function zoomAt(next,clientX,clientY){
    markInteract();const p=position({clientX,clientY});zoom=clampZoom(next);
    const r=canvas.getBoundingClientRect();
    pan.x=clientX-r.left-r.width/2-p.x*zoom;
    pan.y=clientY-r.top-r.height/2-p.y*zoom;
    schedule();
  }
  function midOf(a,b){return {x:(a.x+b.x)/2,y:(a.y+b.y)/2};}
  function down(e){
    if(e.pointerType==='mouse'&&e.button!==0)return;
    pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
    canvas.setPointerCapture(e.pointerId);
    if(pointers.size===1){drag={id:e.pointerId,x:e.clientX,y:e.clientY,moved:false};pinch=null;}
    if(pointers.size>=2){const [a,b]=[...pointers.values()];
      const center=midOf(a,b);pinch={distance:Math.max(1,Math.hypot(a.x-b.x,a.y-b.y)),initialZoom:zoom,
        anchor:position({clientX:center.x,clientY:center.y})};drag=null;
    }
  }
  function move(e){
    if(pointers.has(e.pointerId)){
      pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
      if(pointers.size>=2&&pinch){
        markInteract();
        const [a,b]=[...pointers.values()],center=midOf(a,b);
        zoom=clampZoom(pinch.initialZoom*Math.hypot(a.x-b.x,a.y-b.y)/pinch.distance);
        const rect=canvas.getBoundingClientRect();
        pan.x=center.x-rect.left-rect.width/2-pinch.anchor.x*zoom;
        pan.y=center.y-rect.top-rect.height/2-pinch.anchor.y*zoom;
        schedule();return;
      }
      if(drag&&drag.id===e.pointerId){const dx=e.clientX-drag.x,dy=e.clientY-drag.y;
        if(Math.abs(dx)+Math.abs(dy)>2)drag.moved=true;
        markInteract();pan.x+=dx;pan.y+=dy;drag.x=e.clientX;drag.y=e.clientY;schedule();return;
      }
    }
    const n=nearestNode(e),edge=n?null:nearestEdge(e);
    if(n?.id!==hovered?.id||edgeKeyOf(edge)!==edgeKeyOf(hoveredEdge)){
      hovered=n;hoveredEdge=edge;canvas.style.cursor=n||edge?'pointer':'grab';schedule();
    }
  }
  function leave(){if(!pointers.size){hovered=null;hoveredEdge=null;canvas.style.cursor='grab';schedule()}}
  function up(e){
    const tapped=drag&&drag.id===e.pointerId&&!drag.moved&&pointers.size===1;
    pointers.delete(e.pointerId);
    if(tapped){selected=nearestNode(e);selectedEdge=selected?null:nearestEdge(e);notify();schedule();}
    if(pinch){pinch=null;drag=null;} // never turn a finished pinch into a tap
    else if(drag?.id===e.pointerId)drag=null;
    if(pointers.size===0)canvas.style.cursor='grab';
  }
  function cancel(e){pointers.delete(e.pointerId);drag=null;pinch=null;}
  function wheel(e){e.preventDefault();
    zoomAt(zoom*Math.exp(-e.deltaY*.0017),e.clientX,e.clientY);
  }
  function keys(e){if(e.key==='+'||e.key==='='){zoomAt(zoom*1.2,canvas.getBoundingClientRect().left+canvas.clientWidth/2,canvas.getBoundingClientRect().top+canvas.clientHeight/2);e.preventDefault()}
    if(e.key==='-'){zoomAt(zoom/1.2,canvas.getBoundingClientRect().left+canvas.clientWidth/2,canvas.getBoundingClientRect().top+canvas.clientHeight/2);e.preventDefault()}
    if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)){
      markInteract();const [dx,dy]={ArrowLeft:[35,0],ArrowRight:[-35,0],ArrowUp:[0,35],ArrowDown:[0,-35]}[e.key];pan.x+=dx;pan.y+=dy;schedule();e.preventDefault();
    }
    if(e.key==='Escape'){selected=null;selectedEdge=null;notify();schedule()}}
  function visibility(){if(!document.hidden)schedule()}
  canvas.addEventListener('pointerdown',down);canvas.addEventListener('pointermove',move);canvas.addEventListener('pointerup',up);
  canvas.addEventListener('pointercancel',cancel);canvas.addEventListener('lostpointercapture',cancel);
  canvas.addEventListener('wheel',wheel,{passive:false});canvas.addEventListener('keydown',keys);canvas.addEventListener('pointerleave',leave);
  document.addEventListener('visibilitychange',visibility);
  const watcher=new ResizeObserver(resize);watcher.observe(canvas);
  const seen=window.IntersectionObserver?new IntersectionObserver(([en])=>{const was=onScreen;onScreen=en.isIntersecting;if(onScreen&&!was)schedule()}):null;seen?.observe(canvas);
  async function enter3d(){
    if(use3d)return;
    if(viewMode!=='neural'){viewMode='neural';positions=layoutNeuralGraph(graph);recalc();}
    try{
      if(!three){const mod=await import('./brain3d_view.js?v=3d5');
        const made=await mod.createBrain3D(canvas,{onPick:id=>{selected=id?rendered.nodes.find(n=>n.id===id)||null:null;selectedEdge=null;notify();schedule()}});
        if(disposed){made.dispose();return}three=made}
      if(!want3d){three.hide();return}
      use3d=true;canvas.style.visibility='hidden';three.show();schedule();
    }catch(error){console.warn('3D brain unavailable, staying in Brain view',error);use3d=false;canvas.style.visibility=''}
  }
  function leave3d(){if(!use3d&&!three)return;use3d=false;canvas.style.visibility='';three?.hide();userMoved=false;if(canvas.clientWidth)fitView();schedule()}
  const api={
    update(data){graph=data||{nodes:[],edges:[]};positions=viewMode==='neural'?layoutNeuralGraph(graph):layoutGraph(graph);recalc();},
    setMode(mode){
      if(mode==='3d'){want3d=true;modePromise=enter3d();return modePromise}
      want3d=false;leave3d();
      const next=mode==='neural'?'neural':'network';if(viewMode===next)return;
      viewMode=next;positions=next==='neural'?layoutNeuralGraph(graph):layoutGraph(graph);recalc();this.fit();},
    settled(){return modePromise},
    getMode(){return use3d?'3d':viewMode},
    redraw(){schedule()},
    zoomBy(factor){if(use3d){three?.zoomBy(factor);return}const r=canvas.getBoundingClientRect();zoomAt(zoom*factor,r.left+r.width/2,r.top+r.height/2);},
    filter(filter){opts={...opts,...filter};recalc();},
    getOptions(){return {...opts}},
    focus(id){selected=rendered.nodes.find(n=>n.id===id)||null;selectedEdge=null;if(use3d&&selected)three?.focusNode(id);
      if(selected){userMoved=true;pan.x=-zoom*selected.x;pan.y=-zoom*selected.y;}notify();schedule()},
    focusEdge(id){selectedEdge=rendered.edges.find(e=>e.id===id)||null;selected=null;notify();schedule()},
    fit(){if(use3d){three?.fit();return}fitView()},
    reset(){this.fit()},getVisible(){return rendered},
    dispose(){disposed=true;three?.dispose();three=null;clearTimeout(settleTimer);clearTimeout(animTimer);scene=null;bg=null;pointers.clear();watcher.disconnect();seen?.disconnect();cancelAnimationFrame(raf);
      document.removeEventListener('visibilitychange',visibility);
      for(const [ev,fn] of [['pointerdown',down],['pointermove',move],['pointerup',up],['pointercancel',cancel],['lostpointercapture',cancel],['wheel',wheel],['keydown',keys],['pointerleave',leave]])canvas.removeEventListener(ev,fn)}
  };
  if(mode==='3d')queueMicrotask(()=>api.setMode('3d'));
  return api;
}
