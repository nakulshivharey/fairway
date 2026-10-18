'use strict';
// ---------- Estado ----------
const KEY = 'fairway.v1';
const DEFAULT_BAG = [['Driver',230],['Madera 3',210],['Híbrido',185],['Hierro 5',165],['Hierro 6',155],['Hierro 7',145],['Hierro 8',135],['Hierro 9',125],['PW',110],['SW',90],['LW',70]]
  .map(([name, dist]) => ({ name, dist }));
let db = load();
function load() {
  try { const d = JSON.parse(localStorage.getItem(KEY)); if (d) return d; } catch (e) {}
  return { courses: [], rounds: [], bag: DEFAULT_BAG, active: null };
}
const save = () => localStorage.setItem(KEY, JSON.stringify(db));
const uid = () => Math.random().toString(36).slice(2, 10);
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- Geo ----------
let pos = null, watchId = null;
function startGPS() {
  if (watchId != null || !navigator.geolocation) return;
  watchId = navigator.geolocation.watchPosition(p => { pos = [p.coords.latitude, p.coords.longitude]; onPos(); },
    () => {}, { enableHighAccuracy: true, maximumAge: 2000 });
}
function meters(a, b) {
  const R = 6371000, r = Math.PI / 180, dLat = (b[0] - a[0]) * r, dLon = (b[1] - a[1]) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const yd = m => Math.round(m * 1.09361);
function suggestClub(dy) {
  const sorted = [...db.bag].sort((a, b) => a.dist - b.dist);
  return sorted.find(c => c.dist >= dy) || sorted[sorted.length - 1];
}

// ---------- Mapa ----------
let map = null, mapLayers = null;
function mkMap(el, center, zoom = 17) {
  if (map) { map.remove(); map = null; }
  map = L.map(el, { zoomControl: false, attributionControl: false }).setView(center, zoom);
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19 }).addTo(map);
  mapLayers = L.layerGroup().addTo(map);
  return map;
}
const dot = (c, t) => L.divIcon({ className: '', iconSize: [26, 26], iconAnchor: [13, 13],
  html: `<div style="background:${c};color:#fff;border-radius:50%;width:26px;height:26px;display:flex;align-items:center;justify-content:center;font-weight:700;border:2px solid #fff">${t}</div>` });

// ---------- Navegación ----------
let tab = 'round', onPos = () => {};
document.querySelectorAll('#tabs button').forEach(b => b.onclick = () => go(b.dataset.tab));
function go(t) {
  tab = t; onPos = () => {};
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
  if (map) { map.remove(); map = null; }
  ({ round: viewRound, courses: viewCourses, stats: viewStats, bag: viewBag })[t]();
}
const view = html => { $('#view').innerHTML = html; return $('#view'); };

// ---------- Ronda ----------
function viewRound() {
  const r = db.active;
  if (r) return viewHole();
  const v = view(`<h1>Nueva ronda</h1>
    ${db.courses.length ? '' : '<div class="card">Aún no tienes campos. Crea o importa uno en la pestaña <b>Campos</b>.</div>'}
    ${db.courses.map(c => `<div class="card row sb"><div><b>${esc(c.name)}</b><div class="mut">${c.holes.length} hoyos · par ${c.holes.reduce((a, h) => a + h.par, 0)}</div></div>
      <button class="p" data-play="${c.id}">Jugar</button></div>`).join('')}`);
  const box = document.createElement('div'); v.prepend(box); autoDetect(box);
  v.querySelectorAll('[data-play]').forEach(b => b.onclick = () => {
    const c = db.courses.find(c => c.id === b.dataset.play);
    db.active = { id: uid(), courseId: c.id, date: new Date().toISOString(), hole: 0,
      scores: c.holes.map(() => ({ strokes: 0, putts: 0, fairway: null })) };
    save(); viewHole();
  });
}

