// Self-contained visualization utilities. No provider calls, credentials, CDN, or framework.
// Pure layout/filter/series functions are exported for regression tests.
const TAU = Math.PI * 2;
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
  r*=1+.15*bump(theta,2.45,.34);        // temporal lobe, lower front
  r*=1-.13*bump(theta,1.22,.26);        // notch above the cerebellum
  r*=1+.05*bump(theta,.18,.38);         // occipital pole
  r*=1+.04*bump(theta,-2.35,.5);        // frontal dome
  return r;
}
export function brainOutline(steps=180) {
  return Array.from({length:steps},(_,i)=>{const t=-Math.PI+i/steps*TAU,r=brainRadius(t);return {x:Math.cos(t)*r,y:Math.sin(t)*r}});
}

// Deterministic brain-shaped layout of the SAME real memory nodes and edges.
// It changes coordinates only, never invents neural relationships or data.
// Community structure from layoutGraph is preserved: the network layout is
// normalised to a square, mapped to a disc, then into the brain silhouette.
export function layoutNeuralGraph(graph) {
  const original=layoutGraph(graph);
  if(!original.length)return [];
  const xs=original.map(n=>n.x),ys=original.map(n=>n.y);
  const minX=Math.min(...xs),maxX=Math.max(...xs),minY=Math.min(...ys),maxY=Math.max(...ys);
  const sx=Math.max(1,maxX-minX)/2,sy=Math.max(1,maxY-minY)/2,mx=(minX+maxX)/2,my=(minY+maxY)/2;
  return original.map(n=>{
    // Tiny deterministic jitter keeps coincident community centres apart.
    const u=Math.max(-1,Math.min(1,(n.x-mx)/sx+(rand(n.id+'|u')-.5)*.04));
    const v=Math.max(-1,Math.min(1,(n.y-my)/sy+(rand(n.id+'|v')-.5)*.04));
    const dx=u*Math.sqrt(1-v*v/2),dy=v*Math.sqrt(1-u*u/2);
    const rho=Math.min(1,Math.hypot(dx,dy)),theta=Math.atan2(dy,dx);
    const r=brainRadius(theta)*(.1+.8*rho);
    return {...n,x:Math.cos(theta)*r,y:Math.sin(theta)*r,hemisphere:Math.cos(theta)*r<0?0:1};
  });
}

export function relationshipDetails(graph, nodeId) {
  const byId=new Map((graph?.nodes||[]).map(n=>[n.id,n]));
  return (graph?.edges||[]).filter(e=>e.source===nodeId||e.target===nodeId).map(e=>({
    ...e, otherId:e.source===nodeId?e.target:e.source,
    other:byId.get(e.source===nodeId?e.target:e.source)||null,
    direction:e.source===nodeId?'outgoing':'incoming'
  }));
}

