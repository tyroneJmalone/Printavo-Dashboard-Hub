"""Builds the PrintScope viewer page from everything in queue/."""
import glob, html, json, os, sys

import config as CFG

HERE = os.path.dirname(os.path.abspath(__file__))
QUEUE = CFG.QUEUE_DIR
SITE = CFG.SITE_DIR

CSS = """
:root{
  --paper:#F1F3F2; --surface:#FFFFFF; --surface-2:#E8ECEA;
  --ink:#14201D; --ink-2:#4A5A55; --ink-3:#7B8C87;
  --line:#D3DAD7; --line-2:#BDC7C3;
  --accent:#0B6E63;
  --pass:#2F7D4F; --pass-bg:#E2F0E7;
  --flag:#A35A08; --flag-bg:#FBEDDC;
  --fail:#A82520; --fail-bg:#FAE3E1;
  --info:#4A5A55; --info-bg:#E8ECEA;
  --mono:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,monospace;
  --body:"IBM Plex Sans",system-ui,-apple-system,Segoe UI,sans-serif;
  --disp:"Archivo","IBM Plex Sans",system-ui,sans-serif;
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --paper:#0E1614; --surface:#16211E; --surface-2:#1E2C28;
  --ink:#E4EBE8; --ink-2:#A6B5B0; --ink-3:#7A8983;
  --line:#2A3A35; --line-2:#3A4C46;
  --accent:#3FB3A3;
  --pass:#68C18C; --pass-bg:#13291D;
  --flag:#E0A253; --flag-bg:#2E2213;
  --fail:#F08279; --fail-bg:#331816;
  --info:#A6B5B0; --info-bg:#1E2C28;
}}
:root[data-theme="dark"]{
  --paper:#0E1614; --surface:#16211E; --surface-2:#1E2C28;
  --ink:#E4EBE8; --ink-2:#A6B5B0; --ink-3:#7A8983;
  --line:#2A3A35; --line-2:#3A4C46;
  --accent:#3FB3A3;
  --pass:#68C18C; --pass-bg:#13291D;
  --flag:#E0A253; --flag-bg:#2E2213;
  --fail:#F08279; --fail-bg:#331816;
  --info:#A6B5B0; --info-bg:#1E2C28;
}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font-family:var(--body);
  font-size:15px;line-height:1.5;-webkit-font-smoothing:antialiased}
h1,h2,h3{font-family:var(--disp);font-weight:700;text-wrap:balance;margin:0}
.lbl{font-family:var(--disp);font-size:11px;font-weight:700;letter-spacing:.09em;
  text-transform:uppercase;color:var(--ink-3)}
.num{font-variant-numeric:tabular-nums}
code,.mono{font-family:var(--mono);font-size:.86em}

header.top{position:sticky;top:env(safe-area-inset-top,0px);z-index:30;
  background:var(--surface);border-bottom:1px solid var(--line);
  padding:10px 16px;display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.brand{font-family:var(--disp);font-weight:700;font-size:17px;letter-spacing:-.01em;
  display:flex;align-items:center;gap:9px}
.brand .dot{width:9px;height:9px;border-radius:50%;background:var(--accent)}
.legend{display:flex;gap:6px;margin-left:auto;flex-wrap:wrap}
.key{display:inline-flex;align-items:center;gap:5px;font-size:11px;color:var(--ink-2)}
.key i{width:9px;height:9px;border-radius:2px;display:inline-block}

.wrap{display:grid;grid-template-columns:288px minmax(0,1fr);gap:0;
  min-height:calc(100dvh - 52px)}
@media (max-width:860px){.wrap{grid-template-columns:1fr}}

/* queue rail */
aside{border-right:1px solid var(--line);background:var(--surface);
  padding:14px 0 30px}
@media (max-width:860px){aside{border-right:none;border-bottom:1px solid var(--line);
  padding-bottom:10px}}
.railhead{padding:0 16px 10px;display:flex;align-items:baseline;gap:8px}
.qlist{display:flex;flex-direction:column}
@media (max-width:860px){.qlist{flex-direction:row;overflow-x:auto;gap:8px;
  padding:0 16px 4px;scroll-snap-type:x mandatory}}
.qitem{display:grid;grid-template-columns:4px 1fr;gap:10px;align-items:stretch;
  padding:0;border:0;background:none;color:inherit;text-align:left;cursor:pointer;
  border-bottom:1px solid var(--line);font:inherit}
@media (max-width:860px){.qitem{border:1px solid var(--line);border-radius:8px;
  min-width:210px;scroll-snap-align:start;overflow:hidden}}
.qitem:last-child{border-bottom:0}
.qitem .stripe{background:var(--line-2)}
.qitem[data-v="fail"] .stripe{background:var(--fail)}
.qitem[data-v="flag"] .stripe{background:var(--flag)}
.qitem[data-v="pass"] .stripe{background:var(--pass)}
.qitem .body{padding:10px 14px 11px 4px;min-width:0}
@media (max-width:860px){.qitem .body{padding:9px 12px}}
.qitem:hover{background:var(--surface-2)}
.qitem[aria-current="true"]{background:var(--surface-2)}
.qitem[aria-current="true"] .fn{color:var(--accent)}
.fn{font-family:var(--mono);font-size:12.5px;font-weight:500;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.qmeta{font-size:11px;color:var(--ink-3);margin-top:3px;display:flex;gap:8px}

/* detail */
main{padding:20px 16px 56px;min-width:0}
@media (min-width:861px){main{padding:24px 28px 72px}}
.banner{display:flex;align-items:flex-start;gap:16px;flex-wrap:wrap;
  padding:16px 18px;border-radius:10px;border:1px solid var(--line);
  background:var(--surface);border-left:5px solid var(--line-2)}
.banner[data-v="fail"]{border-left-color:var(--fail);background:var(--fail-bg)}
.banner[data-v="flag"]{border-left-color:var(--flag);background:var(--flag-bg)}
.banner[data-v="pass"]{border-left-color:var(--pass);background:var(--pass-bg)}
.verdict{font-family:var(--disp);font-size:26px;font-weight:700;letter-spacing:-.02em;
  line-height:1.1}
.banner[data-v="fail"] .verdict{color:var(--fail)}
.banner[data-v="flag"] .verdict{color:var(--flag)}
.banner[data-v="pass"] .verdict{color:var(--pass)}
.bmeta{margin-left:auto;text-align:right;font-size:11.5px;color:var(--ink-2);
  font-family:var(--mono)}
.tally{display:flex;gap:14px;margin-top:6px;font-size:12px;color:var(--ink-2)}
.tally b{font-variant-numeric:tabular-nums}

section.blk{margin-top:22px}
.blkhead{display:flex;align-items:baseline;gap:10px;margin-bottom:10px}

/* plate viewer */
.plate{border:1px solid var(--line);border-radius:10px;background:var(--surface);
  overflow:hidden}
.ptools{display:flex;gap:8px;align-items:center;flex-wrap:wrap;
  padding:10px 12px;border-bottom:1px solid var(--line);background:var(--surface-2)}
.tab{font:inherit;font-size:12px;font-family:var(--disp);font-weight:600;
  padding:5px 11px;border-radius:6px;border:1px solid var(--line-2);
  background:var(--surface);color:var(--ink-2);cursor:pointer}
.tab[aria-pressed="true"]{background:var(--accent);border-color:var(--accent);color:#fff}
.zoom{margin-left:auto;display:flex;align-items:center;gap:8px;font-size:11px;
  color:var(--ink-3)}
.zoom input{width:120px;accent-color:var(--accent)}
.swatches{display:flex;gap:6px;flex-wrap:wrap;padding:9px 12px;
  border-bottom:1px solid var(--line);align-items:center}
.abtag{font-family:var(--disp);font-size:10px;font-weight:700;letter-spacing:.07em;
  text-transform:uppercase;color:var(--ink-3);padding:0 2px 0 6px}
.abtag:first-child{padding-left:0}
.abtag.base{color:var(--accent)}
.swsep{width:1px;align-self:stretch;background:var(--line);margin:0 2px}
.sw{display:inline-flex;align-items:center;gap:6px;font:inherit;font-size:11.5px;
  font-family:var(--mono);padding:4px 9px;border-radius:999px;cursor:pointer;
  border:1px solid var(--line-2);background:var(--surface);color:var(--ink-2)}
.sw i{width:10px;height:10px;border-radius:2px;flex:none}
.sw[aria-pressed="false"]{opacity:.38;text-decoration:line-through}
.stage{position:relative;overflow:auto;background:
  repeating-conic-gradient(var(--surface-2) 0% 25%, var(--surface) 0% 50%) 50%/16px 16px;
  height:min(60dvh,540px);touch-action:pan-x pan-y}
@media (max-width:860px){.stage{height:min(52dvh,400px)}}
.canvas{position:relative}
.canvas img{display:block;width:100%;height:auto;max-width:none}
.canvas img+img{position:absolute;left:0;top:0}
.canvas img.px{image-rendering:auto}
.vecnote{font-size:11px;color:var(--ink-3);padding:6px 12px;border-top:1px solid var(--line)}

/* rules */
.rules{display:flex;flex-direction:column;gap:0;border:1px solid var(--line);
  border-radius:10px;background:var(--surface);overflow:hidden}
.rule{display:grid;grid-template-columns:76px minmax(0,1fr);gap:0;
  border-bottom:1px solid var(--line)}
.rule:last-child{border-bottom:0}
@media (max-width:560px){.rule{grid-template-columns:1fr}}
.st{display:flex;align-items:flex-start;justify-content:center;padding:13px 8px;
  font-family:var(--disp);font-size:10.5px;font-weight:700;letter-spacing:.08em;
  text-transform:uppercase}
.st.pass{background:var(--pass-bg);color:var(--pass)}
.st.flag{background:var(--flag-bg);color:var(--flag)}
.st.fail{background:var(--fail-bg);color:var(--fail)}
.st.info{background:var(--info-bg);color:var(--info)}
.st.not_applicable{background:transparent;color:var(--ink-3)}
.st.not_implemented{background:transparent;color:var(--ink-3)}
.st.cannot_evaluate{background:var(--flag-bg);color:var(--flag)}
.st.error{background:var(--fail-bg);color:var(--fail)}
.gap{margin-top:10px;padding:10px 14px;border-radius:8px;font-size:12.5px;
  background:var(--flag-bg);color:var(--flag);border:1px solid var(--flag);
  display:flex;gap:8px;align-items:flex-start;flex-basis:100%}
.gap b{font-family:var(--disp);letter-spacing:.02em}
@media (max-width:560px){.st{justify-content:flex-start;padding:9px 14px 0}}
.rbody{padding:12px 16px 14px;min-width:0}
.rname{font-family:var(--disp);font-weight:600;font-size:13px;letter-spacing:.01em}
.rcode{font-family:var(--mono);font-size:10.5px;color:var(--ink-3);margin-left:6px}
.rhead{margin-top:3px;font-size:14px}
.rdet{margin:7px 0 0;padding:0;list-style:none;display:flex;flex-direction:column;
  gap:3px;font-size:12.5px;color:var(--ink-2);font-family:var(--mono);
  overflow-wrap:anywhere}
.rfix{margin-top:9px;font-size:12.5px;color:var(--ink-2);
  border-left:2px solid var(--line-2);padding-left:10px}
details.fold{margin-top:12px;border:1px solid var(--line);border-radius:10px;
  background:var(--surface);overflow:hidden}
details.fold>summary{cursor:pointer;padding:11px 16px;font-family:var(--disp);
  font-size:12px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;
  color:var(--ink-2);list-style:none}
details.fold>summary::-webkit-details-marker{display:none}
details.fold>summary::after{content:" +";color:var(--ink-3)}
details.fold[open]>summary::after{content:" –"}
details.fold .rules{border:0;border-radius:0;border-top:1px solid var(--line)}
.foot{margin-top:28px;font-size:11.5px;color:var(--ink-3);
  border-top:1px solid var(--line);padding-top:12px}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
"""