function viewHole() {
  const r = db.active, c = db.courses.find(c => c.id === r.courseId);
  if (!c) { db.active = null; save(); return viewRound(); }
  const h = c.holes[r.hole], s = r.scores[r.hole];
  startGPS();
  const total = r.scores.reduce((a, x) => a + x.strokes, 0);
  const parPlayed = c.holes.reduce((a, x, i) => a + (r.scores[i].strokes ? x.par : 0), 0);
  const v = view(`
    <div class="row sb"><h1>Hoyo ${r.hole + 1} <span class="mut">Par ${h.par}</span></h1>
      <div class="mut">${total ? total + ' (' + fmtDiff(total - parPlayed) + ')' : ''}</div></div>
    <div id="map"></div>
    <div class="dist"><div><span class="mut">Delante</span><b id="dF">–</b></div><div class="c"><span class="mut">Centro</span><b id="dC">–</b></div><div><span class="mut">Fondo</span><b id="dB">–</b></div></div>
    <div class="mut" id="club" style="margin:6px 0 12px;text-align:center"></div>
    <div class="card"><div class="mut">Golpes</div><div class="stepper"><button data-k="strokes" data-d="-1">−</button><div class="v" id="vS">${s.strokes || '–'}</div><button data-k="strokes" data-d="1">+</button></div></div>
    <div class="card"><div class="mut">Putts</div><div class="stepper"><button data-k="putts" data-d="-1">−</button><div class="v" id="vP">${s.putts}</div><button data-k="putts" data-d="1">+</button></div></div>
    ${h.par > 3 ? `<div class="card row"><span class="grow">Calle</span>
      ${[['L', 'left'], ['✓', 'hit'], ['R', 'right']].map(([t, k]) => `<button class="chip ${s.fairway === k ? 'on' : ''}" data-fw="${k}">${t}</button>`).join('')}</div>` : ''}
    <div class="row"><button class="s grow" id="prev" ${r.hole ? '' : 'disabled'}>← Anterior</button>
      ${r.hole < c.holes.length - 1 ? '<button class="p grow" id="next">Siguiente →</button>' : '<button class="p grow" id="fin">Terminar</button>'}</div>
    <div class="row" style="margin-top:12px"><button class="d" id="card">Ver tarjeta</button><span class="grow"></span><button class="d" id="abort">Descartar ronda</button></div>`);

  mkMap('map', h.green, 17);
  L.marker(h.tee, { icon: dot('#2a7de1', 'T') }).addTo(map);
  L.marker(h.green, { icon: dot('#e8503a', 'G') }).addTo(map);
  L.polyline([h.tee, h.green], { color: '#fff', weight: 2, dashArray: '6 6' }).addTo(map);
  map.fitBounds([h.tee, h.green], { padding: [30, 30] });
  const me = L.circleMarker([0, 0], { radius: 7, color: '#fff', fillColor: '#2a7de1', fillOpacity: 1 });
  onPos = () => {
    if (!pos) return;
    me.setLatLng(pos).addTo(map);
    const d = meters(pos, h.green), half = (h.depth || 20) / 2;
    $('#dC').textContent = yd(d);
    $('#dF').textContent = yd(Math.max(0, d - half));
    $('#dB').textContent = yd(d + half);
    const k = suggestClub(yd(d));
    $('#club').textContent = k ? `Sugerido: ${k.name} (${k.dist} yd)` : '';
  };
  onPos();
  if (!pos) $('#club').textContent = 'Esperando GPS…';

  v.querySelectorAll('[data-d]').forEach(b => b.onclick = () => {
    const k = b.dataset.k; s[k] = Math.max(0, s[k] + +b.dataset.d);
    if (k === 'putts' && s.putts > s.strokes) s.strokes = s.putts;
    if (k === 'strokes' && s.strokes === 1 && b.dataset.d === '1') s.strokes = h.par; // primer toque = par
    save(); $('#vS').textContent = s.strokes || '–'; $('#vP').textContent = s.putts;
  });
  v.querySelectorAll('[data-fw]').forEach(b => b.onclick = () => { s.fairway = s.fairway === b.dataset.fw ? null : b.dataset.fw; save(); viewHole(); });
  const nav = d => { r.hole += d; save(); viewHole(); };
  $('#prev').onclick = () => nav(-1);
  if ($('#next')) $('#next').onclick = () => nav(1);
  if ($('#fin')) $('#fin').onclick = () => {
    if (!confirm('¿Terminar y guardar la ronda?')) return;
    db.rounds.unshift({ id: r.id, courseId: c.id, courseName: c.name, date: r.date,
      holes: c.holes.map((x, i) => ({ par: x.par, ...r.scores[i] })) });
    db.active = null; save(); go('stats');
  };
  $('#abort').onclick = () => { if (confirm('¿Descartar la ronda en curso?')) { db.active = null; save(); viewRound(); } };
  $('#card').onclick = () => alert(c.holes.map((x, i) => `${i + 1}: par ${x.par} → ${r.scores[i].strokes || '-'}`).join('\n'));
}
const fmtDiff = d => d === 0 ? 'E' : d > 0 ? '+' + d : String(d);