export function closestGraphEdge(edges, positions, point, tolerance=9) {
  const map=new Map(positions.map(n=>[n.id,n]));let best=null,bestDistance=tolerance;
  for(const e of edges){const a=map.get(e.source),b=map.get(e.target);if(!a||!b)continue;
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
  const width=900,top=20,bottom=height-31,left=52,right=width-16;
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

export function createKnowledgeGraph(canvas,{onSelect,mode='network'}={}) {
  const ctx=canvas.getContext('2d');
  let graph={nodes:[],edges:[]},positions=[],rendered={nodes:[],edges:[]};
  let selected=null,selectedEdge=null,hovered=null,hoveredEdge=null;
  let zoom=1,pan={x:0,y:0},drag=null,raf=0,disposed=false;
  let viewMode=mode==='neural'?'neural':'network',frameAt=0;
  const pointers=new Map();let pinch=null;
  const reduced=window.matchMedia?.('(prefers-reduced-motion: reduce)');
  let opts={sources:['repoql','tencent'],cross:true,query:''};
  const TAU=Math.PI*2;
  function recalc(){rendered=filterGraph(graph,opts);const map=new Map(positions.map(p=>[p.id,p]));
    rendered.nodes=rendered.nodes.map(n=>map.get(n.id)).filter(Boolean);
    if(selected&&!rendered.nodes.some(n=>n.id===selected.id))selected=null;
    if(selectedEdge&&!rendered.edges.some(e=>e.id===selectedEdge.id))selectedEdge=null;
    schedule();
  }
  function schedule(){if(disposed||raf)return;raf=requestAnimationFrame((time)=>{
    raf=0;if(disposed)return;
    if(viewMode==='neural'&&!reduced?.matches&&!document.hidden){
      if(time-frameAt>=32){frameAt=time;draw()}schedule();
    }else draw();
  })}
  let brainCache=null;
  function brainPath(){const path=new Path2D(),pts=brainOutline(220);
    pts.forEach((p,i)=>i?path.lineTo(p.x,p.y):path.moveTo(p.x,p.y));path.closePath();return path}
  function drawBrain(t){
    // Stylised cortex, sulci and cerebellum are a navigation aid, not a claim
    // that the backend contains an anatomical neural model.
    brainCache||={outline:brainPath()};
    const {outline}=brainCache,{cerebellum:cb}=BRAIN,breathe=.5+.5*Math.sin(t*.0012);
    ctx.save();
    // Brain stem and cerebellum sit behind the cerebrum.
    ctx.beginPath();ctx.moveTo(78,150);ctx.bezierCurveTo(92,205,96,250,88,300);ctx.lineTo(132,300);ctx.bezierCurveTo(132,250,138,200,150,150);ctx.closePath();
    const stem=ctx.createLinearGradient(0,150,0,300);stem.addColorStop(0,'rgba(64,92,190,.32)');stem.addColorStop(1,'rgba(64,92,190,0)');
    ctx.fillStyle=stem;ctx.fill();ctx.strokeStyle='rgba(110,200,255,.22)';ctx.lineWidth=1.2;ctx.stroke();
    ctx.beginPath();ctx.ellipse(cb.x,cb.y,cb.rx,cb.ry,cb.rot,0,TAU);
    const cg=ctx.createRadialGradient(cb.x,cb.y,4,cb.x,cb.y,cb.rx);cg.addColorStop(0,'rgba(120,80,230,.30)');cg.addColorStop(1,'rgba(40,30,110,.12)');
    ctx.fillStyle=cg;ctx.fill();ctx.strokeStyle='rgba(170,130,255,.42)';ctx.lineWidth=1.3;ctx.stroke();
    ctx.save();ctx.clip();ctx.strokeStyle='rgba(190,160,255,.18)';ctx.lineWidth=1;
    for(let k=-4;k<=4;k++){ctx.beginPath();ctx.ellipse(cb.x,cb.y+k*11,cb.rx*.98,10,cb.rot,0,Math.PI);ctx.stroke();}
    ctx.restore();
    // Cerebrum body.
    const body=ctx.createRadialGradient(-60,-70,20,0,0,380);
    body.addColorStop(0,'rgba(38,92,170,.30)');body.addColorStop(.55,'rgba(60,40,150,.20)');body.addColorStop(1,'rgba(20,14,60,.10)');
    ctx.fillStyle=body;ctx.fill(outline);
    // Gyri: sinuous folds clipped to the cortex.
    ctx.save();ctx.clip(outline);ctx.lineWidth=1.1;
    for(let j=0;j<17;j++){const y0=-240+j*30;ctx.beginPath();
      for(let k=0;k<=56;k++){const x=-360+k*13;const y=y0+Math.sin(k*.55+j*1.7)*11+Math.sin(k*.21+j*.9)*16+Math.cos(k*1.3+j)*3;
        k?ctx.lineTo(x,y):ctx.moveTo(x,y);}
      ctx.strokeStyle=j%3===0?'rgba(170,120,255,.16)':'rgba(80,220,255,.10)';ctx.stroke();}
    for(let j=0;j<12;j++){const x0=-330+j*58;ctx.beginPath();
      for(let k=0;k<=30;k++){const y=-260+k*18;const x=x0+Math.sin(k*.6+j*2.1)*12+Math.sin(k*.23+j)*9;k?ctx.lineTo(x,y):ctx.moveTo(x,y);}
      ctx.strokeStyle='rgba(80,220,255,.06)';ctx.stroke();}
    // Inner rim light.
    const rim=ctx.createRadialGradient(0,0,150,0,0,350);rim.addColorStop(0,'rgba(0,0,0,0)');rim.addColorStop(1,'rgba(90,200,255,.16)');
    ctx.fillStyle=rim;ctx.fillRect(-400,-300,800,600);
    // Major sulci: lateral (Sylvian) and central.
    ctx.lineCap='round';ctx.strokeStyle='rgba(150,235,255,.34)';ctx.lineWidth=2.2;
    ctx.beginPath();ctx.moveTo(-205,72);ctx.bezierCurveTo(-120,40,-40,30,40,-2);ctx.bezierCurveTo(75,-16,100,-30,118,-58);ctx.stroke();
    ctx.beginPath();ctx.moveTo(-12,-222);ctx.bezierCurveTo(-2,-170,22,-150,14,-110);ctx.bezierCurveTo(8,-80,30,-60,34,-30);ctx.stroke();
    ctx.strokeStyle='rgba(190,150,255,.26)';ctx.lineWidth=1.6;
    ctx.beginPath();ctx.moveTo(168,-150);ctx.bezierCurveTo(190,-110,200,-80,228,-58);ctx.stroke();
    ctx.restore();
    // Neon outline with a slow breathing glow.
    ctx.shadowColor='#46e3ff';ctx.shadowBlur=14+10*breathe;ctx.lineWidth=2;
    ctx.strokeStyle=`rgba(96,228,255,${.45+.2*breathe})`;ctx.stroke(outline);
    ctx.shadowBlur=0;ctx.lineWidth=1;ctx.strokeStyle='rgba(200,170,255,.35)';ctx.stroke(outline);
    ctx.restore();
  }
  function draw(){const w=canvas.clientWidth,h=canvas.clientHeight;if(!w||!h)return;
    const now=performance.now(),neural=viewMode==='neural';
    ctx.clearRect(0,0,w,h);ctx.fillStyle='#02060c';ctx.fillRect(0,0,w,h);
    const vignette=ctx.createRadialGradient(w*.5,h*.45,0,w*.5,h*.45,Math.max(w,h)*.7);
    vignette.addColorStop(0,neural?'rgba(40,24,92,.55)':'rgba(10,40,64,.6)');vignette.addColorStop(.6,'rgba(5,16,30,.3)');vignette.addColorStop(1,'rgba(0,0,0,.6)');
    ctx.fillStyle=vignette;ctx.fillRect(0,0,w,h);
    // Fine dot grid anchors the eye while panning.
    ctx.fillStyle='rgba(110,170,230,.08)';const g=26,ox=((pan.x%g)+g)%g,oy=((pan.y%g)+g)%g;
    for(let x=ox;x<w;x+=g)for(let y=oy;y<h;y+=g)ctx.fillRect(x,y,1,1);
    ctx.save();ctx.translate(w/2+pan.x,h/2+pan.y);ctx.scale(zoom,zoom);
    if(neural)drawBrain(now);
    const map=new Map(rendered.nodes.map(n=>[n.id,n]));
    const activeId=selected?.id||hovered?.id;
    const lw=1/Math.sqrt(Math.max(.4,zoom));
    ctx.globalCompositeOperation='lighter';
    for(const e of rendered.edges){const a=map.get(e.source),b=map.get(e.target);if(!a||!b)continue;
      const connected=activeId&&(e.source===activeId||e.target===activeId);
      const active=selectedEdge?.id===e.id||hoveredEdge?.id===e.id||connected;
      const faded=activeId&&!active;
      ctx.beginPath();ctx.moveTo(a.x,a.y);
      // Gentle curvature reads as a mesh rather than a hairball.
      const mx=(a.x+b.x)/2,my=(a.y+b.y)/2,bend=(rand(e.id||e.source+e.target)-.5)*.35;
      ctx.quadraticCurveTo(mx-(b.y-a.y)*bend,my+(b.x-a.x)*bend,b.x,b.y);
      ctx.strokeStyle=active?'rgba(190,250,255,.95)':e.source_system==='cross'?`rgba(255,196,110,${faded?.10:.42})`:
        e.source_system==='tencent'?`rgba(170,130,255,${faded?.06:.26})`:`rgba(70,215,250,${faded?.06:.26})`;
      ctx.lineWidth=(active?1.8:e.source_system==='cross'?1.05:.75)*lw;ctx.stroke();
      if(neural&&(active||hash(e.id||`${e.source}:${e.target}`)%9===0)){
        const phase=(now*.00022+rand(e.id||e.source+e.target))%1,q=1-phase;
        const cx=mx-(b.y-a.y)*bend,cy=my+(b.x-a.x)*bend;
        const px=q*q*a.x+2*q*phase*cx+phase*phase*b.x,py=q*q*a.y+2*q*phase*cy+phase*phase*b.y;
        const pg=ctx.createRadialGradient(px,py,0,px,py,active?9:6);
        pg.addColorStop(0,active?'rgba(255,255,255,.95)':'rgba(120,255,240,.8)');pg.addColorStop(1,'rgba(60,240,230,0)');
        ctx.fillStyle=pg;ctx.beginPath();ctx.arc(px,py,active?9:6,0,TAU);ctx.fill();
      }
    }
    const linked=new Set();if(activeId)for(const e of rendered.edges){if(e.source===activeId)linked.add(e.target);if(e.target===activeId)linked.add(e.source)}
    // Halos (additive), then solid cores, then labels.
    for(const n of rendered.nodes){const highlight=n.id===activeId,near=linked.has(n.id);
      if(activeId&&!highlight&&!near&&n.degree<=8)continue;
      const tx=n.source_system==='tencent',mem=n.source_system==='memories',size=highlight?34:n.r*(n.degree>8?5:3.4);
      const halo=ctx.createRadialGradient(n.x,n.y,0,n.x,n.y,size);
      halo.addColorStop(0,highlight?'rgba(230,252,255,.55)':tx?'rgba(170,130,255,.30)':mem?'rgba(120,235,170,.32)':'rgba(60,220,255,.30)');halo.addColorStop(1,'rgba(0,0,0,0)');
      ctx.fillStyle=halo;ctx.beginPath();ctx.arc(n.x,n.y,size,0,TAU);ctx.fill();}
    ctx.globalCompositeOperation='source-over';
    const labels=[];
    for(const n of rendered.nodes){const highlight=n.id===activeId,near=linked.has(n.id),major=n.degree>8,tx=n.source_system==='tencent',mem=n.source_system==='memories';
      ctx.globalAlpha=activeId&&!highlight&&!near?.35:1;
      ctx.fillStyle=highlight?'#ffffff':major?(tx?'#e3d6ff':mem?'#d9f7e6':'#d5fbff'):(tx?'#b79bff':mem?'#8ef0b6':'#5fe3fb');
      ctx.beginPath();ctx.arc(n.x,n.y,n.r+(highlight?3:0),0,TAU);ctx.fill();
      if(highlight||major){ctx.lineWidth=1.2*lw;ctx.strokeStyle=tx?'rgba(190,160,255,.8)':mem?'rgba(150,240,190,.8)':'rgba(140,240,255,.8)';ctx.beginPath();ctx.arc(n.x,n.y,n.r+(highlight?7:3),0,TAU);ctx.stroke();}
      ctx.globalAlpha=1;
      // Operator 2026-10-27: names appear only for the hovered/selected node.
      if(highlight)labels.push([n,highlight,1e9]);
    }
    // Priority-ordered, collision-free labels; budget grows as the user zooms in.
    labels.sort((a,b)=>b[2]-a[2]);const placedLabels=[];let budget=Math.round(10*Math.max(1,zoom*zoom));
    const scale=1/Math.max(.5,Math.min(zoom,2.5));
    for(const [n,highlight,prio] of labels){if(prio<1e6&&budget--<=0)break;const text=String(n.display_label||n.label||'').slice(0,30);
      ctx.font=`${highlight?'600':'500'} ${((highlight?13:11)*scale).toFixed(1)}px system-ui, sans-serif`;const tw=ctx.measureText(text).width;
      const lx=n.x+n.r+6*scale,ly=n.y-6*scale,box={x:lx-4*scale,y:ly-11*scale,w:tw+8*scale,h:16*scale};
      if(!highlight&&placedLabels.some(o=>box.x<o.x+o.w&&o.x<box.x+box.w&&box.y<o.y+o.h&&o.y<box.y+box.h))continue;
      placedLabels.push(box);
      ctx.fillStyle='rgba(2,8,16,.78)';ctx.beginPath();ctx.roundRect?.(box.x,box.y,box.w,box.h,4*scale);ctx.fill();
      ctx.fillStyle=highlight?'#ffffff':'#bcd6e6';ctx.fillText(text,lx,ly+scale);}
    if(selectedEdge){const a=map.get(selectedEdge.source),b=map.get(selectedEdge.target);if(a&&b){ctx.fillStyle='#ffe2a8';ctx.shadowColor='#ffc35a';ctx.shadowBlur=14;ctx.beginPath();ctx.arc((a.x+b.x)/2,(a.y+b.y)/2,4.5,0,TAU);ctx.fill();ctx.shadowBlur=0;}}
    ctx.restore();
    const caption=`${rendered.nodes.length.toLocaleString()} nodes · ${rendered.edges.length.toLocaleString()} links · ${neural?'neural view':'network view'}`;
    ctx.font='600 11px system-ui, sans-serif';const cw=ctx.measureText(caption).width+26;
    ctx.fillStyle='rgba(3,8,17,.78)';ctx.strokeStyle='rgba(80,200,255,.25)';ctx.beginPath();ctx.roundRect?.(12,h-38,Math.min(cw,w-24),26,13);ctx.fill();ctx.stroke();
    ctx.fillStyle='#a9d8ea';ctx.fillText(caption,25,h-21);
  }
  function resize(){if(disposed)return;const d=Math.min(window.devicePixelRatio||1,2);
    canvas.width=Math.max(1,Math.round(canvas.clientWidth*d));canvas.height=Math.max(1,Math.round(canvas.clientHeight*d));ctx.setTransform(d,0,0,d,0,0);schedule()}
  function position(e){const rect=canvas.getBoundingClientRect();return {x:(e.clientX-rect.left-rect.width/2-pan.x)/zoom,y:(e.clientY-rect.top-rect.height/2-pan.y)/zoom}}
  function nearestNode(e){const p=position(e);let best=null,dist=12/zoom;for(const n of rendered.nodes){const d=Math.hypot(n.x-p.x,n.y-p.y);if(d<dist){dist=d;best=n}}return best}
  function nearestEdge(e){return closestGraphEdge(rendered.edges,rendered.nodes,position(e),Math.min(15,7/zoom))}
  function notify(){onSelect?.(selected,rendered.edges,selectedEdge)}
  const clampZoom=value=>Math.max(.12,Math.min(8,value));
  function zoomAt(next,clientX,clientY){
    const p=position({clientX,clientY});zoom=clampZoom(next);
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
        const [a,b]=[...pointers.values()],center=midOf(a,b);
        zoom=clampZoom(pinch.initialZoom*Math.hypot(a.x-b.x,a.y-b.y)/pinch.distance);
        const rect=canvas.getBoundingClientRect();
        pan.x=center.x-rect.left-rect.width/2-pinch.anchor.x*zoom;
        pan.y=center.y-rect.top-rect.height/2-pinch.anchor.y*zoom;
        schedule();return;
      }
      if(drag&&drag.id===e.pointerId){const dx=e.clientX-drag.x,dy=e.clientY-drag.y;
        if(Math.abs(dx)+Math.abs(dy)>2)drag.moved=true;
        pan.x+=dx;pan.y+=dy;drag.x=e.clientX;drag.y=e.clientY;schedule();return;
      }
    }
    const n=nearestNode(e),edge=n?null:nearestEdge(e);
    if(n?.id!==hovered?.id||edge?.id!==hoveredEdge?.id){
      hovered=n;hoveredEdge=edge;canvas.style.cursor=n||edge?'pointer':'grab';schedule();
    }
  }
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
      const [dx,dy]={ArrowLeft:[35,0],ArrowRight:[-35,0],ArrowUp:[0,35],ArrowDown:[0,-35]}[e.key];pan.x+=dx;pan.y+=dy;schedule();e.preventDefault();
    }
    if(e.key==='Escape'){selected=null;selectedEdge=null;notify();schedule()}}
  function visibility(){if(!document.hidden)schedule()}
  canvas.addEventListener('pointerdown',down);canvas.addEventListener('pointermove',move);canvas.addEventListener('pointerup',up);
  canvas.addEventListener('pointercancel',cancel);canvas.addEventListener('lostpointercapture',cancel);
  canvas.addEventListener('wheel',wheel,{passive:false});canvas.addEventListener('keydown',keys);
  document.addEventListener('visibilitychange',visibility);
  const watcher=new ResizeObserver(resize);watcher.observe(canvas);
  return {
    update(data){graph=data||{nodes:[],edges:[]};positions=viewMode==='neural'?layoutNeuralGraph(graph):layoutGraph(graph);recalc();},
    setMode(mode){const next=mode==='neural'?'neural':'network';if(viewMode===next)return;
      viewMode=next;positions=next==='neural'?layoutNeuralGraph(graph):layoutGraph(graph);recalc();this.fit();},
    getMode(){return viewMode},
    zoomBy(factor){const r=canvas.getBoundingClientRect();zoomAt(zoom*factor,r.left+r.width/2,r.top+r.height/2);},
    filter(filter){opts={...opts,...filter};recalc();},
    focus(id){selected=rendered.nodes.find(n=>n.id===id)||null;selectedEdge=null;
      if(selected){pan.x=-zoom*selected.x;pan.y=-zoom*selected.y;}notify();schedule()},
    focusEdge(id){selectedEdge=rendered.edges.find(e=>e.id===id)||null;selected=null;notify();schedule()},
    fit(){if(rendered.nodes.length){const xs=rendered.nodes.map(n=>n.x),ys=rendered.nodes.map(n=>n.y);
      if(viewMode==='neural'){xs.push(-BRAIN.a-20,BRAIN.a+20);ys.push(-BRAIN.b-10,300);}
      const spanX=Math.max(...xs)-Math.min(...xs)+130,spanY=Math.max(...ys)-Math.min(...ys)+130;
      zoom=Math.min(2.2,Math.max(.18,Math.min(canvas.clientWidth/spanX,canvas.clientHeight/spanY)));
      pan={x:-(Math.min(...xs)+Math.max(...xs))/2*zoom,y:-(Math.min(...ys)+Math.max(...ys))/2*zoom};schedule();}},
    reset(){this.fit()},getVisible(){return rendered},
    dispose(){disposed=true;pointers.clear();watcher.disconnect();cancelAnimationFrame(raf);
      document.removeEventListener('visibilitychange',visibility);
      for(const [ev,fn] of [['pointerdown',down],['pointermove',move],['pointerup',up],['pointercancel',cancel],['lostpointercapture',cancel],['wheel',wheel],['keydown',keys]])canvas.removeEventListener(ev,fn)}
  };
}
