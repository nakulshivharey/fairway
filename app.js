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
    ${db.courses.map(c => `<div class="card row sb"><div><b>${esc(c.name)}</b><div class="mut">${c.holes.length} hoyos · par ${c.holes.reduce((a, h) => a + h.par, 0)}${courseHandicap(c) != null ? ' · HCP campo ' + courseHandicap(c) : ''}</div></div>
      <button class="p" data-play="${c.id}">Jugar</button></div>`).join('')}`);
  const box = document.createElement('div'); v.prepend(box); autoDetect(box);
  v.querySelectorAll('[data-play]').forEach(b => b.onclick = () => {
    const c = db.courses.find(c => c.id === b.dataset.play);
    db.active = { id: uid(), courseId: c.id, date: new Date().toISOString(), hole: 0,
      scores: c.holes.map(() => ({ strokes: 0, putts: 0, fairway: null })) };
    save(); viewHole();
  });
}

// ---------- Utilidades de ronda ----------
let wake = null;
async function keepAwake() {
  try { if ('wakeLock' in navigator && !wake) { wake = await navigator.wakeLock.request('screen'); wake.addEventListener('release', () => { wake = null; }); } } catch (e) {}
}
function releaseAwake() { try { wake && wake.release(); } catch (e) {} wake = null; }
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && db.active && tab === 'round') keepAwake(); });

async function elevations(pts) {
  const r = await fetch(`https://api.open-meteo.com/v1/elevation?latitude=${pts.map(p => p[0].toFixed(5)).join(',')}&longitude=${pts.map(p => p[1].toFixed(5)).join(',')}`);
  if (!r.ok) throw new Error('elevación');
  return (await r.json()).elevation;
}