// ---------- Campos ----------
function viewCourses() {
  const v = view(`<h1>Campos</h1>
    <div class="row"><button class="p grow" id="imp">📍 Buscar campos (50 km)</button><button class="s" id="new">＋ Manual</button></div>
    <div id="res"></div>
    ${db.courses.map(c => `<div class="card row sb"><div><b>${esc(c.name)}</b><div class="mut">${c.holes.length} hoyos</div></div>
      <div><button class="s" data-e="${c.id}">Editar</button> <button class="d" data-x="${c.id}">✕</button></div></div>`).join('')}`);
  v.querySelectorAll('[data-e]').forEach(b => b.onclick = () => editCourse(b.dataset.e));
  v.querySelectorAll('[data-x]').forEach(b => b.onclick = () => { if (confirm('¿Borrar campo?')) { db.courses = db.courses.filter(c => c.id !== b.dataset.x); save(); viewCourses(); } });
  $('#new').onclick = () => {
    const name = prompt('Nombre del campo'); if (!name) return;
    const n = confirm('¿18 hoyos? (Cancelar = 9)') ? 18 : 9;
    const c = { id: uid(), name, holes: Array.from({ length: n }, () => ({ par: 4, tee: null, green: null })) };
    db.courses.push(c); save(); editCourse(c.id);
  };
  $('#imp').onclick = importNearby;
}

const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter'];
// Los servidores públicos de Overpass se saturan a menudo: probamos varios y reintentamos.
async function overpass(q) {
  for (let round = 0; round < 2; round++) {
    for (const url of OVERPASS) {
      const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 25000);
      try {
        const r = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(q),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: ctl.signal });
        if (!r.ok) continue;
        const j = await r.json();
        if (j && j.elements) return j.elements;
      } catch (e) { /* siguiente servidor */ } finally { clearTimeout(t); }
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error('Los servidores de OpenStreetMap están saturados. Inténtalo de nuevo en unos minutos.');
}
function importNearby() {
  const res = $('#res'); res.innerHTML = '<div class="card">Buscando tu posición…</div>';
  navigator.geolocation.getCurrentPosition(async p => {
    try {
      res.innerHTML = '<div class="card">Buscando campos…</div>';
      const els = await overpass(`[out:json][timeout:25];nwr["leisure"="golf_course"](around:50000,${p.coords.latitude},${p.coords.longitude});out tags bb center;`);
      const here = [p.coords.latitude, p.coords.longitude];
      const list = els.filter(e => e.bounds && e.tags && e.tags.name).map(e => {
        const c = e.center || { lat: (e.bounds.minlat + e.bounds.maxlat) / 2, lon: (e.bounds.minlon + e.bounds.maxlon) / 2 };
        return Object.assign(e, { km: meters(here, [c.lat, c.lon]) / 1000 });
      }).sort((a, b) => a.km - b.km);
      res.innerHTML = list.length ? list.map((e, i) => `<div class="card row sb"><div><b>${esc(e.tags.name)}</b><div class="mut">${e.km.toFixed(1)} km</div></div><button class="p" data-i="${i}">Importar</button></div>`).join('')
        : '<div class="card">No se encontraron campos con nombre. Usa «Manual».</div>';
      res.querySelectorAll('[data-i]').forEach(b => b.onclick = async () => {
        const e = list[+b.dataset.i], bb = e.bounds;
        b.textContent = '…';
        try { await importCourse(e.tags.name, bb, e.type + e.id); } catch (err) { alert('Error: ' + err.message); b.textContent = 'Importar'; }
      });
    } catch (err) { res.innerHTML = `<div class="card">Error: ${esc(err.message)}</div>`; }
  }, err => { res.innerHTML = `<div class="card">Sin ubicación: ${esc(err.message)}</div>`; }, { enableHighAccuracy: true });
}
async function importCourse(name, bb, osmId, silent) {
  const els = await overpass(`[out:json][timeout:25];way["golf"="hole"](${bb.minlat},${bb.minlon},${bb.maxlat},${bb.maxlon});out geom tags;`);
  const holes = els.filter(w => w.geometry && w.geometry.length > 1 && w.tags && w.tags.ref)
    .sort((a, b) => parseInt(a.tags.ref) - parseInt(b.tags.ref));
  if (!holes.length && silent) return null;
  if (!holes.length) { alert('OpenStreetMap no tiene los hoyos de este campo. Se creará vacío para que lo marques a mano.'); }
  const mk = w => { const g = w.geometry, t = g[0], e = g[g.length - 1];
    return { par: parseInt(w.tags.par) || 4, tee: [t.lat, t.lon], green: [e.lat, e.lon] }; };
  const c = { id: uid(), osmId, name, holes: holes.length ? holes.map(mk) : Array.from({ length: 18 }, () => ({ par: 4, tee: null, green: null })) };
  db.courses.push(c); save();
  if (!silent) editCourse(c.id);
  return c;
}