JS = """
const Q = window.__PS__;
let cur = 0, ab = -1, zoomPct = 100, colourPct = 100, basePct = 100;
let focus = null;            // viewport centre, as a fraction of the canvas
const hidden = new Set();

const esc = s => String(s).replace(/[&<>"]/g, c =>
  ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

function statusOrder(s){ return {fail:0, error:1, cannot_evaluate:2, flag:3,
  pass:4, info:5, not_applicable:6, not_implemented:7}[s] ?? 9; }
const LABEL = {not_applicable:'n/a', cannot_evaluate:'unverified',
               not_implemented:'not built', error:'error'};

function ruleHTML(r){
  const fix = (r.status==='fail'||r.status==='flag') && r.remediation
    ? `<div class="rfix">${esc(r.remediation)}</div>` : '';
  const det = (r.detail||[]).length
    ? `<ul class="rdet">${r.detail.map(d=>`<li>${esc(d)}</li>`).join('')}</ul>` : '';
  return `<div class="rule">
    <div class="st ${r.status}">${LABEL[r.status] || r.status}</div>
    <div class="rbody">
      <div><span class="rname">${esc(r.name)}</span><span class="rcode">${esc(r.code)}</span></div>
      <div class="rhead">${esc(r.headline)}</div>
      ${det}${fix}
    </div></div>`;
}

function render(){
  const rec = Q[cur];
  document.querySelectorAll('.qitem').forEach((el,i)=>
    el.setAttribute('aria-current', i===cur ? 'true':'false'));

  const c = {};
  rec.results.forEach(r => c[r.status] = (c[r.status]||0)+1);
  const words = {fail:'Send it back', flag:'Look at it', pass:'Clear to run'};

  const attention = rec.results.filter(r=>r.status==='fail'||r.status==='flag')
                               .sort((a,b)=>statusOrder(a.status)-statusOrder(b.status));
  const unver  = rec.results.filter(r=>r.status==='cannot_evaluate'||r.status==='error')
                            .sort((a,b)=>statusOrder(a.status)-statusOrder(b.status));
  const passed = rec.results.filter(r=>r.status==='pass');
  const noted  = rec.results.filter(r=>r.status==='info');
  const na     = rec.results.filter(r=>r.status==='not_applicable');
  const nyb    = rec.results.filter(r=>r.status==='not_implemented');
  const comp   = rec.completeness || {};

  const pv = rec.previews || [];
  if (ab >= pv.length) ab = -1;
  // "All stacked" lays every artboard into one canvas the way they sit on the
  // shirt: underbase first so it sits under the colours, and whatever the base
  // pokes out past a colour is the trap, visible without measuring anything.
  const stackOrder = pv.slice().sort((a,b)=>
    (b.is_underbase?1:0)-(a.is_underbase?1:0) || a.index-b.index);
  const shown = ab === -1 ? stackOrder : [pv[ab]];
  const maxW = Math.max(...shown.map(b=>b.w||0), 1);
  const board = shown[0];
  const layerRows = [];
  shown.forEach(b => b.plates.forEach(p =>
    layerRows.push(Object.assign({}, p, {abIndex:b.index, abBase:b.is_underbase,
                                         wpct: 100*(b.w||maxW)/maxW}))));
  const key = p => p.abIndex + '|' + p.ink;
  const fallbacks = shown.reduce((n,b)=>n+(b.raster_fallbacks||0),0);

  document.getElementById('detail').innerHTML = `
    <div class="banner" data-v="${rec.verdict}">
      <div>
        <div class="verdict">${words[rec.verdict]}</div>
        <div class="fn" style="margin-top:4px;font-size:14px">${esc(rec.filename)}</div>
        <div class="tally">
          <span><b>${c.fail||0}</b> failed</span>
          <span><b>${c.flag||0}</b> flagged</span>
          <span><b>${c.pass||0}</b> passed</span>
          <span><b>${c.info||0}</b> noted</span>
        </div>
      </div>
      <div class="bmeta">${esc(rec.inspected_at.replace('T',' '))}<br>
        sha ${esc(rec.sha256_16)}<br>${(rec.bytes/1024).toFixed(0)} KB${
        rec.rules_version ? '<br>rules '+esc(rec.rules_version) : ''}</div>
      ${comp.complete === false
        ? `<div class="gap"><b>Not fully checked.</b>
             <span>${comp.cannot_evaluate||0} check(s) could not be completed on this
             file${comp.errors ? ' and '+comp.errors+' failed to run' : ''}. The verdict
             above covers what was checked — it is not a statement about what was not.</span></div>`
        : ''}
      ${comp.not_implemented
        ? `<div class="gap" style="background:var(--info-bg);color:var(--ink-2);border-color:var(--line)">
             <b>${comp.not_implemented} rule(s) not built yet.</b>
             <span>They are in the rule table but nothing evaluates them.</span></div>`
        : ''}
      ${(rec.previews||[]).some(p => (p.choke_failed||[]).length)
        ? `<div class="gap"><b>Plates shown without their choke.</b>
             <span>The choke mask could not be built for this file, so the plates
             below are drawn at full un-choked size. Do not judge trap from these
             previews — the numeric checks above are unaffected.</span></div>`
        : ''}
    </div>

    <section class="blk">
      <div class="blkhead"><h2 style="font-size:15px">Plates</h2>
        <span class="lbl">${pv.length} artboard${pv.length===1?'':'s'}</span></div>
      <div class="plate">
        <div class="ptools">
          <button class="tab" data-ab="-1" aria-pressed="${ab===-1}">All stacked</button>
          ${pv.map((p,i)=>`<button class="tab" data-ab="${i}" aria-pressed="${i===ab}">Artboard ${p.index}${p.is_underbase?' · base':''}</button>`).join('')}
          <span class="zoom"><span class="lbl">Colour</span>
            <input id="op" type="range" min="10" max="100" step="5" value="${colourPct}"
              title="Fade the colour plates to read the base through them">
            <span class="num" id="opv">${colourPct}%</span></span>
          <span class="zoom" style="margin-left:0"><span class="lbl">Base</span>
            <input id="bop" type="range" min="10" max="100" step="5" value="${basePct}"
              title="Fade the underbase independently">
            <span class="num" id="bopv">${basePct}%</span></span>
          <span class="zoom"><span class="lbl">Zoom</span>
            <input id="z" type="range" min="100" max="1600" step="25" value="${zoomPct}">
            <span class="num" id="zv">${zoomPct}%</span></span>
        </div>
        <div class="swatches">
          ${layerRows.length ? layerRows.map((p,i)=>{
              const first = i===0 || layerRows[i-1].abIndex!==p.abIndex;
              const tag = (ab===-1 && first)
                ? (i?'<span class="swsep"></span>':'') +
                  `<span class="abtag${p.abBase?' base':''}">AB${p.abIndex}${p.abBase?' base':''}</span>`
                : '';
              return tag + `<button class="sw" data-key="${esc(key(p))}"
                aria-pressed="${hidden.has(key(p))?'false':'true'}">
                <i style="background:${esc(p.colour||'#888888')}"></i>${esc(p.ink)}</button>`;
            }).join('')
            : '<span class="lbl">no separations rendered</span>'}
        </div>
        <div class="stage" id="stage">
          <div class="canvas" id="canvas" data-w="${maxW}">
            ${layerRows.map(p=>`<img src="${esc(p.src)}" alt="${esc(p.ink)} plate"
                 class="${p.kind==='png'?'px':'vec'}" data-key="${esc(key(p))}"
                 data-base="${p.abBase?'1':'0'}"
                 style="width:${p.wpct}%;opacity:${(p.abBase?basePct:colourPct)/100};${hidden.has(key(p))?'display:none':''}">`).join('')}
          </div>
        </div>
        <div class="vecnote">${ab===-1
          ? 'All artboards stacked in print order — underbase underneath. Fade the colour to read the trap: base pulled inside the colour edge is a choke, colour sitting proud of the base is a spread. '
          : 'Vector plates, in each ink&rsquo;s true colour. '}${shown.some(b=>b.choked)
          ? 'Zero-ink knockout strokes are carved out, so the plates match what the RIP burns. '
          : ''}${fallbacks
          ? fallbacks + ' plate(s) too dense for vector — shown at 600 dpi, so they soften at high zoom.'
          : 'Sharp at any zoom.'}</div>
      </div>
    </section>

    <section class="blk">
      <div class="blkhead"><h2 style="font-size:15px">Needs attention</h2>
        <span class="lbl">${attention.length} of ${rec.results.length} rules</span></div>
      ${attention.length
        ? `<div class="rules">${attention.map(ruleHTML).join('')}</div>`
        : `<div class="rules"><div class="rule"><div class="st pass">clear</div>
           <div class="rbody"><div class="rhead">Every rule that applies to this file passed.</div>
           </div></div></div>`}
    </section>

    ${unver.length ? `
    <section class="blk">
      <div class="blkhead"><h2 style="font-size:15px">Could not be verified</h2>
        <span class="lbl">${unver.length} rule${unver.length===1?'':'s'}</span></div>
      <div class="rules">${unver.map(ruleHTML).join('')}</div>
    </section>` : ''}

    <details class="fold"><summary>Passed — ${passed.length}</summary>
      <div class="rules">${passed.map(ruleHTML).join('')}</div></details>
    <details class="fold"><summary>Reported, not judged — ${noted.length}</summary>
      <div class="rules">${noted.map(ruleHTML).join('')}</div></details>
    <details class="fold"><summary>Does not apply to this file — ${na.length}</summary>
      <div class="rules">${na.map(ruleHTML).join('')}</div></details>
    <details class="fold"><summary>Not built yet — ${nyb.length}</summary>
      <div class="rules">${nyb.map(ruleHTML).join('')}</div></details>

    <div class="foot">Verdicts are the rule engine's alone — no human judgement is
      folded into this panel. A yellow means the rule cannot decide from the file
      and wants a person to look. <b>Could not be verified</b> is not a pass: those
      checks did not happen.</div>`;

  document.querySelectorAll('.tab').forEach(b => b.onclick = () => {
    ab = +b.dataset.ab; render();
  });
  document.querySelectorAll('.sw').forEach(b => b.onclick = () => {
    const k = b.dataset.key;
    hidden.has(k) ? hidden.delete(k) : hidden.add(k);
    b.setAttribute('aria-pressed', hidden.has(k) ? 'false' : 'true');
    document.querySelectorAll('.canvas img').forEach(im => {
      if (im.dataset.key === k) im.style.display = hidden.has(k) ? 'none' : '';
    });
  });
  focusOnArt(shown);
  fit();
  // images decode asynchronously, so the canvas has no height on first paint
  const firstImg = document.querySelector('.canvas img');
  if (firstImg) {
    if (firstImg.complete) { fit(); applyFocus(); }
    else firstImg.addEventListener('load', () => { fit(); applyFocus(); }, {once:true});
  }
  const z = document.getElementById('z');
  if (z) z.oninput = () => {
    captureFocus();                 // hold whatever is in the middle right now
    zoomPct = +z.value;
    document.getElementById('zv').textContent = zoomPct + '%';
    fit(); applyFocus();
  };

  // Fading the colour plates reads the base through them: where the base was
  // choked you see it pull inside the colour edge, where the colour was spread
  // you see it sit proud of the base. The rules measure it; this shows it.
  const paint = () => document.querySelectorAll('.canvas img').forEach(im => {
    im.style.opacity = (im.dataset.base === '1' ? basePct : colourPct) / 100;
  });
  const op = document.getElementById('op');
  if (op) op.oninput = () => {
    colourPct = +op.value;
    document.getElementById('opv').textContent = colourPct + '%'; paint();
  };
  const bop = document.getElementById('bop');
  if (bop) bop.oninput = () => {
    basePct = +bop.value;
    document.getElementById('bopv').textContent = basePct + '%'; paint();
  };
}

// Open at fit-to-width; the slider then scales up from there, and the canvas
// keeps a real width so the stage scrolls instead of clipping.
function fit(){
  const stage = document.getElementById('stage');
  const canvas = document.getElementById('canvas');
  if (!stage || !canvas) return;
  const natW = +canvas.dataset.w || 0;
  if (!natW) return;
  canvas.style.width = Math.round(stage.clientWidth * zoomPct / 100) + 'px';
}

// Zooming holds the middle of the view still. The artboard is 16in wide and the
// art often sits off to one side, so zooming about the board's centre lands in
// empty space and makes you go looking for the design.
function captureFocus(){
  const stage = document.getElementById('stage');
  const canvas = document.getElementById('canvas');
  if (!stage || !canvas) return;
  const w = canvas.offsetWidth, h = canvas.offsetHeight;
  if (!w || !h) return;
  // Only an axis that can actually scroll carries the viewer's intent. At
  // fit-to-width nothing scrolls, so the "centre" is just the middle of the
  // board - reading it would throw away the art focus before the first zoom.
  const next = focus ? {fx: focus.fx, fy: focus.fy} : {fx: 0.5, fy: 0.5};
  if (w > stage.clientWidth + 1)
    next.fx = (stage.scrollLeft + stage.clientWidth / 2) / w;
  if (h > stage.clientHeight + 1)
    next.fy = (stage.scrollTop + stage.clientHeight / 2) / h;
  focus = next;
}

function applyFocus(){
  const stage = document.getElementById('stage');
  const canvas = document.getElementById('canvas');
  if (!stage || !canvas || !focus) return;
  const w = canvas.offsetWidth, h = canvas.offsetHeight;
  if (!w || !h) return;
  stage.scrollLeft = Math.max(0, focus.fx * w - stage.clientWidth / 2);
  stage.scrollTop  = Math.max(0, focus.fy * h - stage.clientHeight / 2);
}

// On opening a file, centre on the artwork rather than the board.
function focusOnArt(boards){
  const bb = [1e9, 1e9, -1e9, -1e9];
  let bw = 0, bh = 0;
  boards.forEach(b => {
    if (!b.art) return;
    bw = Math.max(bw, b.w || 0); bh = Math.max(bh, b.h || 0);
    bb[0] = Math.min(bb[0], b.art[0]); bb[1] = Math.min(bb[1], b.art[1]);
    bb[2] = Math.max(bb[2], b.art[2]); bb[3] = Math.max(bb[3], b.art[3]);
  });
  focus = (bb[2] > -1e8 && bw && bh)
    ? {fx: ((bb[0] + bb[2]) / 2) / bw, fy: ((bb[1] + bb[3]) / 2) / bh}
    : {fx: 0.5, fy: 0.5};
}
window.addEventListener('resize', () => { fit(); applyFocus(); });

document.querySelectorAll('.qitem').forEach((el,i) => el.onclick = () => {
  cur = i; ab = -1; hidden.clear(); focus = null; render();
  if (window.innerWidth <= 860) document.getElementById('detail')
    .scrollIntoView({behavior:'smooth', block:'start'});
});
render();
"""