// Distancia (m) de un punto a un segmento, aproximación plana válida a escala de un hoyo
function segDist(p, a, b) {
  const k = Math.cos(a[0] * Math.PI / 180), f = q => [q[1] * k * 111320, q[0] * 110540];
  const [px, py] = f(p), [ax, ay] = f(a), [bx, by] = f(b), dx = bx - ax, dy = by - ay, l = dx * dx + dy * dy;
  const t = l ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
const loadingHaz = new Set();
async function loadHazards(c) {
  const pts = c.holes.flatMap(h => [h.tee, h.green]).filter(Boolean);
  if (!pts.length) return;
  const pad = 0.003, s = Math.min(...pts.map(p => p[0])) - pad, n = Math.max(...pts.map(p => p[0])) + pad,
    w = Math.min(...pts.map(p => p[1])) - pad, e = Math.max(...pts.map(p => p[1])) + pad, bb = `(${s},${w},${n},${e})`;
  const els = await overpass(`[out:json][timeout:25];(nwr["golf"="bunker"]${bb};nwr["golf"="water_hazard"]${bb};nwr["golf"="lateral_water_hazard"]${bb};nwr["natural"="water"]${bb};);out geom tags;`);
  const out = [];
  for (const el of els) {
    const type = el.tags && el.tags.golf === 'bunker' ? 'bunker' : 'agua';
    const rings = el.geometry ? [el.geometry] : (el.members || []).filter(m => m.geometry && m.role !== 'inner').map(m => m.geometry);
    for (const g of rings) {
      if (g.length < 3) continue;
      const step = Math.ceil(g.length / 40);
      out.push({ type, pts: g.filter((_, i) => i % step === 0).map(q => [+q.lat.toFixed(6), +q.lon.toFixed(6)]) });
    }
  }
  c.hazards = out; save();
}
const holeHazards = (c, h) => (c.hazards || []).filter(z => z.pts.some(p => segDist(p, h.tee, h.green) < 50));

function learnBag(r) {
  for (const list of Object.values(r.shots || {})) {
    for (let i = 0; i < list.length - 1; i++) {
      const a = list[i], b = list[i + 1];
      if (a.club === 'Putter') continue;
      const d = yd(meters(a.ll, b.ll)), k = db.bag.find(x => x.name === a.club);
      if (!k || d < 20) continue;
      k.samples = [...(k.samples || []), d].slice(-20);
      if (k.samples.length >= 3) k.dist = Math.round(k.samples.reduce((x, y) => x + y, 0) / k.samples.length);
    }
  }
}

// ---------- Handicap (aproximación del sistema WHS) ----------
const WHS = { 3: [1, -2], 4: [1, -1], 5: [1, 0], 6: [2, -1], 7: [2, 0], 8: [2, 0], 9: [3, 0], 10: [3, 0], 11: [3, 0],
  12: [4, 0], 13: [4, 0], 14: [4, 0], 15: [5, 0], 16: [5, 0], 17: [6, 0], 18: [6, 0], 19: [7, 0], 20: [8, 0] };
function roundDiff(r) {
  const c = db.courses.find(c => c.id === r.courseId);
  const rating = r.rating ?? (c && c.rating), slope = r.slope ?? (c && c.slope);
  if (!rating || !slope || r.holes.length !== 18 || r.holes.some(h => !h.strokes)) return null;
  const ags = r.holes.reduce((a, h) => a + Math.min(h.strokes, h.par + 5), 0); // tope aprox. de doble bogey neto
  return Math.round(113 / slope * (ags - rating) * 10) / 10;
}
function handicapIndex() {
  const d = db.rounds.map(roundDiff).filter(x => x != null).slice(0, 20);
  if (d.length < 3) return { idx: null, count: d.length };
  const [n, adj] = WHS[d.length], best = [...d].sort((a, b) => a - b).slice(0, n);
  return { idx: Math.round((best.reduce((a, b) => a + b, 0) / n + adj) * 10) / 10, count: d.length };
}
function courseHandicap(c) {
  const { idx } = handicapIndex();
  if (idx == null || !c.rating || !c.slope) return null;
  return Math.round(idx * c.slope / 113 + (c.rating - c.holes.reduce((a, h) => a + h.par, 0)));
}

// ---------- Hoyo en juego ----------
function viewHole() {
  const r = db.active, c = db.courses.find(c => c.id === r.courseId);
  if (!c) { db.active = null; save(); return viewRound(); }
  const h = c.holes[r.hole], s = r.scores[r.hole];
  r.shots = r.shots || {};
  const shots = r.shots[r.hole] = r.shots[r.hole] || [];
  startGPS(); keepAwake();
  if (!h.tee || !h.green) {
    const v = view(`<h1>Hoyo ${r.hole + 1}</h1><div class="card">Este hoyo no tiene salida/green marcados.</div>
      <div class="row"><button class="s grow" id="ed">Editar campo</button><button class="s grow" id="skip">Siguiente hoyo →</button></div>
      <div class="row" style="margin-top:12px"><button class="d" id="abort">Descartar ronda</button></div>`);
    $('#ed').onclick = () => editCourse(c.id);
    $('#skip').onclick = () => { if (r.hole < c.holes.length - 1) { r.hole++; save(); viewHole(); } };
    $('#abort').onclick = () => { if (confirm('¿Descartar la ronda en curso?')) { db.active = null; save(); releaseAwake(); viewRound(); } };
    return;
  }
  const total = r.scores.reduce((a, x) => a + x.strokes, 0);
  const parPlayed = c.holes.reduce((a, x, i) => a + (r.scores[i].strokes ? x.par : 0), 0);
  const clubs = [...db.bag.map(k => k.name), 'Putter'];
  const v = view(`
    <div class="row sb"><h1>Hoyo ${r.hole + 1} <span class="mut">Par ${h.par}</span></h1>
      <div class="mut">${total ? total + ' (' + fmtDiff(total - parPlayed) + ')' : ''}</div></div>
    <div class="mapwrap">
      <div id="map"></div>
      <div class="ov bigd"><small>Centro (yd)</small><b id="dC">–</b><small><span id="dF">–</span> · <span id="dB">–</span></small></div>
      <div class="ov chipov" id="plays"></div>
      <div class="ov botbar"><select id="clubSel">${clubs.map(k => `<option>${esc(k)}</option>`).join('')}</select><button class="p" id="shot">⛳ Marcar golpe</button></div>
    </div>
    <div class="mut" id="club" style="text-align:center"></div>
    <div class="mut" id="haz" style="text-align:center"></div>
    <div class="mut" id="tgt" style="text-align:center">Toca el mapa para medir a cualquier punto.</div>
    <div class="card" style="margin-top:10px"><div class="mut" id="lastShot">${shots.length ? shots.length + ' golpe(s) marcado(s)' : 'Marca cada golpe desde donde lo juegas para medir tus distancias.'}</div>
      ${shots.length ? '<button class="d" id="undo">Deshacer último golpe</button>' : ''}</div>
    <div class="card"><div class="mut">Golpes</div><div class="stepper"><button data-k="strokes" data-d="-1">−</button><div class="v" id="vS">${s.strokes || '–'}</div><button data-k="strokes" data-d="1">+</button></div></div>
    <div class="card"><div class="mut">Putts</div><div class="stepper"><button data-k="putts" data-d="-1">−</button><div class="v" id="vP">${s.putts}</div><button data-k="putts" data-d="1">+</button></div></div>
    ${h.par > 3 ? `<div class="card row"><span class="grow">Calle</span>
      ${[['L', 'left'], ['✓', 'hit'], ['R', 'right']].map(([t, k]) => `<button class="chip ${s.fairway === k ? 'on' : ''}" data-fw="${k}">${t}</button>`).join('')}</div>` : ''}
    <div class="card"><div class="mut">Nota del hoyo</div><textarea id="note" rows="2" style="width:100%;padding:8px;border:1px solid var(--line);border-radius:10px;background:var(--card);color:inherit;font:inherit">${esc(h.note || '')}</textarea></div>
    <div class="card row"><span class="grow">Cambio automático de hoyo</span><button class="chip ${r.auto ? 'on' : ''}" id="auto">${r.auto ? 'Activo' : 'Off'}</button></div>
    <div class="row"><button class="s grow" id="prev" ${r.hole ? '' : 'disabled'}>← Anterior</button>
      ${r.hole < c.holes.length - 1 ? '<button class="p grow" id="next">Siguiente →</button>' : '<button class="p grow" id="fin">Terminar</button>'}</div>
    <div class="row" style="margin-top:12px"><button class="d" id="card">Ver tarjeta</button><span class="grow"></span><button class="d" id="abort">Descartar ronda</button></div>`);

  // Mapa
  mkMap('map', h.green, 17);
  L.marker(h.tee, { icon: dot('#2a7de1', 'T') }).addTo(map);
  L.marker(h.green, { icon: dot('#e8503a', 'G') }).addTo(map);
  L.polyline([h.tee, h.green], { color: '#fff', weight: 2, dashArray: '6 6' }).addTo(map);
  map.fitBounds([h.tee, h.green], { padding: [30, 30] });
  const hazLayer = L.layerGroup().addTo(map), shotLayer = L.layerGroup().addTo(map), tgtLayer = L.layerGroup().addTo(map);
  const me = L.circleMarker([0, 0], { radius: 7, color: '#fff', fillColor: '#2a7de1', fillOpacity: 1 });
  let target = null, myElev = null, elevPos = null, elevT = 0, elevBusy = false;
  const from = () => pos || h.tee;

  const drawShots = () => { shotLayer.clearLayers(); shots.forEach((x, i) => L.marker(x.ll, { icon: dot('#f5a623', i + 1) }).addTo(shotLayer)); };
  drawShots();
  const drawHaz = () => {
    hazLayer.clearLayers();
    holeHazards(c, h).forEach(z => L.polygon(z.pts, { color: z.type === 'agua' ? '#4aa3ff' : '#e8d28a', weight: 1, fillOpacity: .4, interactive: false }).addTo(hazLayer));
  };
  drawHaz();
  if (!c.hazards && !loadingHaz.has(c.id) && navigator.onLine) {
    loadingHaz.add(c.id);
    loadHazards(c).then(() => { if (tab === 'round' && db.active === r && c.holes[r.hole] === h && map) { drawHaz(); showDist(); } })
      .catch(() => {}).finally(() => loadingHaz.delete(c.id));
  }

  const showTarget = () => {
    tgtLayer.clearLayers();
    if (!target) { $('#tgt').textContent = 'Toca el mapa para medir a cualquier punto.'; return; }
    const a = from(), d1 = yd(meters(a, target)), d2 = yd(meters(target, h.green));
    L.marker(target, { icon: dot('#8e44ad', '✕') }).addTo(tgtLayer);
    L.polyline([a, target, h.green], { color: '#8e44ad', weight: 2 }).addTo(tgtLayer);
    $('#tgt').textContent = `Objetivo: ${d1} yd desde ${pos ? 'ti' : 'la salida'} · ${d2} yd hasta el green`;
  };
  map.on('click', e => { target = target && meters(target, [e.latlng.lat, e.latlng.lng]) < 8 ? null : [e.latlng.lat, e.latlng.lng]; showTarget(); });

  const showDist = () => {
    const a = from(), d = meters(a, h.green), half = (h.depth || 20) / 2;
    $('#dC').textContent = yd(d); $('#dF').textContent = yd(Math.max(0, d - half)); $('#dB').textContent = yd(d + half);
    if (pos) {
      const k = suggestClub(yd(d));
      $('#club').textContent = k ? `Sugerido: ${k.name} (${k.dist} yd)` : '';
      if (h.elev != null && myElev != null) {
        const diff = h.elev - myElev, pl = yd(d) + Math.round(diff * 1.0936);
        $('#plays').textContent = Math.abs(diff) >= 1 ? `Juega como ${pl} yd (${diff > 0 ? '↑' : '↓'} ${Math.abs(Math.round(diff))} m)` : 'Terreno llano';
      }
    } else $('#club').textContent = 'Esperando GPS… (distancias desde la salida)';
    const list = holeHazards(c, h).map(z => {
      const ds = z.pts.map(p => meters(a, p)); return { t: z.type, near: Math.min(...ds), far: Math.max(...ds) };
    }).filter(z => z.far > 5 && z.near < d + 30).sort((x, y) => x.near - y.near).slice(0, 6);
    $('#haz').textContent = list.map(z => `${z.t === 'agua' ? '💧' : '🏖️'} ${yd(z.near)}–${yd(z.far)}`).join('  ·  ');
  };
  const updateElev = async () => {
    if (!pos || !navigator.onLine || elevBusy) return;
    if (Date.now() - elevT < 30000 && elevPos && meters(pos, elevPos) < 20) return;
    elevBusy = true; elevT = Date.now(); elevPos = pos;
    try {
      if (h.elev == null) { h.elev = (await elevations([h.green]))[0]; save(); }
      myElev = (await elevations([pos]))[0]; showDist();
    } catch (e) {} finally { elevBusy = false; }
  };
  const nav = d => { r.hole += d; save(); viewHole(); };
  onPos = () => {
    if (!pos) return;
    me.setLatLng(pos).addTo(map);
    showDist(); showTarget(); updateElev();
    if (shots.length) {
      const l = shots[shots.length - 1];
      $('#lastShot').textContent = `Último golpe (${l.club}): ${yd(meters(l.ll, pos))} yd · ${shots.length} marcado(s)`;
    }
    const nx = c.holes[r.hole + 1];
    if (r.auto && s.strokes > 0 && nx && nx.tee && meters(pos, nx.tee) < 35 && meters(pos, h.green) > 40) nav(1);
  };
  showDist(); onPos();

  // Controles
  const bump = () => { save(); $('#vS').textContent = s.strokes || '–'; $('#vP').textContent = s.putts; };
  v.querySelectorAll('[data-d]').forEach(b => b.onclick = () => {
    const k = b.dataset.k; s[k] = Math.max(0, s[k] + +b.dataset.d);
    if (k === 'putts' && s.putts > s.strokes) s.strokes = s.putts;
    if (k === 'strokes' && s.strokes === 1 && b.dataset.d === '1') s.strokes = h.par; // primer toque = par
    bump();
  });
  $('#shot').onclick = () => {
    if (!pos) return alert('Aún sin GPS: espera a que aparezca tu posición en el mapa.');
    const club = $('#clubSel').value;
    shots.push({ ll: pos, club, t: Date.now() });
    s.strokes = Math.max(s.strokes, shots.length);
    if (club === 'Putter') s.putts = shots.filter(x => x.club === 'Putter').length;
    if (s.putts > s.strokes) s.strokes = s.putts;
    save(); viewHole();
  };
  if ($('#undo')) $('#undo').onclick = () => { shots.pop(); save(); viewHole(); };
  $('#note').onchange = e => { h.note = e.target.value.trim(); save(); };
  $('#auto').onclick = () => { r.auto = !r.auto; save(); viewHole(); };
  v.querySelectorAll('[data-fw]').forEach(b => b.onclick = () => { s.fairway = s.fairway === b.dataset.fw ? null : b.dataset.fw; save(); viewHole(); });
  $('#prev').onclick = () => nav(-1);
  if ($('#next')) $('#next').onclick = () => nav(1);
  if ($('#fin')) $('#fin').onclick = () => {
    if (!confirm('¿Terminar y guardar la ronda?')) return;
    learnBag(r);
    db.rounds.unshift({ id: r.id, courseId: c.id, courseName: c.name, date: r.date, rating: c.rating || null, slope: c.slope || null,
      shots: r.shots, holes: c.holes.map((x, i) => ({ par: x.par, ...r.scores[i] })) });
    db.active = null; save(); releaseAwake(); go('stats');
  };
  $('#abort').onclick = () => { if (confirm('¿Descartar la ronda en curso?')) { db.active = null; save(); releaseAwake(); viewRound(); } };
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
  const c = { id: uid(), osmId, name, bb, holes: holes.length ? holes.map(mk) : Array.from({ length: 18 }, () => ({ par: 4, tee: null, green: null })) };
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
      <div class="row" style="margin-bottom:8px"><label class="grow">Course rating<input id="rt" type="number" step="0.1" inputmode="decimal" value="${c.rating ?? ''}"></label>
        <label class="grow">Slope<input id="sl" type="number" inputmode="numeric" value="${c.slope ?? ''}"></label></div>
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
    $('#rt').onchange = e => { c.rating = parseFloat(e.target.value) || null; save(); };
    $('#sl').onchange = e => { c.slope = parseInt(e.target.value) || null; save(); };
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
  const hcp = handicapIndex();
  let bestH = null; const played = {};
  R.forEach(r => { played[r.courseName] = (played[r.courseName] || 0) + 1;
    r.holes.forEach((h, i) => { if (!h.strokes) return; const d = h.strokes - h.par; if (!bestH || d < bestH.d) bestH = { d, n: i + 1, s: h.strokes, par: h.par, course: r.courseName }; }); });
  const topCourse = Object.entries(played).sort((a, b) => b[1] - a[1])[0];
  const career = n ? `Mejor hoyo: ${bestH.s} (par ${bestH.par}) en el ${bestH.n} de ${esc(bestH.course)}<br>Campo más jugado: ${esc(topCourse[0])} (${topCourse[1]})<br>Águilas: ${cnt(-2)} · Birdies: ${allH.filter(h => h.strokes - h.par === -1).length} · Pares: ${allH.filter(h => h.strokes === h.par).length}` : '';
  const v = view(`<h1>Estadísticas</h1>
    ${n ? `<div class="grid">
      <div class="card"><span class="mut">Rondas</span><b>${n}</b></div>
      <div class="card"><span class="mut">Media</span><b>${avg(R.map(sc)).toFixed(1)}</b></div>
      <div class="card"><span class="mut">Mejor</span><b>${Math.min(...R.map(sc))}</b></div>
      <div class="card"><span class="mut">Putts/ronda</span><b>${avg(R.map(r => r.holes.reduce((a, h) => a + h.putts, 0))).toFixed(1)}</b></div>
      <div class="card"><span class="mut">Calles</span><b>${firPct ?? '–'}${firPct != null ? '%' : ''}</b></div>
      <div class="card"><span class="mut">Greens en regl.</span><b>${girPct ?? '–'}${girPct != null ? '%' : ''}</b></div>
      <div class="card"><span class="mut">Birdies o mejor</span><b>${cnt(-1)}</b></div>
      <div class="card"><span class="mut">Pares o mejor</span><b>${cnt(0)}</b></div>
      <div class="card"><span class="mut">Handicap Index</span><b>${hcp.idx ?? '–'}</b>${hcp.idx == null ? '<span class="mut">Necesitas 3 rondas de 18 hoyos con rating y slope del campo (Campos → Editar)</span>' : `<span class="mut">${hcp.count} rondas</span>`}</div></div>
    <h2>Carrera</h2><div class="card">${career}</div>
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
  const v = view(`<h1>Mi bolsa</h1><div class="mut" style="margin-bottom:8px">Distancia media en yardas. Se usa para sugerir palo y se ajusta sola con los golpes que marques en la ronda (a partir de 3 golpes por palo).</div>
    ${db.bag.map((c, i) => `<div class="card row"><input class="grow" value="${esc(c.name)}" data-n="${i}"><input style="width:90px" type="number" inputmode="numeric" value="${c.dist}" data-d="${i}"><span class="mut">${(c.samples || []).length ? (c.samples.length + ' golpes') : ''}</span><button class="d" data-x="${i}">✕</button></div>`).join('')}
    <button class="s" id="add">＋ Añadir palo</button>`);
  v.querySelectorAll('[data-n]').forEach(e => e.onchange = () => { db.bag[+e.dataset.n].name = e.value; save(); });
  v.querySelectorAll('[data-d]').forEach(e => e.onchange = () => { db.bag[+e.dataset.d].dist = +e.value || 0; save(); });
  v.querySelectorAll('[data-x]').forEach(b => b.onclick = () => { db.bag.splice(+b.dataset.x, 1); save(); viewBag(); });
  $('#add').onclick = () => { db.bag.push({ name: 'Nuevo', dist: 100 }); save(); viewBag(); };
}

// ---------- Arranque ----------
const VERSION = 'v7';
if ('serviceWorker' in navigator) {
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (!reloaded && !db.active) { reloaded = true; location.reload(); } });
  navigator.serviceWorker.register('sw.js').then(r => r.update()).catch(() => {});
}
// Pie con la versión y un botón para forzar la actualización (conserva tus datos)
const foot = document.createElement('div');
foot.style.cssText = 'text-align:center;padding:16px;font-size:.75rem;color:var(--mut)';
foot.innerHTML = `Fairway ${VERSION} · <a href="#" id="upd" style="color:inherit">Forzar actualización</a>`;
document.body.insertBefore(foot, $('#tabs'));
$('#upd').onclick = async e => {
  e.preventDefault();
  try { (await navigator.serviceWorker.getRegistrations()).forEach(r => r.unregister()); (await caches.keys()).forEach(k => caches.delete(k)); } catch (x) {}
  location.reload();
};
go('round');