// Detecta el campo donde estás y lo descarga solo (una vez por campo)
async function autoDetect(box) {
  if (!navigator.geolocation || !navigator.onLine) return;
  const say = t => { box.innerHTML = t ? `<div class="card mut">${t}</div>` : ''; };
  navigator.geolocation.getCurrentPosition(async p => {
    try {
      say('Buscando campo en tu ubicación…');
      const els = await overpass(`[out:json][timeout:25];nwr["leisure"="golf_course"](around:300,${p.coords.latitude},${p.coords.longitude});out tags bb;`);
      const e = els.find(e => e.bounds && e.tags && e.tags.name && !db.courses.some(c => c.osmId === e.type + e.id));
      if (!e) return say('');
      say(`Descargando ${esc(e.tags.name)}…`);
      const c = await importCourse(e.tags.name, e.bounds, e.type + e.id, true);
      if (c && tab === 'round' && !db.active) viewRound(); else say('');
    } catch (err) { say(''); }
  }, () => say(''), { enableHighAccuracy: false, timeout: 8000, maximumAge: 60000 });
}

function editCourse(id) {
  const c = db.courses.find(c => c.id === id); let i = 0, mode = 'tee';
  const draw = () => {
    const h = c.holes[i];
    const v = view(`<div class="row sb"><h1>${esc(c.name)}</h1><button class="s" id="done">Listo</button></div>
      <div class="row" style="overflow:auto;margin-bottom:8px">${c.holes.map((x, k) => `<button class="chip ${k === i ? 'on' : ''}" data-h="${k}">${k + 1}${x.tee && x.green ? '' : '•'}</button>`).join('')}</div>
      <div class="row" style="margin-bottom:8px"><label class="grow">Par<select id="par">${[3, 4, 5, 6].map(p => `<option ${p === h.par ? 'selected' : ''}>${p}</option>`).join('')}</select></label>
        <button class="chip ${mode === 'tee' ? 'on' : ''}" data-m="tee">Marcar salida</button><button class="chip ${mode === 'green' ? 'on' : ''}" data-m="green">Marcar green</button></div>
      <div id="map"></div><div class="mut">Toca el mapa para colocar ${mode === 'tee' ? 'la salida' : 'el centro del green'}. Mantén tu posición con 📍.</div>
      <button class="s" id="here" style="margin-top:8px">📍 Usar mi posición</button>`);
    const center = h.green || h.tee || pos || c.holes.find(x => x.tee)?.tee || [40.4, -3.7];
    mkMap('map', center, h.tee ? 17 : 16);
    const refresh = () => {
      mapLayers.clearLayers();
      if (h.tee) L.marker(h.tee, { icon: dot('#2a7de1', 'T') }).addTo(mapLayers);
      if (h.green) L.marker(h.green, { icon: dot('#e8503a', 'G') }).addTo(mapLayers);
    };
    refresh();
    const place = ll => { h[mode] = ll; if (mode === 'tee' && !h.green) mode = 'green'; save(); refresh(); draw2(); };
    const draw2 = () => v.querySelectorAll('[data-m]').forEach(b => b.classList.toggle('on', b.dataset.m === mode));
    map.on('click', e => place([e.latlng.lat, e.latlng.lng]));
    v.querySelectorAll('[data-h]').forEach(b => b.onclick = () => { i = +b.dataset.h; mode = 'tee'; draw(); });
    v.querySelectorAll('[data-m]').forEach(b => b.onclick = () => { mode = b.dataset.m; draw2(); });
    $('#par').onchange = e => { h.par = +e.target.value; save(); };
    $('#here').onclick = () => { startGPS(); if (!pos) return alert('Aún sin GPS'); place(pos); map.setView(pos, 18); };
    $('#done').onclick = () => viewCourses();
  };
  draw();
}