def build():
    recs = []
    # queue/archive/ holds results kept for re-running rules against the
    # validation corpus; they are deliberately not shown in the viewer.
    for p in sorted(glob.glob(os.path.join(QUEUE, "*.json"))):
        with open(p) as fh:
            recs.append(json.load(fh))
    recs.sort(key=lambda r: r["inspected_at"], reverse=True)

    slim = []
    for r in recs:
        slim.append({
            "filename": r["filename"], "verdict": r["verdict"],
            "inspected_at": r["inspected_at"], "sha256_16": r["sha256_16"],
            "bytes": r["bytes"], "previews": r["previews"],
            "completeness": r.get("completeness", {}),
            "rules_version": r.get("rules_version", ""),
            "engine_version": r.get("engine_version", ""),
            "results": [{k: x[k] for k in
                         ("code", "name", "status", "headline", "detail", "remediation")}
                        for x in r["results"]],
        })

    tot = {"fail": 0, "flag": 0, "pass": 0}
    for r in recs:
        tot[r["verdict"]] = tot.get(r["verdict"], 0) + 1

    rail = []
    for r in recs:
        c = {}
        for x in r["results"]:
            c[x["status"]] = c.get(x["status"], 0) + 1
        rail.append(
            f'<button class="qitem" data-v="{r["verdict"]}">'
            f'<span class="stripe"></span><span class="body">'
            f'<span class="fn">{html.escape(r["filename"])}</span>'
            f'<span class="qmeta"><span class="num">{c.get("fail",0)}F</span>'
            f'<span class="num">{c.get("flag",0)}Y</span>'
            f'<span class="num">{c.get("pass",0)}P</span>'
            f'<span style="margin-left:auto">{html.escape(r["inspected_at"][11:16])}</span>'
            f'</span></span></button>')

    page = f"""<title>PrintScope</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@600;700&family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<style>{CSS}</style>

<header class="top">
  <span class="brand"><span class="dot"></span>PrintScope</span>
  <span class="lbl">separation inspection · Mint Printworks</span>
  <span class="legend">
    <span class="key"><i style="background:var(--fail)"></i>send it back</span>
    <span class="key"><i style="background:var(--flag)"></i>look at it</span>
    <span class="key"><i style="background:var(--pass)"></i>clear to run</span>
  </span>
</header>

<div class="wrap">
  <aside>
    <div class="railhead"><h1 style="font-size:13px">Inspected</h1>
      <span class="lbl">{len(recs)} files · {tot.get('fail',0)} failed · {tot.get('flag',0)} flagged</span>
    </div>
    <div class="qlist">{''.join(rail)}</div>
  </aside>
  <main id="detail"></main>
</div>

<script>window.__PS__ = {json.dumps(slim)};</script>
<script>{JS}</script>
"""
    os.makedirs(SITE, exist_ok=True)
    out = os.path.join(SITE, "index.html")
    with open(out, "w") as fh:
        fh.write(page)
    return out, len(recs), len(page)


if __name__ == "__main__":
    out, n, size = build()
    print(f"{out}  {n} files  {size/1024:.0f} KB")
