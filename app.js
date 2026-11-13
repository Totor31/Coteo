/* Cotéo — scan et cote de cartes (version autonome) */
(function(){
"use strict";
const $ = s => document.querySelector(s);
const EUR = new Intl.NumberFormat('fr-FR',{style:'currency',currency:'EUR'});
const eur = v => v==null ? '—' : EUR.format(v);
const esc = s => String(s??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const norm = s => String(s||'').normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
const normNum = s => String(s||'').toLowerCase().replace(/\s+/g,'').replace(/^#/,'').replace(/^([a-z]*)0+(?=\d)/,'$1');
const numKey = n => { const m=String(n).match(/\d+/); return m?parseInt(m[0],10):99999; };
const VLAB = {N:'Normale',H:'Holo',R:'Reverse'};
const MODELS = {precise:{kind:'flash',fallback:'gemini-flash-latest',label:'Précis'}, fast:{kind:'flash-lite',fallback:'gemini-flash-lite-latest',label:'Économique'}};
const GAPI='https://generativelanguage.googleapis.com/v1beta';

/* ---------- local storage ---------- */
const K = {sales:'coteo.sales', hist:'coteo.hist', refAt:'coteo.refAt', ebay:'coteo.ebay', listed:'coteo.listed', cols:'coteo.cols', key:'coteo.geminikey', gm:'coteo.gmodels', model:'coteo.model', prices:'coteo.prices', target:'coteo.target'};
function lget(k,d){ try{ const v=localStorage.getItem(k); return v==null?d:JSON.parse(v); }catch(e){ return d; } }
function lset(k,v){ try{ localStorage.setItem(k,JSON.stringify(v)); return true; }catch(e){ return false; } }
try{ navigator.storage && navigator.storage.persist && navigator.storage.persist(); }catch(e){}

/* ---------- card database ---------- */
let RAW=null, SETS=[], CARDS=[], BYID=new Map(), BYSET=new Map();
let LIVE = lget(K.prices,{}); // id -> {t,a,th,ah,d}
function applyLive(c){ const p=LIVE[c.id]; if(p){ c.t=p.t??c.t; c.a=p.a??c.a; c.th=p.th??c.th; c.ah=p.ah??c.ah; c.pd=p.d; } }
async function loadDB(){
  const r = await fetch('data/db.json',{cache:'no-cache'}).catch(()=>fetch('data/db.json'));
  RAW = await r.json();
  SETS = RAW.sets.map((s,i)=>({i,id:s[0],name:s[1],off:s[2],tot:s[3],serie:s[4],date:s[5],sid:s[6]}));
  CARDS = RAW.cards.map(r=>{ const c={id:r[0],name:r[1],num:r[2],set:SETS[r[3]],rar:RAW.rar[r[4]]||'',vf:r[5]||0,t:r[6]??null,a:r[7]??null,th:r[8]??null,ah:r[9]??null}; c.nn=norm(c.name); c.nk=normNum(c.num); applyLive(c); return c; });
  BYID = new Map(CARDS.map(c=>[c.id,c]));
  BYSET = new Map(); CARDS.forEach(c=>{ if(!BYSET.has(c.set.i)) BYSET.set(c.set.i,[]); BYSET.get(c.set.i).push(c); });
  BYSET.forEach(a=>a.sort((x,y)=>numKey(x.num)-numKey(y.num)||String(x.num).localeCompare(String(y.num))));
}
function variants(c){ const v=[]; if(c.vf&1)v.push('N'); if(c.vf&4)v.push('H'); if(c.vf&2)v.push('R'); return v.length?v:['N']; }
function price(c,v){ if(!c) return null; if(v==='R') return c.th ?? c.ah ?? c.t ?? c.a; return c.t ?? c.a; }

/* live prices from TCGdex (Cardmarket) */
const inflightP = new Map();
function livePrice(id, force){
  const c=BYID.get(id); if(!c) return Promise.resolve(null);
  const p=LIVE[id]; if(!force && p && Date.now()-p.d < 12*3600e3) return Promise.resolve(c);
  if(inflightP.has(id)) return inflightP.get(id);
  const pr = fetch('https://api.tcgdex.net/v2/fr/cards/'+encodeURIComponent(id)).then(r=>r.ok?r.json():null).then(d=>{
    if(!d) return c;
    let cm=null; (d.variants_detailed||[]).some(v=>{ const x=v&&v.pricing&&v.pricing.cardmarket; if(x){ cm=x; return true; } return false; });
    if(!cm && d.pricing) cm=d.pricing.cardmarket;
    if(cm){ const r2=x=>x==null?null:Math.round(x*100)/100; LIVE[id]={t:r2(cm.trend),a:r2(cm.avg30),th:r2(cm['trend-holo']),ah:r2(cm['avg30-holo']),d:Date.now()}; applyLive(c); saveLive(); }
    return c;
  }).catch(()=>c).finally(()=>inflightP.delete(id));
  inflightP.set(id,pr); return pr;
}
let liveT; function saveLive(){ clearTimeout(liveT); liveT=setTimeout(()=>lset(K.prices,LIVE),400); }

/* ---------- collections ---------- */
let COLS = lget(K.cols,{});
function saveCols(){ if(!lset(K.cols,COLS)) toast('Mémoire du téléphone pleine : fais une sauvegarde.'); recordHist(); }
function colIds(){ return Object.keys(COLS).filter(k=>COLS[k]).sort((a,b)=>(COLS[a].created||0)-(COLS[b].created||0)); }
function ensureCol(cid){ if(!COLS[cid]) COLS[cid]={name:cid==='main'?'Ma collection':'Nouvelle collection',created:Date.now(),items:{}}; if(!COLS[cid].items) COLS[cid].items={}; return COLS[cid]; }
function addCard(cid,id,v,q){ const col=ensureCol(cid); const k=id+'|'+v; const it=col.items[k]; col.items[k]={id,v,q:(it?it.q:0)+(q||1),t:Date.now()}; saveCols(); renderAll(); }
function setQty(cid,k,q){ const col=COLS[cid]; if(!col||!col.items[k]) return; if(q<=0) delete col.items[k]; else col.items[k].q=q; saveCols(); renderAll(); }
function colStats(col){ let n=0,v=0; Object.values(col.items||{}).forEach(it=>{ const c=BYID.get(it.id); n+=it.q; v+=(price(c,it.v)||0)*it.q; }); return {n,v}; }
function ownedMap(){ const m=new Map(); colIds().forEach(id=>Object.values(COLS[id].items||{}).forEach(it=>m.set(it.id,(m.get(it.id)||0)+it.q))); return m; }

/* ---------- ui helpers ---------- */
let toastT; function toast(t){ const el=$('#toast'); el.textContent=t; el.classList.add('on'); clearTimeout(toastT); toastT=setTimeout(()=>el.classList.remove('on'),2600); }
function openSheet(html){ $('#sheet').innerHTML='<div class="grab"></div>'+html; $('#sheet').classList.add('on'); $('#scrim').classList.add('on'); $('#sheet').scrollTop=0; }
function closeSheet(){ $('#sheet').classList.remove('on'); $('#scrim').classList.remove('on'); }
$('#scrim').addEventListener('click',closeSheet);
function rarCls(r){ const n=norm(r);
  if(/promo/.test(n)) return 't-p';
  if(/illustration speciale|hyper|shiny|chromatique|magnifique|mega hyper|noir blanc|rgb|radieux|high tech/.test(n)) return 't-sr';
  if(/ultra|double|illustration|full art|vmax|vstar|legende|prime|lv x|holo rare v|mega attack|futuristic|pikachu|classique/.test(n)) return 't-ur';
  if(/rare/.test(n)) return 't-r';
  if(/peu commune/.test(n)) return 't-u';
  return 't-c'; }
function imgUrl(c,q){ return (c&&(c.vf&8)&&c.set.sid)?`https://assets.tcgdex.net/fr/${c.set.sid}/${c.set.id}/${encodeURIComponent(c.num)}/${q||'low'}.webp`:''; }
const tile = c => { const u=imgUrl(c); return `<div class="tile ${c?rarCls(c.rar):'t-c'}"><span>${c?esc(c.num):'?'}</span>${u?`<img loading="lazy" decoding="async" src="${u}" alt="" onerror="this.remove()">`:''}</div>`; };
function lev(a,b){ if(a===b) return 0; const m=a.length,n=b.length; if(!m) return n; if(!n) return m; let p=Array.from({length:n+1},(_,i)=>i); for(let i=1;i<=m;i++){ const q=[i]; for(let j=1;j<=n;j++) q[j]=Math.min(p[j]+1,q[j-1]+1,p[j-1]+(a[i-1]===b[j-1]?0:1)); p=q; } return p[n]; }
function sim(a,b){ if(!a||!b) return 0; if(a===b) return 1; if(a.includes(b)||b.includes(a)) return .85*Math.min(a.length,b.length)/Math.max(a.length,b.length)+.1; return Math.max(0,1-lev(a,b)/Math.max(a.length,b.length)); }

const S = { tab:'scan', col:null, sort:'value', exSet:null, q:'', target:lget(K.target,'main'), results:[], session:{n:0,v:0}, busy:0, camMode:'one', lastBatch:null };
function validTarget(){ const ids=colIds(); if(!ids.length) return 'main'; return ids.includes(S.target)?S.target:ids[0]; }
function colOptions(sel){ const ids=colIds(); return (ids.length?ids:['main']).map(id=>`<option value="${esc(id)}" ${id===sel?'selected':''}>${esc(COLS[id]?COLS[id].name:'Ma collection')}</option>`).join('')+`<option value="__new">+ Nouvelle collection…</option>`; }

/* ---------- render ---------- */
function renderAll(){ if(!RAW) return; renderHeader(); renderTarget(); renderKeyNote(); if(S.tab==='cols') renderCols(); if(S.tab==='explore') renderExplore(); if(S.tab==='sales') renderSales(); if(S.tab==='scan'){ renderResults(); renderSession(); } renderFoot(); renderCamSess(); }
function renderHeader(){ let v=0; colIds().forEach(id=>v+=colStats(COLS[id]).v); $('#totChip').innerHTML=`Collection <b>${eur(v)}</b>`; }
function renderTarget(){ S.target=validTarget(); $('#target').innerHTML=colOptions(S.target); }
function renderFoot(){ $('#foot').innerHTML=`Base de cartes et prix Cardmarket du ${new Date(RAW.date).toLocaleDateString('fr-FR',{day:'numeric',month:'long',year:'numeric'})}, actualisés en direct quand tu consultes une carte · données <a href="https://tcgdex.dev">TCGdex</a><br>Appli non officielle, non affiliée à Nintendo ni à The Pokémon Company.`; }
function renderSession(){ $('#sessBox').innerHTML = S.session.n ? `<div class="sess"><div><div class="sub">Cette session</div><div class="num">${S.session.n} carte${S.session.n>1?'s':''} ajoutée${S.session.n>1?'s':''}</div></div><b class="num">${eur(S.session.v)}</b></div>` : ''; }
function renderKeyNote(){ $('#keyNote').innerHTML = apiKey() ? '' : `<div class="note warn">Pour reconnaître les cartes, ajoute ta clé d'API Gemini (gratuite) dans les <a href="#" data-act="settings">réglages</a>. La recherche manuelle marche sans clé.</div>`; }

/* ---------- AI recognition ---------- */
function apiKey(){ return lget(K.key,''); }
function modelPref(){ const m=lget(K.model,'precise'); return MODELS[m]?m:'precise'; }
/* choisit automatiquement le modèle Gemini le plus récent disponible pour cette clé */
async function discoverModels(key, force){
  const cache=lget(K.gm,null);
  if(!force && cache && cache.key===key.slice(-6) && Date.now()-cache.at<7*864e5) return cache;
  const out={key:key.slice(-6),at:Date.now()};
  try{
    const r=await fetch(GAPI+'/models?pageSize=1000',{headers:{'x-goog-api-key':key}});
    if(!r.ok) return cache||out;
    const d=await r.json();
    const best={};
    (d.models||[]).forEach(m=>{
      if(!(m.supportedGenerationMethods||[]).includes('generateContent')) return;
      const id=String(m.name||'').replace(/^models\//,'');
      const x=id.match(/^gemini-(\d+(?:\.\d+)?)-(flash-lite|flash)$/); if(!x) return;
      const v=parseFloat(x[1]), k=x[2];
      if(!best[k]||v>best[k].v) best[k]={v,id};
    });
    if(best['flash']) out['flash']=best['flash'].id;
    if(best['flash-lite']) out['flash-lite']=best['flash-lite'].id;
    lset(K.gm,out);
  }catch(e){ return cache||out; }
  return out;
}
async function modelId(key){ const p=MODELS[modelPref()]; const gm=await discoverModels(key); return gm[p.kind]||p.fallback; }
async function gemini(key, parts, maxTok){
  const model=await modelId(key);
  const body={contents:[{role:'user',parts}],generationConfig:{temperature:0.1,maxOutputTokens:maxTok,responseMimeType:'application/json'}};
  let r;
  try{ r=await fetch(GAPI+'/models/'+encodeURIComponent(model)+':generateContent',{method:'POST',headers:{'content-type':'application/json','x-goog-api-key':key},body:JSON.stringify(body)}); }
  catch(e){ const er=new Error('net'); er.code='net'; throw er; }
  if(!r.ok){ let msg='',st=''; try{ const j=await r.json(); msg=j.error.message||''; st=j.error.status||''; }catch(e){}
    if(r.status===404) try{ localStorage.removeItem(K.gm); }catch(e){}
    const er=new Error(msg||('HTTP '+r.status)); er.code=r.status; er.status=st; throw er; }
  const d=await r.json();
  const c=(d.candidates||[])[0];
  if(!c){ const er=new Error((d.promptFeedback&&d.promptFeedback.blockReason)||'réponse vide'); er.code='empty'; throw er; }
  return ((c.content&&c.content.parts)||[]).filter(p=>p.text&&!p.thought).map(p=>p.text).join('\n');
}
function prompt(mode){
  return `You identify Pokémon Trading Card Game cards in a photo. ${mode==='page'?'The photo shows a binder page or several cards: list EVERY card you can see, in reading order (top-left to bottom-right).':mode==='one'?'The photo shows one card; if several are visible, return only the main, centered one.':'The photo may show one card or several: list every card you can see, in reading order.'}
For each card read carefully:
- name_printed: the name exactly as printed, with its suffix if any (ex, EX, V, VMAX, VSTAR, GX, Méga…).
- name_fr: the official French name of that card (French Pokémon or Trainer name + same suffix). Same as printed if the card is French.
- number: the collector number at the bottom of the card, e.g. "025" from "025/198", or "TG05", "SWSH123", "SVP045". Use "" if you cannot read it — never guess.
- total: the number after the slash, e.g. "198", or "" if none.
- set_hint: the set name or set code you can read or recognise, else "".
- language: printed language code (fr, en, de, it, es, ja…).
- finish: "reverse" if the card frame is foil but not the illustration, "holo" if the illustration is foil, otherwise "normal". Use "normal" when unsure.
- box: approximate bounding box [x0,y0,x1,y1] of the card, values from 0 to 1 relative to image width and height.
- confidence: 0 to 1, how sure you are of name and number.
Return ONLY JSON, no prose: {"cards":[{"name_printed":"","name_fr":"","number":"","total":"","set_hint":"","language":"","finish":"","box":[0,0,1,1],"confidence":0}]}. If no card is visible return {"cards":[]}.`;
}
function parseLoose(s){ s=String(s||''); const a=s.indexOf('{'), b=s.lastIndexOf('}'); if(a<0||b<a) return null; try{ return JSON.parse(s.slice(a,b+1)); }catch(e){ return null; } }
async function recognise(b64, mode){
  const key=apiKey(); if(!key){ const e=new Error('nokey'); e.code='nokey'; throw e; }
  const txt=await gemini(key,[{inline_data:{mime_type:'image/jpeg',data:b64}},{text:prompt(mode)}], mode==='one'?2048:8192);
  const j=parseLoose(txt); return (j&&Array.isArray(j.cards))?j.cards:(Array.isArray(j)?j:[]);
}
function errText(e){
  const c=e&&e.code, m=String(e&&e.message||'');
  if(c==='nokey') return 'Ajoute ta clé d’API dans les réglages.';
  if(c==='net') return 'Pas de connexion internet.';
  if((c===400&&/api key/i.test(m))||c===401||c===403) return 'Clé d’API refusée : vérifie-la dans les réglages.';
  if(c===429) return 'Limite gratuite atteinte : patiente une minute (ou jusqu’à demain si c’est la limite du jour).';
  if(c===503||c===500) return 'Gemini est surchargé, réessaie dans un instant.';
  if(c===404) return 'Modèle introuvable : réessaie, l’appli va en choisir un autre.';
  if(c==='empty') return 'Gemini n’a rien renvoyé pour cette photo. Réessaie.';
  return 'Analyse impossible ('+(m||'erreur')+').';
}
function matchCard(d){
  const nk=normNum(d.number||''); const tot=parseInt(d.total,10)||null;
  const names=[d.name_fr,d.name_printed].filter(Boolean).map(norm).filter(Boolean);
  const sh=norm(d.set_hint||'');
  const score=c=>{ let s=0; s+=3*Math.max(0,...names.map(n=>sim(n,c.nn))); if(tot&&(c.set.off===tot||c.set.tot===tot)) s+=2; if(nk&&c.nk===nk) s+=2.5; if(sh) s+=Math.max(sim(sh,norm(c.set.name)), sh===norm(c.set.id)?1:0); return s; };
  let pool = nk ? CARDS.filter(c=>c.nk===nk) : [];
  if(names.length){ pool=pool.concat(CARDS.filter(c=>names.some(n=>n.length>2&&(c.nn===n||c.nn.startsWith(n+' ')||n.startsWith(c.nn+' ')||(n.length>4&&c.nn.includes(n)))))); }
  const seen=new Set(), out=[];
  pool.forEach(c=>{ if(seen.has(c.id)) return; seen.add(c.id); out.push({c,s:score(c)}); });
  out.sort((a,b)=>b.s-a.s || (b.c.set.date||'').localeCompare(a.c.set.date||''));
  return out.slice(0,8);
}
function crop(cv,box){
  let [x0,y0,x1,y1]=Array.isArray(box)&&box.length===4?box.map(Number):[0,0,1,1];
  if(![x0,y0,x1,y1].every(isFinite)||x1<=x0||y1<=y0){x0=0;y0=0;x1=1;y1=1;}
  if(x1>1.5||y1>1.5){ x0/=cv.width;x1/=cv.width;y0/=cv.height;y1/=cv.height; }
  const pad=.02; x0=Math.max(0,x0-pad);y0=Math.max(0,y0-pad);x1=Math.min(1,x1+pad);y1=Math.min(1,y1+pad);
  const sw=(x1-x0)*cv.width, sh=(y1-y0)*cv.height; const w=140, h=Math.round(w*sh/sw)||196;
  const c2=document.createElement('canvas'); c2.width=w; c2.height=h; c2.getContext('2d').drawImage(cv,x0*cv.width,y0*cv.height,sw,sh,0,0,w,h);
  return c2.toDataURL('image/jpeg',.75);
}
function scaleCanvas(src,max){ const sc=Math.min(1,max/Math.max(src.width,src.height)); if(sc===1) return src; const c=document.createElement('canvas'); c.width=Math.round(src.width*sc); c.height=Math.round(src.height*sc); c.getContext('2d').drawImage(src,0,0,c.width,c.height); return c; }

async function analyse(cv, mode){
  S.busy++; S.lastErr=null; renderBusy();
  try{
    const small=scaleCanvas(cv, mode==='one'?1100:1700);
    const b64=small.toDataURL('image/jpeg',.86).split(',')[1];
    let list=await recognise(b64,mode);
    if(mode==='one') list=list.slice(0,1);
    if(!list.length){ toast('Aucune carte reconnue : rapproche-toi, évite les reflets.'); return []; }
    const batch=Date.now();
    const items=list.map((d,i)=>{
      const m=matchCard(d); const top=m[0];
      const amb=!top || (m[1]&&m[1].s>top.s-0.6) || (Number(d.confidence)||0)<0.55 || top.s<4;
      const card=top&&top.c; const vs=card?variants(card):['N'];
      const v = d.finish==='reverse'&&vs.includes('R')?'R':(d.finish==='holo'&&vs.includes('H')?'H':vs[0]);
      return {k:batch+'-'+i, batch, d, m, pick:card?card.id:null, v, thumb:crop(small, mode==='one'?null:d.box), state:'new', amb, open:false};
    });
    S.results=items.concat(S.results).slice(0,80); S.lastBatch=batch;
    items.forEach(r=>{ if(r.pick) livePrice(r.pick).then(()=>{ renderResults(); renderCamLast(); }); });
    renderResults(); renderCamLast();
    return items;
  }catch(e){ S.lastErr=e&&e.code; toast(errText(e)); if(e&&(e.code==='nokey'||e.code===401||e.code===403||(e.code===400&&/api key/i.test(e.message)))) setTimeout(openSettings,600); return []; }
  finally{ S.busy--; renderBusy(); }
}

async function onFile(file){
  const u=URL.createObjectURL(file); const im=new Image();
  im.onload=()=>{ const cv=document.createElement('canvas'); const sc=Math.min(1,2000/Math.max(im.naturalWidth,im.naturalHeight)); cv.width=Math.round(im.naturalWidth*sc); cv.height=Math.round(im.naturalHeight*sc); cv.getContext('2d').drawImage(im,0,0,cv.width,cv.height); URL.revokeObjectURL(u); analyse(cv,'auto'); };
  im.onerror=()=>{ URL.revokeObjectURL(u); toast('Image illisible.'); };
  im.src=u;
}

/* ---------- live camera ---------- */
let STREAM=null, TORCH=false;
async function openCam(){
  if(!apiKey()){ openSettings(); toast('Ajoute d’abord ta clé d’API.'); return; }
  if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia){ toast('Caméra non disponible dans ce navigateur.'); return; }
  try{
    STREAM=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'},width:{ideal:1920},height:{ideal:1080}},audio:false});
  }catch(e){ toast(e&&e.name==='NotAllowedError'?'Autorise l’accès à la caméra dans Chrome pour scanner.':'Impossible d’ouvrir la caméra.'); return; }
  const v=$('#vid'); v.srcObject=STREAM; try{ await v.play(); }catch(e){}
  $('#cam').hidden=false; document.body.style.overflow='hidden';
  const tr=STREAM.getVideoTracks()[0]; let caps={}; try{ caps=tr.getCapabilities?tr.getCapabilities():{}; }catch(e){}
  $('#torchBtn').hidden=!caps.torch; TORCH=false; $('#torchBtn').classList.remove('on');
  try{ if(caps.focusMode&&caps.focusMode.includes('continuous')) await tr.applyConstraints({advanced:[{focusMode:'continuous'}]}); }catch(e){}
  setCamMode(S.camMode); renderCamLast(); renderCamSess();
  clearInterval(RAF.timer); RAF.timer=setInterval(rafTick,250);
  try{ if(navigator.wakeLock) WAKE=await navigator.wakeLock.request('screen'); }catch(e){ WAKE=null; }
}
function closeCam(){ clearInterval(RAF.timer); RAF.timer=null; try{ WAKE&&WAKE.release(); }catch(e){} WAKE=null; if(STREAM){ STREAM.getTracks().forEach(t=>t.stop()); STREAM=null; } $('#vid').srcObject=null; $('#cam').hidden=true; document.body.style.overflow=''; renderAll(); }
const CAMHINT={one:'Cadre la carte entière, numéro du bas lisible',page:'Cadre toute la page du classeur, bien à plat',raf:'Pose une carte dans le cadre : elle est scannée et ajoutée toute seule'};
function setCamMode(m){ S.camMode=m; document.querySelectorAll('#camMode button').forEach(b=>b.classList.toggle('on',b.dataset.m===m)); $('#guide').classList.toggle('page',m==='page'); $('#guide').classList.toggle('raf',m==='raf'); $('#camHint').textContent=CAMHINT[m]; RAF.sigs=[]; RAF.prev=null; RAF.stable=0; RAF.next=Date.now()+800; }
function guideRect(margin){
  const v=$('#vid'); const vw=v.videoWidth, vh=v.videoHeight; if(!vw) return null;
  const W=v.clientWidth, H=v.clientHeight; const sc=Math.max(W/vw,H/vh); const ox=(vw*sc-W)/2, oy=(vh*sc-H)/2;
  const g=$('#guide').getBoundingClientRect(), vr=v.getBoundingClientRect(); const m=margin;
  let gx=g.left-vr.left-g.width*m, gy=g.top-vr.top-g.height*m, gw=g.width*(1+2*m), gh=g.height*(1+2*m);
  let sx=(gx+ox)/sc, sy=(gy+oy)/sc, sw=gw/sc, sh=gh/sc;
  sx=Math.max(0,sx); sy=Math.max(0,sy); sw=Math.min(vw-sx,sw); sh=Math.min(vh-sy,sh);
  return {v,sx,sy,sw,sh};
}
function grab(){
  const r=guideRect(S.camMode==='page'?0.04:0.10); if(!r) return null;
  const cv=document.createElement('canvas'); cv.width=Math.round(r.sw); cv.height=Math.round(r.sh);
  cv.getContext('2d').drawImage(r.v,r.sx,r.sy,r.sw,r.sh,0,0,cv.width,cv.height); return cv;
}
async function shoot(auto){
  const cv=grab(); if(!cv){ if(!auto) toast('Caméra pas prête.'); return; }
  const g=$('#guide'); g.classList.remove('flash'); void g.offsetWidth; g.classList.add('flash');
  try{ navigator.vibrate && navigator.vibrate(30); }catch(e){}
  const raf=S.camMode==='raf';
  const items=await analyse(cv, S.camMode==='page'?'page':'one');
  if(!raf) return;
  if(S.lastErr===429) RAF.next=Date.now()+30000;
  const r=items[0]; if(!r) return;
  const dup = r.pick && RAF.lastId===r.pick+'|'+r.v;
  if(r.pick && !r.amb && !dup){
    RAF.lastId=r.pick+'|'+r.v; addResult(r); renderResults(); renderSession(); renderCamLast(); renderCamSess();
    try{ navigator.vibrate && navigator.vibrate([40,60,40]); }catch(e){}
  } else {
    if(dup) r.dup=true; renderCamLast();
    try{ navigator.vibrate && navigator.vibrate(250); }catch(e){}
  }
}
/* rafale : déclenche tout seul quand une nouvelle carte est posée et immobile */
const RAF={timer:null,prev:null,stable:0,sigs:[],next:0,lastId:null,cv:null};
let WAKE=null;
function sigNow(){
  const r=guideRect(0); if(!r) return null;
  const cv=RAF.cv||(RAF.cv=document.createElement('canvas')); cv.width=24; cv.height=32;
  const ctx=cv.getContext('2d',{willReadFrequently:true}); ctx.drawImage(r.v,r.sx,r.sy,r.sw,r.sh,0,0,24,32);
  const d=ctx.getImageData(0,0,24,32).data; const out=new Float32Array(768); let mean=0;
  for(let i=0;i<768;i++){ const l=0.3*d[i*4]+0.59*d[i*4+1]+0.11*d[i*4+2]; out[i]=l; mean+=l; }
  mean/=768; for(let i=0;i<768;i++) out[i]-=mean; return out;
}
function sdiff(a,b){ let t=0; for(let i=0;i<768;i++) t+=Math.abs(a[i]-b[i]); return t/768; }
function rafTick(){
  if(S.camMode!=='raf'||$('#cam').hidden) return;
  const s=sigNow(); if(!s) return;
  const mv=RAF.prev?sdiff(s,RAF.prev):99; RAF.prev=s; RAF.stable = mv<5 ? RAF.stable+1 : 0;
  const hint=$('#camHint'); const now=Date.now();
  if(S.busy){ hint.textContent='Analyse…'; return; }
  if(S.lastErr===429 && now<RAF.next){ hint.textContent='Limite gratuite atteinte : pause de quelques secondes…'; return; }
  if(RAF.stable<3){ hint.textContent=CAMHINT.raf; return; }
  if(RAF.sigs.some(x=>sdiff(x,s)<14)){ hint.textContent='Carte déjà scannée : pose la suivante'; return; }
  if(now<RAF.next) return;
  RAF.sigs.push(s); if(RAF.sigs.length>6) RAF.sigs.shift(); RAF.next=now+4000; shoot(true);
}
function renderBusy(){ const b=$('#camBusy'); if(b) b.style.visibility=S.busy?'visible':'hidden'; const st=$('#scanStatus'); if(st) st.innerHTML=S.busy&&$('#cam').hidden?`<div class="card row"><div class="spin"></div><div>Analyse de la photo…</div></div>`:''; }
function renderCamSess(){ const el=$('#camSess'); if(el) el.textContent='Session · '+eur(S.session.v); }
function renderCamLast(){
  const el=$('#camLast'); if(!el||$('#cam').hidden) return;
  const items=S.results.filter(r=>r.batch===S.lastBatch); if(!items.length){ el.innerHTML=''; return; }
  if(items.length===1){
    const r=items[0]; const c=r.pick?BYID.get(r.pick):null;
    el.innerHTML = `<div class="lastcard"><img src="${r.thumb}" alt=""><div class="grow"><div class="t1 ell" style="font-weight:700">${c?esc(c.name):esc(r.d.name_fr||r.d.name_printed||'Carte inconnue')}</div><div class="sub ell">${c?`${esc(c.set.name)} · ${esc(c.num)}/${esc(c.set.off||'?')}`:'Pas trouvée dans la base'}</div>${r.dup&&c?'<span class="badge warn">Doublon ?</span>':(r.amb&&c?'<span class="badge warn">À vérifier</span>':'')}</div>${c?`<div class="price num" style="font-size:17px">${eur(price(c,r.v))}<small>${VLAB[r.v]}</small></div>`:''}${r.state==='new'&&c?`<button class="btn pri sm" data-act="resAdd" data-k="${r.k}">Ajouter</button>`:r.state==='added'?'<span class="badge ok">Ajoutée</span>':`<button class="btn sm" data-act="camToList">Voir</button>`}</div>`;
  } else {
    const ok=items.filter(r=>r.pick); const tot=ok.reduce((s,r)=>s+(price(BYID.get(r.pick),r.v)||0),0); const pend=ok.filter(r=>r.state==='new');
    el.innerHTML = `<div class="lastcard"><div class="grow"><div class="t1" style="font-weight:700">${items.length} cartes détectées</div><div class="sub num">${ok.length} reconnues · ${eur(tot)}</div></div><button class="btn sm" data-act="camToList">Détails</button>${pend.length?`<button class="btn pri sm" data-act="addBatch">Tout ajouter</button>`:'<span class="badge ok">Ajoutées</span>'}</div>`;
  }
}

/* ---------- scan results list ---------- */
function renderResults(){
  const box=$('#scanRes'); if(!box) return;
  if(!S.results.length){ box.innerHTML=`<div class="empty"><div style="font-size:15px;color:var(--tx);font-weight:600;margin-bottom:4px">Aucun scan pour l'instant</div>Bien à plat, sans reflet : le numéro en bas de la carte doit être lisible.</div>`; return; }
  const pending=S.results.filter(r=>r.state==='new'&&r.pick);
  let html = pending.length>1 ? `<div class="row"><button class="btn pri grow" data-act="addAll">Tout ajouter (${pending.length}) · ${eur(pending.reduce((s,r)=>s+(price(BYID.get(r.pick),r.v)||0),0))}</button><button class="btn" data-act="clearRes">Effacer</button></div>` : `<div style="text-align:right"><button class="btn sm ghost" data-act="clearRes">Effacer les résultats</button></div>`;
  html += S.results.map(r=>{
    const c=r.pick?BYID.get(r.pick):null; const vs=c?variants(c):[];
    const status = r.state==='added'?'<span class="badge ok">Ajoutée</span>':r.state==='skip'?'<span class="badge">Ignorée</span>':(r.amb&&c?'<span class="badge warn">À vérifier</span>':'');
    const head = c ? `<div class="nm ell">${esc(c.name)}</div><div class="sub ell">${esc(c.set.name)} · ${esc(c.num)}/${esc(c.set.off||'?')}</div><div class="row" style="margin-top:4px;gap:6px"><span class="badge">${esc(c.rar||'—')}</span>${status}</div>`
      : `<div class="nm ell">${esc(r.d.name_fr||r.d.name_printed||'Carte inconnue')}</div><div class="sub">Pas trouvée dans la base${r.d.number?` (n° ${esc(r.d.number)}${r.d.total?'/'+esc(r.d.total):''})`:''}</div>`;
    let body = `<div class="row" style="align-items:flex-start"><img class="ph" src="${r.thumb}" alt=""><div class="grow">${head}</div>${c?`<div class="price num" style="font-size:18px">${eur(price(c,r.v))}<small>${VLAB[r.v]}</small></div>`:''}</div>`;
    if(r.state==='new'){
      if(c){
        if(vs.length>1) body+=`<div class="seg" style="margin-top:10px">${vs.map(v=>`<button data-act="resV" data-k="${r.k}" data-v="${v}" class="${v===r.v?'on':''}">${VLAB[v]}</button>`).join('')}</div>`;
        body+=`<div class="row" style="margin-top:10px"><button class="btn pri grow" data-act="resAdd" data-k="${r.k}">Ajouter</button><button class="btn" data-act="resAlt" data-k="${r.k}">${r.open?'Masquer':'Pas la bonne ?'}</button><button class="btn ghost" data-act="resSkip" data-k="${r.k}" aria-label="Ignorer">✕</button></div>`;
      } else body+=`<div class="row" style="margin-top:10px"><button class="btn pri grow" data-act="resSearch" data-k="${r.k}">Chercher à la main</button><button class="btn ghost" data-act="resSkip" data-k="${r.k}">Ignorer</button></div>`;
      if(r.open&&r.m.length) body+=`<div class="alts">${r.m.filter(x=>x.c.id!==r.pick).slice(0,6).map(x=>`<button class="alt" data-act="resPick" data-k="${r.k}" data-id="${esc(x.c.id)}">${tile(x.c)}<div class="grow"><div class="ell">${esc(x.c.name)}</div><div class="t2 ell">${esc(x.c.set.name)} · ${esc(x.c.num)}/${esc(x.c.set.off||'?')}</div></div><div class="price num">${eur(price(x.c,'N'))}</div></button>`).join('')}<button class="alt" data-act="resSearch" data-k="${r.k}" style="color:var(--ac);font-weight:600">Chercher une autre carte…</button></div>`;
    }
    return `<div class="res ${r.state!=='new'?'done':''}">${body}</div>`;
  }).join('');
  box.innerHTML=html;
}
const findRes=k=>S.results.find(r=>r.k===k);
function addResult(r){ const c=BYID.get(r.pick); if(!c||r.state!=='new') return; addCard(validTarget(),c.id,r.v,1); r.state='added'; S.session.n++; S.session.v+=price(c,r.v)||0; }

/* ---------- collections ---------- */
function renderCols(){
  const el=$('#v-cols'); if(S.col&&!COLS[S.col]) S.col=null;
  if(!S.col){
    const ids=colIds(); let tv=0,tn=0; ids.forEach(id=>{ const s=colStats(COLS[id]); tv+=s.v; tn+=s.n; });
    el.innerHTML=`<h2>Collections</h2><div class="hero"><div class="sub">Valeur totale</div><div class="v num">${eur(tv)}</div><div class="sub num">${tn} carte${tn>1?'s':''} · ${ids.length} collection${ids.length>1?'s':''}</div></div>
    ${histBlock()}${moversBlock()}
    <div class="stack" style="margin-top:12px">${ids.length?ids.map(id=>{ const c=COLS[id], s=colStats(c); return `<button class="colcard" data-act="openCol" data-id="${esc(id)}"><div class="ic"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#9aa1ba" stroke-width="2"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/></svg></div><div class="grow"><div class="ell" style="font-weight:700">${esc(c.name)}</div><div class="sub num">${s.n} carte${s.n>1?'s':''}</div></div><div class="val num">${eur(s.v)}</div></button>`; }).join(''):`<div class="empty">Aucune carte pour l'instant.<br>Scanne ta première carte pour démarrer.</div>`}
    <button class="btn" style="width:100%" data-act="newCol">+ Nouvelle collection</button>
    <div class="row"><button class="btn grow" data-act="backup">Sauvegarder</button><label class="btn grow" style="position:relative;overflow:hidden">Restaurer<input type="file" accept="application/json,.json" id="restoreIn" style="position:absolute;inset:0;opacity:0"></label></div>
    <div class="note">Tes collections sont gardées sur ce téléphone, dans Chrome. Fais une sauvegarde de temps en temps (fichier à garder ou à envoyer sur un autre téléphone).</div></div>`;
    bindHist();
    return;
  }
  const col=COLS[S.col], s=colStats(col), so=S.sort;
  const items=Object.entries(col.items||{}).map(([k,it])=>({k,it,c:BYID.get(it.id)})).filter(x=>x.c);
  items.sort((a,b)=> so==='name'?a.c.name.localeCompare(b.c.name,'fr'): so==='set'?((b.c.set.date||'').localeCompare(a.c.set.date||'')||numKey(a.c.num)-numKey(b.c.num)): so==='recent'?(b.it.t||0)-(a.it.t||0): (price(b.c,b.it.v)||0)*b.it.q-(price(a.c,a.it.v)||0)*a.it.q);
  el.innerHTML=`<button class="back" data-act="colBack">‹ Collections</button>
  <div class="hero"><div class="row"><div class="grow"><div class="ell" style="font-size:20px;font-weight:800">${esc(col.name)}</div><div class="sub num">${s.n} carte${s.n>1?'s':''}</div></div><button class="btn sm" data-act="colMenu">Options</button></div><div class="v num" style="margin-top:6px">${eur(s.v)}</div><button class="btn sm" style="margin-top:8px" data-act="refreshCol">Actualiser les prix</button></div>
  <div class="row" style="margin:12px 0"><label class="sub" for="sortSel" style="flex:none">Trier par</label><select id="sortSel">${[['value','Valeur'],['recent','Ajout récent'],['name','Nom'],['set','Série']].map(([v,l])=>`<option value="${v}" ${so===v?'selected':''}>${l}</option>`).join('')}</select></div>
  ${items.length?`<div class="list">${items.map(x=>`<div class="li"><button data-act="card" data-id="${esc(x.c.id)}" data-v="${x.it.v}" class="row grow" style="text-align:left">${tile(x.c)}<div class="grow"><div class="t1 ell">${esc(x.c.name)}</div><div class="t2 ell">${esc(x.c.set.name)} · ${esc(x.c.num)} · ${VLAB[x.it.v]}</div><div class="t2 num">${eur(price(x.c,x.it.v))} pièce</div></div></button><div style="text-align:right"><div class="price num" style="margin-bottom:4px">${eur((price(x.c,x.it.v)||0)*x.it.q)}</div><div class="step"><button data-act="qty" data-k="${esc(x.k)}" data-d="-1">−</button><span class="num">${x.it.q}</span><button data-act="qty" data-k="${esc(x.k)}" data-d="1">+</button></div></div></div>`).join('')}</div>`:`<div class="empty">Collection vide.</div>`}`;
}
async function refreshCol(){
  const ids=[...new Set(Object.values(COLS[S.col].items||{}).map(it=>it.id))]; if(!ids.length) return;
  toast('Actualisation de '+ids.length+' prix…'); let i=0;
  const worker=async()=>{ while(i<ids.length){ const id=ids[i++]; await livePrice(id,true); } };
  await Promise.all([worker(),worker(),worker(),worker()]); lset(K.prices,LIVE); recordHist(); renderAll(); toast('Prix à jour');
}

/* ---------- explore ---------- */
function fmtMonth(d){ if(!d) return ''; const [y,m]=d.split('-'); try{ return new Date(+y,(+m||1)-1,1).toLocaleDateString('fr-FR',{month:'short',year:'numeric'}); }catch(e){ return d; } }
function cardRow(c,own){ const o=own.get(c.id); return `<button class="li" data-act="card" data-id="${esc(c.id)}">${tile(c)}<div class="grow"><div class="t1 ell">${esc(c.name)}${o?`<span class="own">×${o}</span>`:''}</div><div class="t2 ell">${esc(c.set.name)} · ${esc(c.num)}/${esc(c.set.off||'?')}</div><div class="t2 ell">${esc(c.rar||'')}</div></div><div class="price num">${eur(price(c,'N'))}${c.th!=null&&(c.vf&2)?`<small>Rev. ${eur(c.th)}</small>`:''}</div></button>`; }
function renderExplore(){
  const el=$('#exBody'), own=ownedMap(), q=S.q.trim();
  if(q){
    const m=q.match(/^\s*([a-z]{0,6}\s?\d+)\s*(?:\/\s*(\d+))?\s*$/i); let res;
    if(m){ const nk=normNum(m[1]), tot=m[2]?parseInt(m[2],10):null; res=CARDS.filter(c=>c.nk===nk&&(!tot||c.set.off===tot||c.set.tot===tot)); }
    else { const nq=norm(q); res=CARDS.filter(c=>c.nn.includes(nq)); res.sort((a,b)=>(b.nn.startsWith(nq)-a.nn.startsWith(nq))||(b.set.date||'').localeCompare(a.set.date||'')); }
    const n=res.length; res=res.slice(0,80);
    el.innerHTML = n?`<div class="sub" style="margin-bottom:8px">${n} résultat${n>1?'s':''}${n>80?' (80 premiers)':''}</div><div class="list">${res.map(c=>cardRow(c,own)).join('')}</div>`:`<div class="empty">Aucune carte trouvée.<br>Essaie le nom français, ou le numéro « 025/198 ».</div>`;
    return;
  }
  if(S.exSet!=null){
    const set=SETS[S.exSet], cards=BYSET.get(set.i)||[], have=cards.filter(c=>own.has(c.id)).length;
    el.innerHTML=`<button class="back" data-act="exBack">‹ Toutes les séries</button><div class="hero"><div class="sub">${esc(set.serie)} · ${esc(fmtMonth(set.date))}</div><div style="font-size:22px;font-weight:800">${esc(set.name)}</div><div class="sub num" style="margin-top:4px">${have}/${cards.length} possédées</div><div class="bar"><i style="width:${cards.length?Math.round(100*have/cards.length):0}%"></i></div></div><div class="list" style="margin-top:12px">${cards.map(c=>cardRow(c,own)).join('')}</div>`;
    return;
  }
  const groups=[], idx={};
  SETS.slice().reverse().forEach(s=>{ if(!(BYSET.get(s.i)||[]).length) return; if(idx[s.serie]==null){ idx[s.serie]=groups.length; groups.push({name:s.serie,sets:[]}); } groups[idx[s.serie]].sets.push(s); });
  el.innerHTML=groups.map(g=>`<div class="serie">${esc(g.name)}</div><div class="list">${g.sets.map(s=>{ const cs=BYSET.get(s.i), h=cs.filter(c=>own.has(c.id)).length; return `<button class="li" data-act="openSet" data-i="${s.i}"><div class="grow"><div class="t1 ell">${esc(s.name)}</div><div class="t2 num">${esc(fmtMonth(s.date))} · ${cs.length} cartes${h?` · <span style="color:var(--ok)">${h} possédée${h>1?'s':''}</span>`:''}</div>${h?`<div class="bar"><i style="width:${Math.round(100*h/cs.length)}%"></i></div>`:''}</div><span style="color:var(--mu2)">›</span></button>`; }).join('')}</div>`).join('');
}

/* ---------- card sheet ---------- */
let SH={};
function openCard(id,v){ const c=BYID.get(id); if(!c) return; const vs=variants(c); SH={id,v:vs.includes(v)?v:vs[0],q:1,col:validTarget()}; renderCardSheet(); livePrice(id).then(()=>{ if($('#sheet').classList.contains('on')&&SH.id===id) renderCardSheet(true); }); }
function renderCardSheet(keep){
  const c=BYID.get(SH.id), vs=variants(c), own=ownedMap().get(c.id)||0;
  const big=imgUrl(c,'high');
  const html=`${big?`<img class="bigimg" src="${big}" alt="${esc(c.name)}" onerror="this.remove()">`:''}<div class="row" style="align-items:flex-start">${big?'':tile(c)}<div class="grow"><div style="font-size:20px;font-weight:800">${esc(c.name)}</div><div class="sub">${esc(c.set.name)} · ${esc(c.num)}/${esc(c.set.off||'?')}</div><div class="sub">${esc(c.set.serie)} · ${esc(c.rar||'—')}${own?` · <span style="color:var(--ok)">${own} possédée${own>1?'s':''}</span>`:''}</div></div></div>
  <div class="ptab num" style="margin-top:14px"><div><small>Tendance</small><b>${eur(c.t)}</b></div><div><small>Moy. 30 jours</small><b>${eur(c.a)}</b></div><div><small>Reverse</small><b>${(c.vf&2)?eur(c.th??c.ah):'—'}</b></div></div>
  <div class="sub" style="margin-top:6px;font-size:12px">${c.pd?'Prix Cardmarket actualisés à '+new Date(c.pd).toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'}):'Prix Cardmarket du '+new Date(RAW.date).toLocaleDateString('fr-FR')}</div>
  <div class="stack" style="margin-top:12px">
    ${vs.length>1?`<div class="seg">${vs.map(v=>`<button data-act="shV" data-v="${v}" class="${v===SH.v?'on':''}">${VLAB[v]}</button>`).join('')}</div>`:''}
    <div class="row"><div class="grow"><label class="fld" for="shCol">Collection</label><select id="shCol">${colOptions(SH.col)}</select></div><div><label class="fld">Quantité</label><div class="step"><button data-act="shQ" data-d="-1">−</button><span class="num">${SH.q}</span><button data-act="shQ" data-d="1">+</button></div></div></div>
    <button class="btn pri" style="width:100%" data-act="shAdd">Ajouter · ${eur((price(c,SH.v)||0)*SH.q)}</button>
    <button class="btn" style="width:100%" data-act="ebay">Créer l'annonce eBay${LISTED[c.id+'|'+SH.v]?` <span class="badge ok">en vente à ${eur(LISTED[c.id+'|'+SH.v].p)}</span>`:''}</button>
    <a class="btn ghost" style="width:100%;text-decoration:none;color:var(--tx)" target="_blank" rel="noopener" href="https://www.cardmarket.com/fr/Pokemon/Products/Search?searchString=${encodeURIComponent(c.name)}">Voir sur Cardmarket</a>
  </div>`;
  if(keep){ const top=$('#sheet').scrollTop; $('#sheet').innerHTML='<div class="grab"></div>'+html; $('#sheet').scrollTop=top; } else openSheet(html);
}


/* ---------- annonce eBay ---------- */
const EBDEF={marge:10,min:1,ship:'Envoi soigné : carte protégée par sleeve et toploader, sous enveloppe rigide avec suivi.',cond:'nm',lang:'fr'};
function ebCfg(){ return Object.assign({},EBDEF,lget(K.ebay,{})); }
let LISTED=lget(K.listed,{});
const COND={nm:'Proche du neuf ou mieux',ex:'Légèrement jouée (Excellent)',vg:'Moyennement jouée (Très bon)',po:'Très jouée (Médiocre)'};
const LANG={fr:['Français','FR'],en:['Anglais','EN'],ja:['Japonais','JAP'],de:['Allemand','DE'],it:['Italien','IT'],es:['Espagnol','ES']};
const FIN={N:'Normale',H:'Holo',R:'Reverse Holo'};
function ebRound(p){ if(p<=0) return 0; const r = p<20 ? Math.ceil(p*2)/2-0.01 : Math.ceil(p)-0.01; return Math.round(r*100)/100; }
function ebSuggest(c,v){ const cfg=ebCfg(); const base=price(c,v); if(base==null) return Math.max(cfg.min,0.99); return Math.max(ebRound(base*(1+cfg.marge/100)), cfg.min); }
function ebTitle(c,v,lang){
  const rar = /^(commune|peu commune|sans rarete)$/.test(norm(c.rar)) ? '' : c.rar;
  let p=[['Carte Pokémon',3],[c.name,0],[c.num+'/'+(c.set.off||'?'),0],[v==='R'?'Reverse':(v==='H'?'Holo':''),1],[rar,4],[c.set.name,2],[(LANG[lang]||LANG.fr)[1],0]].filter(x=>x[0]);
  let t=p.map(x=>x[0]).join(' ');
  for(const lvl of [4,3,2,1]){ if(t.length<=80) break; p=p.filter(x=>x[1]!==lvl); t=p.map(x=>x[0]).join(' '); }
  return t.slice(0,80);
}
function ebDesc(c,v,e){ const cfg=ebCfg(); return [
  `Carte Pokémon à l'unité : ${c.name}`,'',
  `Série : ${c.set.name} (${c.set.serie}${c.set.date?', '+c.set.date.slice(0,4):''})`,
  `Numéro : ${c.num}/${c.set.off||'?'}`,
  c.rar?`Rareté : ${c.rar}`:null,
  `Version : ${FIN[v]||'Normale'}`,
  `Langue : ${(LANG[e.lang]||LANG.fr)[0]}`,
  `État : ${COND[e.cond]}`,'',
  'La carte envoyée est celle des photos.',
  cfg.ship||null].filter(x=>x!==null).join('\n').replace(/\n{3,}/g,'\n\n').trim(); }
function ebSpecs(c,v,e){ return [
  ['Jeu','Pokémon JCC'],['Personnage',c.name.replace(/[-\s](ex|EX|GX|V|VMAX|VSTAR|LV\.X|BREAK)$/,'')],['Nom de la carte',c.name],['Série',c.set.name],['Numéro de la carte',c.num+'/'+(c.set.off||'?')],
  ['Rareté',c.rar||'—'],['Finition',v==='R'?'Reverse Holo':(v==='H'?'Holo':'Normale')],['Langue',(LANG[e.lang]||LANG.fr)[0]],['Fabricant','The Pokémon Company'],
  ['Graduée','Non'],['État de la carte',COND[e.cond]],['Année de fabrication',c.set.date?c.set.date.slice(0,4):'—']]; }
let EB={};
function openEbay(){
  const c=BYID.get(SH.id); const cfg=ebCfg(); const prev=LISTED[c.id+'|'+SH.v];
  EB={id:c.id,v:SH.v,cond:prev&&prev.cond||cfg.cond,lang:prev&&prev.lang||cfg.lang,p:prev?prev.p:ebSuggest(c,SH.v)};
  renderEbay(); livePrice(c.id).then(()=>{ if(!prev&&!EB.touched){ EB.p=ebSuggest(c,EB.v); } if($('#ebSheet')) renderEbay(true); });
}
function renderEbay(keep){
  const c=BYID.get(EB.id), cfg=ebCfg(), e=EB;
  const t=ebTitle(c,e.v,e.lang), d=ebDesc(c,e.v,e), sp=ebSpecs(c,e.v,e);
  const sold='https://www.ebay.fr/sch/i.html?_nkw='+encodeURIComponent('pokemon '+c.name+' '+c.num+'/'+(c.set.off||''))+'&LH_Sold=1&LH_Complete=1&_sop=13';
  const base=price(c,e.v);
  const html=`<div id="ebSheet"><div style="font-size:20px;font-weight:800">Annonce eBay</div><div class="sub" style="margin-bottom:12px">${esc(c.name)} · ${esc(c.set.name)} · ${esc(c.num)}/${esc(c.set.off||'?')} · ${FIN[e.v]}</div>
  <div class="hero"><div class="row" style="align-items:flex-end"><div class="grow"><div class="sub">Prix de vente</div><div class="row" style="gap:6px"><input id="ebPrice" type="text" inputmode="decimal" value="${String(e.p.toFixed(2)).replace('.',',')}" style="width:130px;font-size:24px;font-weight:800;color:var(--ac);padding:6px 10px"><b style="font-size:22px">€</b></div></div><button class="btn sm" data-act="ebReset">Prix conseillé</button></div>
  <div class="sub num" style="margin-top:8px;font-size:13px">Cote Cardmarket ${eur(base)}${c.a!=null&&e.v!=='R'?` · moy. 30 j ${eur(c.a)}`:''} + marge ${cfg.marge} % → <b style="color:var(--tx)">${eur(ebSuggest(c,e.v))}</b></div>
  <a class="btn sm" style="margin-top:10px;text-decoration:none;color:var(--tx)" target="_blank" rel="noopener" href="${sold}">Vérifier les ventes réussies sur eBay ↗</a></div>
  <div class="row" style="margin-top:12px"><div class="grow"><label class="fld" for="ebCond">État</label><select id="ebCond">${Object.entries(COND).map(([k,l])=>`<option value="${k}" ${k===e.cond?'selected':''}>${l}</option>`).join('')}</select></div><div style="width:120px"><label class="fld" for="ebLang">Langue</label><select id="ebLang">${Object.entries(LANG).map(([k,l])=>`<option value="${k}" ${k===e.lang?'selected':''}>${l[0]}</option>`).join('')}</select></div></div>
  <div class="stack" style="margin-top:14px">
    <div class="card"><div class="row"><div class="grow sub">Titre <span class="num">(${t.length}/80)</span></div><button class="btn sm" data-act="ebCopy" data-w="title">Copier</button></div><div style="margin-top:6px;font-weight:600">${esc(t)}</div></div>
    <div class="card"><div class="row"><div class="grow sub">Description</div><button class="btn sm" data-act="ebCopy" data-w="desc">Copier</button></div><div style="margin-top:6px;white-space:pre-line;font-size:14px">${esc(d)}</div></div>
    <div class="card"><div class="row"><div class="grow sub">Caractéristiques</div><button class="btn sm" data-act="ebCopy" data-w="specs">Copier</button></div><div style="margin-top:6px;font-size:14px">${sp.map(([k,v])=>`<div class="row" style="justify-content:space-between;gap:12px;padding:3px 0;border-bottom:1px solid var(--line)"><span class="sub">${esc(k)}</span><span style="text-align:right">${esc(v)}</span></div>`).join('')}</div></div>
    <button class="btn" style="width:100%" data-act="ebCopy" data-w="all">Tout copier (titre, prix, description, caractéristiques)</button>
    <a class="btn pri" style="width:100%;text-decoration:none" target="_blank" rel="noopener" href="https://www.ebay.fr/sl/sell" data-act="ebOpen">Ouvrir eBay pour publier ↗</a>
    <div class="note">Dans eBay : colle le titre, choisis la catégorie « Cartes Pokémon à l'unité », ajoute tes photos recto/verso, puis colle la description et le prix. La catégorie et les photos se règlent dans eBay.</div>
    <button class="btn ghost" style="width:100%" data-act="close">Fermer</button>
  </div></div>`;
  if(keep&&$('#ebSheet')){ const top=$('#sheet').scrollTop; $('#sheet').innerHTML='<div class="grab"></div>'+html; $('#sheet').scrollTop=top; } else openSheet(html);
}
function ebReadPrice(){ const el=$('#ebPrice'); if(!el) return; const v=parseFloat(String(el.value).replace(/\s|€/g,'').replace(',','.')); if(isFinite(v)&&v>0){ EB.p=Math.round(v*100)/100; EB.touched=true; } }
function ebText(w){ const c=BYID.get(EB.id); ebReadPrice(); const t=ebTitle(c,EB.v,EB.lang), d=ebDesc(c,EB.v,EB), sp=ebSpecs(c,EB.v,EB).map(([k,v])=>k+' : '+v).join('\n');
  if(w==='title') return t; if(w==='desc') return d; if(w==='specs') return sp;
  return `TITRE\n${t}\n\nPRIX\n${EB.p.toFixed(2).replace('.',',')} €\n\nDESCRIPTION\n${d}\n\nCARACTÉRISTIQUES\n${sp}`; }
function ebRemember(){ ebReadPrice(); const k=EB.id+'|'+EB.v; LISTED[k]={p:EB.p,cond:EB.cond,lang:EB.lang,at:(LISTED[k]&&LISTED[k].at)||Date.now()}; lset(K.listed,LISTED); }
async function copyText(txt,label){ try{ await navigator.clipboard.writeText(txt); toast(label+' copié'+(label==='Tout'?'':'')); return true; }catch(e){ openSheet(`<div style="font-weight:800;margin-bottom:8px">Copie manuelle</div><textarea readonly>${esc(txt)}</textarea><button class="btn" style="width:100%;margin-top:10px" data-act="close">Fermer</button>`); return false; } }

/* ---------- suivi des ventes ---------- */
let SALES=lget(K.sales,[]);
const fmtDay=t=>new Date(t).toLocaleDateString('fr-FR',{day:'numeric',month:'short',year:'numeric'});
function holders(k){ return colIds().filter(id=>COLS[id].items&&COLS[id].items[k]); }
function renderSales(){
  const el=$('#v-sales'); if(!el) return;
  const act=Object.entries(LISTED).map(([k,L])=>({k,L,c:BYID.get(k.split('|')[0]),v:k.split('|')[1]})).filter(x=>x.c).sort((a,b)=>(b.L.at||0)-(a.L.at||0));
  const sold=SALES.map((x,i)=>({i,x,c:BYID.get(x.id)})).filter(x=>x.c).sort((a,b)=>b.x.at-a.x.at);
  const tA=act.reduce((s,x)=>s+x.L.p,0), tS=sold.reduce((s,x)=>s+x.x.p,0);
  el.innerHTML=`<h2>Ventes eBay</h2>
  <div class="ptab num" style="grid-template-columns:1fr 1fr"><div><small>En vente · ${act.length} carte${act.length>1?'s':''}</small><b>${eur(tA)}</b></div><div><small>Vendues · ${sold.length} carte${sold.length>1?'s':''}</small><b style="color:var(--ok)">${eur(tS)}</b></div></div>
  <div class="sub" style="font-size:12px;margin-top:6px">Total encaissé avant frais eBay et frais d'envoi.</div>
  <div class="serie">En vente</div>
  ${act.length?`<div class="list">${act.map(x=>`<div class="li"><button data-act="card" data-id="${esc(x.c.id)}" data-v="${x.v}" class="row grow" style="text-align:left">${tile(x.c)}<div class="grow"><div class="t1 ell">${esc(x.c.name)}</div><div class="t2 ell">${esc(x.c.set.name)} · ${esc(x.c.num)} · ${VLAB[x.v]||''}</div><div class="t2">depuis le ${fmtDay(x.L.at)}</div></div></button><div style="text-align:right"><div class="price num" style="margin-bottom:6px">${eur(x.L.p)}</div><button class="btn sm" data-act="saleSold" data-k="${esc(x.k)}">Vendue ?</button></div></div>`).join('')}</div>`:`<div class="empty">Aucune annonce en cours.<br>Ouvre une carte puis « Créer l'annonce eBay ».</div>`}
  <div class="serie">Vendues</div>
  ${sold.length?`<div class="list">${sold.map(x=>`<div class="li">${tile(x.c)}<div class="grow"><div class="t1 ell">${esc(x.c.name)}</div><div class="t2 ell">${esc(x.c.set.name)} · ${esc(x.c.num)} · ${VLAB[x.x.v]||''}</div><div class="t2">vendue le ${fmtDay(x.x.at)}</div></div><div style="text-align:right"><div class="price num" style="color:var(--ok);margin-bottom:6px">${eur(x.x.p)}</div><button class="btn sm ghost" data-act="saleDel" data-i="${x.i}">Annuler</button></div></div>`).join('')}</div>`:`<div class="empty">Aucune vente enregistrée.</div>`}`;
}
function openSold(k){
  const L=LISTED[k]; if(!L) return; const c=BYID.get(k.split('|')[0]); const h=holders(k);
  openSheet(`<div style="font-size:19px;font-weight:800">${esc(c.name)}</div><div class="sub" style="margin-bottom:12px">${esc(c.set.name)} · ${esc(c.num)}/${esc(c.set.off||'?')} · en vente à ${eur(L.p)}</div>
  <form id="soldForm" class="stack"><div><label class="fld" for="soldP">Prix de vente réel (€)</label><input type="text" inputmode="decimal" id="soldP" value="${L.p.toFixed(2).replace('.',',')}"></div>
  ${h.length?`<label class="row" style="gap:10px"><input type="checkbox" id="soldRm" checked style="width:20px;height:20px"><span>Retirer 1 exemplaire de « ${esc(COLS[h[0]].name)} »</span></label>`:''}
  <button class="btn pri" style="width:100%">Marquer comme vendue</button>
  <button type="button" class="btn danger" style="width:100%" data-act="saleDrop" data-k="${esc(k)}">Retirer l'annonce (pas vendue)</button>
  <button type="button" class="btn ghost" style="width:100%" data-act="close">Fermer</button></form>`);
  $('#soldForm').addEventListener('submit',e=>{ e.preventDefault();
    const p=parseFloat($('#soldP').value.replace(/\s|€/g,'').replace(',','.')); if(!isFinite(p)||p<0){ toast('Prix invalide.'); return; }
    const [id,v]=k.split('|'); SALES.push({id,v,p:Math.round(p*100)/100,at:Date.now()}); lset(K.sales,SALES); delete LISTED[k]; lset(K.listed,LISTED);
    const rm=$('#soldRm'); const doRm=rm&&rm.checked&&h.length; closeSheet();
    if(doRm){ const it=COLS[h[0]].items[k]; setQty(h[0],k,it.q-1); } else renderAll();
    toast('Vente enregistrée'); });
}

/* ---------- évolution de la valeur ---------- */
let HIST=lget(K.hist,[]);
function dayKey(t){ const d=t?new Date(t):new Date(); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
function recordHist(){
  if(!RAW) return; let v=0,n=0; colIds().forEach(id=>{ const s=colStats(COLS[id]); v+=s.v; n+=s.n; }); v=Math.round(v*100)/100;
  const d=dayKey(), last=HIST[HIST.length-1];
  if(last&&last.d===d){ if(last.v===v&&last.n===n) return; last.v=v; last.n=n; }
  else { if(!n&&!HIST.length) return; HIST.push({d,v,n}); }
  if(HIST.length>1000) HIST=HIST.slice(-1000); lset(K.hist,HIST);
}
async function dailyRefresh(){
  if(navigator.onLine===false || Date.now()-lget(K.refAt,0)<20*3600e3) return;
  const ids=[...ownedMap().keys()].slice(0,500); if(!ids.length) return;
  let i=0; const w=async()=>{ while(i<ids.length) await livePrice(ids[i++]); };
  await Promise.all([w(),w(),w(),w()]); lset(K.prices,LIVE); lset(K.refAt,Date.now()); recordHist(); renderAll();
}
function histPts(){ const r=S.hr||'all'; if(r==='all') return HIST; const cut=dayKey(Date.now()-(+r)*864e5); return HIST.filter(p=>p.d>=cut); }
const dLab=d=>new Date(d+'T12:00:00').toLocaleDateString('fr-FR',{day:'numeric',month:'short'});
const HG={W:340,H:150,l:6,r:6,t:14,b:22};
function histGeom(pts){
  const t=pts.map(p=>new Date(p.d+'T12:00:00').getTime()); const t0=t[0], t1=t[t.length-1]||t0+1;
  let lo=Math.min(...pts.map(p=>p.v)), hi=Math.max(...pts.map(p=>p.v)); if(hi-lo<1){ hi+=1; lo=Math.max(0,lo-1); } const pad=(hi-lo)*0.12; lo=Math.max(0,lo-pad); hi+=pad;
  const x=i=>HG.l+(t1===t0?0.5:(t[i]-t0)/(t1-t0))*(HG.W-HG.l-HG.r), y=v=>HG.t+(1-(v-lo)/(hi-lo))*(HG.H-HG.t-HG.b);
  return {x,y,lo,hi};
}
function histBlock(){
  if(!HIST.length) return '';
  const pts=histPts(); const seg=`<div class="seg" style="width:190px">${[['30','30 j'],['90','90 j'],['all','Tout']].map(([v,l])=>`<button data-act="histRange" data-r="${v}" class="${(S.hr||'all')===v?'on':''}">${l}</button>`).join('')}</div>`;
  let body;
  if(pts.length<2){ body=`<div class="note" style="margin-top:10px">Le suivi a démarré le ${dLab(HIST[0].d)}. La valeur est relevée chaque jour où tu ouvres l'appli : la courbe apparaît dès le deuxième relevé.</div>`; }
  else {
    const g=histGeom(pts), a=pts[0], z=pts[pts.length-1], diff=z.v-a.v, pct=a.v>0?diff/a.v*100:null;
    const path=pts.map((p,i)=>(i?'L':'M')+g.x(i).toFixed(1)+' '+g.y(p.v).toFixed(1)).join(' ');
    const grid=[0,0.5,1].map(f=>{ const v=g.lo+(g.hi-g.lo)*f, yy=g.y(v).toFixed(1); return `<line x1="${HG.l}" x2="${HG.W-HG.r}" y1="${yy}" y2="${yy}" stroke="#2c3250" stroke-width="1"/><text x="${HG.l}" y="${yy-4}" fill="#9aa1ba" font-size="10" stroke="#171b2e" stroke-width="3" paint-order="stroke">${esc(eur(v))}</text>`; }).join('');
    body=`<div class="num" style="margin:10px 0 2px;font-weight:700;color:${diff>0?'var(--ok)':diff<0?'var(--red)':'var(--mu)'}">${diff>0?'▲ +':diff<0?'▼ ':'= '}${eur(diff)}${pct!=null?` (${pct>0?'+':''}${pct.toFixed(1).replace('.',',')} %)`:''} <span class="sub" style="font-weight:400">depuis le ${dLab(a.d)}</span></div>
    <div class="histwrap"><svg id="histSvg" viewBox="0 0 ${HG.W} ${HG.H}" role="img" aria-label="Valeur de la collection dans le temps">${grid}<path d="${path}" fill="none" stroke="#ffcb3d" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>${pts.length<=40?pts.map((p,i)=>`<circle cx="${g.x(i).toFixed(1)}" cy="${g.y(p.v).toFixed(1)}" r="2.5" fill="#ffcb3d"/>`).join(''):''}<g id="histCur" style="display:none"><line id="histLine" y1="${HG.t}" y2="${HG.H-HG.b}" stroke="#9aa1ba" stroke-width="1"/><circle id="histDot" r="5" fill="#ffcb3d" stroke="#171b2e" stroke-width="2"/></g><text x="${HG.l}" y="${HG.H-6}" fill="#9aa1ba" font-size="11">${esc(dLab(a.d))}</text><text x="${HG.W-HG.r}" y="${HG.H-6}" fill="#9aa1ba" font-size="11" text-anchor="end">${esc(dLab(z.d))}</text></svg><div class="histtip num" id="histTip"></div></div>
    <details class="sub" style="margin-top:6px"><summary>Voir les relevés</summary><table class="histtab num">${pts.slice(-30).reverse().map(p=>`<tr><td>${esc(dLab(p.d))}</td><td>${p.n} cartes</td><td style="text-align:right">${eur(p.v)}</td></tr>`).join('')}</table></details>`;
  }
  return `<div class="card" style="margin-top:12px"><div class="row" style="justify-content:space-between"><div style="font-weight:700">Évolution de la valeur</div>${HIST.length>1?seg:''}</div>${body}</div>`;
}
function bindHist(){
  const svg=$('#histSvg'); if(!svg) return; const pts=histPts(); if(pts.length<2) return; const g=histGeom(pts);
  const move=e=>{ const r=svg.getBoundingClientRect(); const px=(e.clientX-r.left)/r.width*HG.W; let bi=0,bd=1e9; pts.forEach((p,i)=>{ const d=Math.abs(g.x(i)-px); if(d<bd){ bd=d; bi=i; } });
    const cx=g.x(bi), cy=g.y(pts[bi].v); $('#histCur').style.display=''; $('#histLine').setAttribute('x1',cx); $('#histLine').setAttribute('x2',cx); $('#histDot').setAttribute('cx',cx); $('#histDot').setAttribute('cy',cy);
    const tip=$('#histTip'); tip.innerHTML=`<b>${eur(pts[bi].v)}</b> · ${esc(dLab(pts[bi].d))} · ${pts[bi].n} cartes`; tip.style.display='block'; const tw=tip.offsetWidth, left=Math.min(Math.max(0,cx/HG.W*r.width-tw/2), r.width-tw); tip.style.left=left+'px'; };
  const out=()=>{ $('#histCur').style.display='none'; $('#histTip').style.display='none'; };
  svg.addEventListener('pointerdown',move); svg.addEventListener('pointermove',move); svg.addEventListener('pointerleave',out);
}
function moversBlock(){
  const seen=new Map();
  colIds().forEach(id=>Object.values(COLS[id].items||{}).forEach(it=>{ const c=BYID.get(it.id); if(!c) return; const now=it.v==='R'?c.th:c.t, avg=it.v==='R'?c.ah:c.a; if(now==null||avg==null||avg<1) return; const k=it.id+'|'+it.v; if(!seen.has(k)) seen.set(k,{c,v:it.v,now,pct:(now-avg)/avg*100}); }));
  const all=[...seen.values()].filter(x=>Math.abs(x.pct)>=3);
  const up=all.filter(x=>x.pct>0).sort((a,b)=>b.pct-a.pct).slice(0,3), down=all.filter(x=>x.pct<0).sort((a,b)=>a.pct-b.pct).slice(0,3);
  if(!up.length&&!down.length) return '';
  const row=x=>`<button class="li" data-act="card" data-id="${esc(x.c.id)}" data-v="${x.v}">${tile(x.c)}<div class="grow"><div class="t1 ell">${esc(x.c.name)}</div><div class="t2 ell">${esc(x.c.set.name)} · ${esc(x.c.num)}</div></div><div class="price num">${eur(x.now)}<small style="color:${x.pct>0?'var(--ok)':'var(--red)'};font-weight:700;font-size:12px">${x.pct>0?'▲ +':'▼ '}${x.pct.toFixed(0)} %</small></div></button>`;
  return `<div class="card" style="margin-top:12px;padding-bottom:6px"><div style="font-weight:700">Cartes qui bougent</div><div class="sub" style="font-size:12px;margin-bottom:8px">Prix actuel comparé à la moyenne des 30 derniers jours (Cardmarket).</div>${up.length?`<div class="sub" style="font-size:12px;font-weight:700">En hausse</div><div class="list flat">${up.map(row).join('')}</div>`:''}${down.length?`<div class="sub" style="font-size:12px;font-weight:700;margin-top:8px">En baisse</div><div class="list flat">${down.map(row).join('')}</div>`:''}</div>`;
}

/* ---------- settings ---------- */
function openSettings(){
  const k=apiKey(), m=modelPref();
  openSheet(`<div style="font-size:20px;font-weight:800;margin-bottom:4px">Réglages</div>
  <div class="sub" style="margin-bottom:14px">La reconnaissance utilise l'IA Gemini de Google avec ta propre clé d'API. La clé est gratuite, avec un nombre de scans limité par minute et par jour.</div>
  <form id="setForm" class="stack">
    <div><label class="fld" for="keyIn">Clé d'API Gemini</label><input type="text" id="keyIn" autocomplete="off" spellcheck="false" placeholder="AIza…" value="${esc(k)}"></div>
    <div class="note">Crée ta clé sur <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a> avec ton compte Google (bouton « Create API key »), puis colle-la ici. Elle reste uniquement sur ce téléphone : ne la partage pas.</div>
    <div><label class="fld">Mode de reconnaissance</label><div class="seg" id="modelSeg">${Object.entries(MODELS).map(([id,o])=>`<button type="button" data-act="setModel" data-m="${id}" class="${id===m?'on':''}">${o.label}</button>`).join('')}</div><div class="sub" style="font-size:12px;margin-top:6px">Précis : Gemini Flash, plus fiable. Économique : Gemini Flash-Lite, plus rapide et avec plus de scans gratuits par jour.</div></div>
    <div class="row"><button type="button" class="btn grow" data-act="testKey">Tester la clé</button></div>
    <div id="testOut" class="sub"></div>
    <div style="font-size:17px;font-weight:800;margin-top:8px">Annonces eBay</div>
    <div class="row"><div class="grow"><label class="fld" for="ebMarge">Marge sur la cote (%)</label><input type="text" inputmode="decimal" id="ebMarge" value="${esc(ebCfg().marge)}"></div><div class="grow"><label class="fld" for="ebMin">Prix minimum (€)</label><input type="text" inputmode="decimal" id="ebMin" value="${esc(String(ebCfg().min).replace('.',','))}"></div></div>
    <div><label class="fld" for="ebShip">Texte de fin d'annonce (envoi, conditions)</label><textarea id="ebShip" style="min-height:80px">${esc(ebCfg().ship)}</textarea></div>
    <button class="btn pri" style="width:100%">Enregistrer</button>
    ${k?'<button type="button" class="btn ghost danger" data-act="delKey">Supprimer la clé de ce téléphone</button>':''}
  </form>`);
  $('#setForm').addEventListener('submit',e=>{ e.preventDefault(); lset(K.key,$('#keyIn').value.trim());
    const num=x=>parseFloat(String(x).replace(',','.')); const cfg=ebCfg(); const mg=num($('#ebMarge').value), mn=num($('#ebMin').value);
    lset(K.ebay,Object.assign(cfg,{marge:isFinite(mg)?mg:cfg.marge,min:isFinite(mn)?mn:cfg.min,ship:$('#ebShip').value.trim()})); closeSheet(); renderAll(); toast('Réglages enregistrés'); });
}
async function testKey(){
  const k=$('#keyIn').value.trim(); const out=$('#testOut'); if(!k){ out.textContent='Colle d’abord ta clé.'; return; }
  out.innerHTML='<span class="spin" style="display:inline-block;vertical-align:-4px"></span> Test…';
  try{
    await discoverModels(k,true);
    const txt=await gemini(k,[{text:'Return {"ok":true} as JSON.'}],256);
    out.innerHTML=`<span style="color:var(--ok)">Clé valide, tout est prêt.</span> <span style="font-size:12px">(modèle : ${esc(await modelId(k))})</span>`;
  }catch(e){ out.textContent=errText(e); }
}

/* ---------- dialogs / backup ---------- */
function askName(title,val,cb){
  openSheet(`<div style="font-size:19px;font-weight:800;margin-bottom:12px">${esc(title)}</div><form id="nmForm" class="stack"><input type="text" id="nmIn" maxlength="40" value="${esc(val||'')}" placeholder="Ex : Classeur Écarlate et Violet"><div class="row"><button type="button" class="btn grow" data-act="close">Annuler</button><button class="btn pri grow">Valider</button></div></form>`);
  const i=$('#nmIn'); setTimeout(()=>{ try{ i.focus(); i.select(); }catch(e){} },250);
  $('#nmForm').addEventListener('submit',e=>{ e.preventDefault(); const v=i.value.trim(); if(!v) return; closeSheet(); cb(v); });
}
function newCol(after){ askName('Nouvelle collection','',name=>{ const id='c'+Date.now().toString(36)+Math.random().toString(36).slice(2,6); COLS[id]={name,created:Date.now(),items:{}}; saveCols(); S.target=id; lset(K.target,id); renderAll(); if(after) after(id); toast('Collection créée'); }); }
function listText(col){ const s=colStats(col); return `${col.name} — ${s.n} cartes — ${eur(s.v)}\n\n`+Object.values(col.items||{}).map(it=>({it,c:BYID.get(it.id)})).filter(x=>x.c).sort((a,b)=>(price(b.c,b.it.v)||0)-(price(a.c,a.it.v)||0)).map(x=>`${x.it.q} × ${x.c.name} — ${x.c.set.name} ${x.c.num}/${x.c.set.off||'?'} (${VLAB[x.it.v]}) — ${eur(price(x.c,x.it.v))}`).join('\n'); }
function backup(){
  const blob=new Blob([JSON.stringify({app:'coteo',v:2,date:new Date().toISOString(),cols:COLS,listed:LISTED,sales:SALES,hist:HIST},null,1)],{type:'application/json'});
  const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='coteo-sauvegarde-'+new Date().toISOString().slice(0,10)+'.json'; document.body.appendChild(a); a.click(); setTimeout(()=>{ URL.revokeObjectURL(a.href); a.remove(); },1000);
}
function restore(file){
  const r=new FileReader(); r.onload=()=>{ try{ const d=JSON.parse(r.result); if(!d||!d.cols) throw 0;
    let n=0; Object.entries(d.cols).forEach(([id,c])=>{ if(!c||!c.items) return; if(COLS[id]){ Object.entries(c.items).forEach(([k,it])=>{ const cur=COLS[id].items[k]; if(!cur||(it.t||0)>(cur.t||0)) COLS[id].items[k]=it; }); } else COLS[id]=c; n++; });
    if(d.listed){ Object.entries(d.listed).forEach(([k,L])=>{ if(!LISTED[k]) LISTED[k]=L; }); lset(K.listed,LISTED); }
    if(Array.isArray(d.sales)){ const have=new Set(SALES.map(x=>x.id+x.v+x.at)); d.sales.forEach(x=>{ if(x&&!have.has(x.id+x.v+x.at)) SALES.push(x); }); lset(K.sales,SALES); }
    if(Array.isArray(d.hist)){ const m=new Map(d.hist.filter(p=>p&&p.d).map(p=>[p.d,p])); HIST.forEach(p=>m.set(p.d,p)); HIST=[...m.values()].sort((a,b)=>a.d.localeCompare(b.d)); lset(K.hist,HIST); }
    saveCols(); renderAll(); toast(n+' collection'+(n>1?'s':'')+' restaurée'+(n>1?'s':'')); }catch(e){ toast('Fichier de sauvegarde invalide.'); } };
  r.readAsText(file);
}

/* ---------- events ---------- */
document.addEventListener('change',e=>{
  const t=e.target;
  if(t.matches('input[type=file][data-scan]')){ const f=t.files&&t.files[0]; t.value=''; if(f){ if(!apiKey()){ openSettings(); return; } onFile(f); } return; }
  if(t.id==='restoreIn'){ const f=t.files&&t.files[0]; t.value=''; if(f) restore(f); return; }
  if(t.id==='target'){ if(t.value==='__new'){ t.value=validTarget(); newCol(); } else { S.target=t.value; lset(K.target,t.value); } return; }
  if(t.id==='shCol'){ if(t.value==='__new'){ const keep={...SH}; newCol(id=>{ SH=keep; SH.col=id; renderCardSheet(); }); } else SH.col=t.value; return; }
  if(t.id==='sortSel'){ S.sort=t.value; renderCols(); }
  if(t.id==='ebCond'||t.id==='ebLang'){ ebReadPrice(); EB[t.id==='ebCond'?'cond':'lang']=t.value; renderEbay(true); }
  if(t.id==='ebPrice'){ ebReadPrice(); }
});
let qT; $('#q').addEventListener('input',e=>{ clearTimeout(qT); qT=setTimeout(()=>{ S.q=e.target.value; renderExplore(); },180); });
document.addEventListener('click',e=>{
  const tb=e.target.closest('[data-tab]'); if(tb){ setTab(tb.dataset.tab); return; }
  const b=e.target.closest('[data-act]'); if(!b) return; const a=b.dataset.act, k=b.dataset.k;
  if(b.tagName==='A') e.preventDefault();
  switch(a){
    case 'close': closeSheet(); break;
    case 'ebay': openEbay(); break;
    case 'saleSold': openSold(k); break;
    case 'saleDrop': delete LISTED[k]; lset(K.listed,LISTED); closeSheet(); renderAll(); toast('Annonce retirée'); break;
    case 'saleDel': SALES.splice(+b.dataset.i,1); lset(K.sales,SALES); renderAll(); toast('Vente annulée'); break;
    case 'histRange': S.hr=b.dataset.r; renderCols(); break;
    case 'ebReset': EB.touched=false; EB.p=ebSuggest(BYID.get(EB.id),EB.v); renderEbay(true); break;
    case 'ebCopy': { const w=b.dataset.w; copyText(ebText(w),{title:'Titre',desc:'Description',specs:'Caractéristiques',all:'Tout'}[w]); ebRemember(); break; }
    case 'ebOpen': ebRemember(); window.open(b.href,'_blank','noopener'); break;
    case 'settings': openSettings(); break;
    case 'setModel': lset(K.model,b.dataset.m); document.querySelectorAll('#modelSeg button').forEach(x=>x.classList.toggle('on',x===b)); break;
    case 'testKey': testKey(); break;
    case 'delKey': try{ localStorage.removeItem(K.key); }catch(err){} closeSheet(); renderAll(); toast('Clé supprimée'); break;
    case 'openCam': openCam(); break;
    case 'closeCam': closeCam(); break;
    case 'camMode': setCamMode(b.dataset.m); break;
    case 'torch': { const tr=STREAM&&STREAM.getVideoTracks()[0]; if(tr){ TORCH=!TORCH; tr.applyConstraints({advanced:[{torch:TORCH}]}).catch(()=>{}); b.classList.toggle('on',TORCH); } break; }
    case 'shoot': shoot(false); break;
    case 'camToList': closeCam(); setTab('scan'); break;
    case 'addBatch': { const p=S.results.filter(r=>r.batch===S.lastBatch&&r.state==='new'&&r.pick); p.forEach(addResult); renderCamLast(); renderCamSess(); toast(p.length+' cartes ajoutées'); break; }
    case 'goSearch': setTab('explore'); setTimeout(()=>$('#q').focus(),50); break;
    case 'resV': { const r=findRes(k); r.v=b.dataset.v; renderResults(); break; }
    case 'resAdd': { const r=findRes(k); addResult(r); renderResults(); renderSession(); renderCamLast(); renderCamSess(); toast('Ajoutée à « '+(COLS[validTarget()]||{}).name+' »'); break; }
    case 'resSkip': findRes(k).state='skip'; renderResults(); break;
    case 'resAlt': { const r=findRes(k); r.open=!r.open; renderResults(); break; }
    case 'resPick': { const r=findRes(k); r.pick=b.dataset.id; const vs=variants(BYID.get(r.pick)); if(!vs.includes(r.v)) r.v=vs[0]; r.open=false; r.amb=false; livePrice(r.pick).then(renderResults); renderResults(); break; }
    case 'resSearch': { const r=findRes(k); S.q=r.d.name_fr||r.d.name_printed||''; $('#q').value=S.q; setTab('explore'); break; }
    case 'addAll': { const p=S.results.filter(r=>r.state==='new'&&r.pick); p.forEach(addResult); renderResults(); renderSession(); toast(p.length+' cartes ajoutées'); break; }
    case 'clearRes': S.results=[]; renderResults(); break;
    case 'openCol': S.col=b.dataset.id; renderCols(); window.scrollTo(0,0); break;
    case 'colBack': S.col=null; renderCols(); break;
    case 'newCol': newCol(); break;
    case 'refreshCol': refreshCol(); break;
    case 'colMenu': openSheet(`<div style="font-size:19px;font-weight:800;margin-bottom:12px">${esc(COLS[S.col].name)}</div><div class="stack"><button class="btn" style="width:100%" data-act="rename">Renommer</button><button class="btn" style="width:100%" data-act="shareList">Partager la liste</button><button class="btn danger" style="width:100%" data-act="delAsk">Supprimer la collection</button><button class="btn ghost" style="width:100%" data-act="close">Fermer</button></div>`); break;
    case 'rename': { const col=COLS[S.col]; askName('Renommer',col.name,v=>{ col.name=v; saveCols(); renderAll(); }); break; }
    case 'shareList': { const txt=listText(COLS[S.col]); closeSheet();
        if(navigator.share){ navigator.share({title:COLS[S.col].name,text:txt}).catch(()=>{}); }
        else if(navigator.clipboard){ navigator.clipboard.writeText(txt).then(()=>toast('Liste copiée'),()=>toast('Copie impossible')); } break; }
    case 'delAsk': openSheet(`<div style="font-size:19px;font-weight:800;margin-bottom:6px">Supprimer « ${esc(COLS[S.col].name)} » ?</div><div class="sub" style="margin-bottom:14px">Toutes les cartes de cette collection seront retirées. C'est définitif.</div><div class="row"><button class="btn grow" data-act="close">Annuler</button><button class="btn grow danger" data-act="delYes">Supprimer</button></div>`); break;
    case 'delYes': delete COLS[S.col]; S.col=null; saveCols(); closeSheet(); renderAll(); toast('Collection supprimée'); break;
    case 'backup': backup(); break;
    case 'qty': { const it=COLS[S.col].items[k]; if(it) setQty(S.col,k,it.q+parseInt(b.dataset.d,10)); break; }
    case 'card': openCard(b.dataset.id,b.dataset.v); break;
    case 'shV': SH.v=b.dataset.v; renderCardSheet(true); break;
    case 'shQ': SH.q=Math.max(1,SH.q+parseInt(b.dataset.d,10)); renderCardSheet(true); break;
    case 'shAdd': { const cid=SH.col==='__new'?validTarget():SH.col; addCard(cid,SH.id,SH.v,SH.q); closeSheet(); toast(SH.q+' × '+BYID.get(SH.id).name+' ajoutée'+(SH.q>1?'s':'')); break; }
    case 'openSet': S.exSet=+b.dataset.i; renderExplore(); window.scrollTo(0,0); break;
    case 'exBack': S.exSet=null; renderExplore(); break;
  }
});
document.addEventListener('visibilitychange',()=>{ if(document.hidden && STREAM) closeCam(); });
function setTab(t){ S.tab=t; document.querySelectorAll('[data-tab]').forEach(x=>x.classList.toggle('on',x.dataset.tab===t)); ['scan','cols','sales','explore'].forEach(v=>$('#v-'+v).classList.toggle('on',v===t)); window.scrollTo(0,0); renderAll(); }

/* ---------- start ---------- */
$('#scanRes').innerHTML='<div class="card row"><div class="spin"></div><div>Chargement de la base de cartes…</div></div>';
loadDB().then(()=>{ recordHist(); renderAll(); dailyRefresh(); }).catch(()=>{ $('#scanRes').innerHTML='<div class="note warn">Impossible de charger la base de cartes. Vérifie ta connexion puis recharge la page.</div>'; });
if('serviceWorker' in navigator){ window.addEventListener('load',()=>navigator.serviceWorker.register('sw.js').catch(()=>{})); }
})();