// ---------- Stats ----------
function viewStats() {
  const R = db.rounds, n = R.length;
  const sc = r => r.holes.reduce((a, h) => a + h.strokes, 0), pr = r => r.holes.reduce((a, h) => a + h.par, 0);
  const avg = a => a.length ? (a.reduce((x, y) => x + y, 0) / a.length) : 0;
  const allH = R.flatMap(r => r.holes.filter(h => h.strokes));
  const fw = allH.filter(h => h.par > 3 && h.fairway), gir = allH.filter(h => h.putts > 0);
  const firPct = fw.length ? Math.round(100 * fw.filter(h => h.fairway === 'hit').length / fw.length) : null;
  const girPct = gir.length ? Math.round(100 * gir.filter(h => h.strokes - h.putts <= h.par - 2).length / gir.length) : null;
  const cnt = k => allH.filter(h => (h.strokes - h.par) <= k).length;
  const v = view(`<h1>Estadísticas</h1>
    ${n ? `<div class="grid">
      <div class="card"><span class="mut">Rondas</span><b>${n}</b></div>
      <div class="card"><span class="mut">Media</span><b>${avg(R.map(sc)).toFixed(1)}</b></div>
      <div class="card"><span class="mut">Mejor</span><b>${Math.min(...R.map(sc))}</b></div>
      <div class="card"><span class="mut">Putts/ronda</span><b>${avg(R.map(r => r.holes.reduce((a, h) => a + h.putts, 0))).toFixed(1)}</b></div>
      <div class="card"><span class="mut">Calles</span><b>${firPct ?? '–'}${firPct != null ? '%' : ''}</b></div>
      <div class="card"><span class="mut">Greens en regl.</span><b>${girPct ?? '–'}${girPct != null ? '%' : ''}</b></div>
      <div class="card"><span class="mut">Birdies o mejor</span><b>${cnt(-1)}</b></div>
      <div class="card"><span class="mut">Pares o mejor</span><b>${cnt(0)}</b></div></div>
    <h2>Evolución (vs par)</h2><div class="card">${chart([...R].reverse().map(r => sc(r) - pr(r)))}</div>
    <h2>Historial</h2>
    ${R.map(r => `<div class="card row sb"><div><b>${esc(r.courseName)}</b><div class="mut">${new Date(r.date).toLocaleDateString()}</div></div>
      <div><b style="font-size:1.3rem">${sc(r)}</b> <span class="mut">${fmtDiff(sc(r) - pr(r))}</span> <button class="s" data-v="${r.id}">Ver</button> <button class="d" data-x="${r.id}">✕</button></div></div>`).join('')}`
      : '<div class="card">Todavía no has guardado rondas.</div>'}
    <div class="row" style="margin-top:12px"><button class="s" id="exp">Exportar copia</button><button class="s" id="imp">Importar copia</button></div>`);
  v.querySelectorAll('[data-x]').forEach(b => b.onclick = () => { if (confirm('¿Borrar ronda?')) { db.rounds = db.rounds.filter(r => r.id !== b.dataset.x); save(); viewStats(); } });
  v.querySelectorAll('[data-v]').forEach(b => b.onclick = () => showRound(R.find(r => r.id === b.dataset.v)));
  $('#exp').onclick = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(db)], { type: 'application/json' })); a.download = 'fairway-backup.json'; a.click(); };
  $('#imp').onclick = () => { const f = document.createElement('input'); f.type = 'file'; f.accept = 'application/json';
    f.onchange = async () => { try { const d = JSON.parse(await f.files[0].text()); if (!d.courses || !d.rounds) throw 0; db = d; save(); go('stats'); } catch (e) { alert('Archivo no válido'); } }; f.click(); };
}
function showRound(r) {
  const cls = d => d <= -2 ? 'eagle' : d === -1 ? 'birdie' : d > 0 ? 'bogey' : '';
  const v = view(`<div class="row sb"><h1>${esc(r.courseName)}</h1><button class="s" id="back">←</button></div>
    <div class="card"><table><tr><th>Hoyo</th><th>Par</th><th>Golpes</th><th>Putts</th><th>Calle</th></tr>
    ${r.holes.map((h, i) => `<tr><td>${i + 1}</td><td>${h.par}</td><td class="${cls(h.strokes - h.par)}">${h.strokes || '-'}</td><td>${h.putts}</td><td>${h.par > 3 ? ({ hit: '✓', left: 'L', right: 'R' }[h.fairway] || '-') : ''}</td></tr>`).join('')}</table></div>`);
  $('#back').onclick = viewStats;
}
function chart(vals) {
  if (vals.length < 2) return '<div class="mut">Necesitas al menos 2 rondas.</div>';
  const W = 300, H = 120, mx = Math.max(...vals, 1), mn = Math.min(...vals, 0), rg = mx - mn || 1;
  const pts = vals.map((y, i) => [10 + i * (W - 20) / (vals.length - 1), H - 10 - (y - mn) / rg * (H - 20)]);
  const zero = H - 10 - (0 - mn) / rg * (H - 20);
  return `<svg viewBox="0 0 ${W} ${H}" width="100%"><line x1="0" x2="${W}" y1="${zero}" y2="${zero}" stroke="currentColor" opacity=".2"/>
    <polyline fill="none" stroke="#2e9e5b" stroke-width="2.5" points="${pts.map(p => p.join(',')).join(' ')}"/>
    ${pts.map(p => `<circle cx="${p[0]}" cy="${p[1]}" r="3.5" fill="#2e9e5b"/>`).join('')}</svg>`;
}

// ---------- Bolsa ----------
function viewBag() {
  const v = view(`<h1>Mi bolsa</h1><div class="mut" style="margin-bottom:8px">Distancia media en yardas. Se usa para sugerir palo.</div>
    ${db.bag.map((c, i) => `<div class="card row"><input class="grow" value="${esc(c.name)}" data-n="${i}"><input style="width:90px" type="number" inputmode="numeric" value="${c.dist}" data-d="${i}"><button class="d" data-x="${i}">✕</button></div>`).join('')}
    <button class="s" id="add">＋ Añadir palo</button>`);
  v.querySelectorAll('[data-n]').forEach(e => e.onchange = () => { db.bag[+e.dataset.n].name = e.value; save(); });
  v.querySelectorAll('[data-d]').forEach(e => e.onchange = () => { db.bag[+e.dataset.d].dist = +e.value || 0; save(); });
  v.querySelectorAll('[data-x]').forEach(b => b.onclick = () => { db.bag.splice(+b.dataset.x, 1); save(); viewBag(); });
  $('#add').onclick = () => { db.bag.push({ name: 'Nuevo', dist: 100 }); save(); viewBag(); };
}

// ---------- Arranque ----------
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
go('round');
