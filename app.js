import { SkyGuardModel, SkyGuardStream, analyze, explain, toMs, VARS } from './src/detector.js';
import { generateScenario } from './src/simulate.js';
import { parseCsv } from './src/csv.js';

const COLORS = { temperature: '#b5412d', pressure: '#2f5d8a', humidity: '#2e8b7a' };
const SEV = { critical: '#a4206b', high: '#c2410c', medium: '#c98a00' };
const UNIT = { temperature: '°C', pressure: ' hPa', humidity: '%' };
const LIVE_WINDOW = 144;

const $ = (id) => document.getElementById(id);
const scn = generateScenario({ trainDays: 14, testDays: 5, seed: 21, inject: false });
const model = new SkyGuardModel().fit(scn.train);

let stream = new SkyGuardStream(model);
let idx = 0;
let timer = null;
let pending = [];
let view = { obs: [], results: [], windowSize: LIVE_WINDOW };
const alertItems = new Map();

/* ---------- fault injection: each one changes the next readings ---------- */
const INJECTIONS = {
  spike: () => ({ left: 1, apply: (o) => { o.temperature = +(o.temperature + 25).toFixed(1); } }),
  hot55: () => ({ left: 1, apply: (o) => { o.temperature = 55; o.humidity = 97; o.pressure = +(o.pressure - 14).toFixed(1); } }),
  dropout: () => ({ left: 1, apply: (o) => { o.pressure = -999; } }),
  frozen: () => ({ left: 30, hold: null, apply(o) { if (this.hold === null) this.hold = o.temperature; o.temperature = this.hold; } }),
  drift: () => ({ left: 400, k: 0, apply(o) { o.temperature = +(o.temperature + 0.03 * this.k++).toFixed(1); } }),
  front: () => ({
    left: 36, k: 0,
    apply(o, nbs) { // real weather reaches every station
      const k = this.k++;
      const w = k < 12 ? (k + 1) / 12 : 1 - (k - 11) / 24;
      for (const s of [o, ...nbs]) {
        s.temperature = +(s.temperature - 8 * w).toFixed(1);
        s.pressure = +(s.pressure - 6 * w).toFixed(1);
        s.humidity = +Math.min(100, s.humidity + 25 * w).toFixed(1);
      }
    },
  }),
};

/* ---------- streaming ---------- */
function step() {
  if (idx >= scn.test.length) { stop(); $('toggle').textContent = 'Restart station'; idx = 0; return; }
  const o = { ...scn.test[idx] };
  const nbs = (scn.neighborsAt(toMs(o.t)) || []).map((n) => ({ ...n }));
  for (const m of pending) { m.apply(o, nbs); m.left -= 1; }
  pending = pending.filter((m) => m.left > 0);
  idx += 1;
  const r = stream.ingest(o, nbs);
  view.obs.push(o);
  view.results.push(r);
  if (view.obs.length > LIVE_WINDOW * 3) { view.obs.shift(); view.results.shift(); }
  recordAlert(r);
  for (const rev of r.revises) updateAlert(rev);
  render();
}

function start() {
  if (timer) return;
  const perSecond = Number($('speed').value);
  timer = setInterval(step, 1000 / perSecond);
  $('toggle').textContent = 'Pause station';
}
function stop() { clearInterval(timer); timer = null; $('toggle').textContent = 'Start station'; }

/* ---------- alerts ---------- */
const clock = (iso) => iso.slice(5, 16).replace('T', ' ');

function recordAlert(r) {
  if (!r.flagged) return;
  const list = $('alerts');
  if (list.querySelector('.empty')) list.innerHTML = '';
  const li = document.createElement('li');
  li.innerHTML = `<details><summary><span class="sev ${r.severity}"></span><b></b><span class="when">${clock(r.t)}</span></summary><pre></pre></details>`;
  li.querySelector('b').textContent = r.rootCause;
  li.querySelector('pre').textContent = explain(r);
  list.prepend(li);
  alertItems.set(r.index, { li, r });
  while (list.children.length > 40) list.lastChild.remove();
}

function updateAlert(rev) {
  const item = alertItems.get(rev.index);
  if (!item) return;
  item.li.querySelector('b').textContent = item.r.rootCause;
  item.li.querySelector('pre').textContent = `${explain(item.r)}\n  - Later reading confirmed this as a ${rev.rule === 'spike' ? 'spike (it returned to normal)' : 'level shift'}.`;
}

/* ---------- health panel ---------- */
function renderHealth(h) {
  const s = $('status');
  s.textContent = h.status;
  s.className = `status ${h.status}`;
  const facts = [
    `Flagged: ${(h.anomalyRate * 100).toFixed(1)}% of the last ${h.samples} readings`,
    `Flags by sensor: temperature ${h.perVariable.temperature}, pressure ${h.perVariable.pressure}, humidity ${h.perVariable.humidity}`,
    `Maintenance recommended: ${h.maintenanceRecommended ? 'yes' : 'no'}`,
    ...h.reasons,
  ];
  $('facts').innerHTML = '';
  for (const f of facts) { const li = document.createElement('li'); li.textContent = f; $('facts').append(li); }
}

/* ---------- charts ---------- */
function drawStrip(v) {
  const canvas = $(`c-${v}`);
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const g = canvas.getContext('2d');
  g.scale(dpr, dpr);
  g.clearRect(0, 0, w, h);

  const n = view.windowSize;
  const obs = view.obs.slice(-n);
  const res = view.results.slice(-n);
  const padL = 44, padR = 8, padT = 8, padB = 8;
  if (!obs.length) return;

  const good = obs.filter((o, i) => !res[i].flagged && typeof o[v] === 'number').map((o) => o[v]);
  const pool = good.length ? good : obs.map((o) => o[v]).filter((x) => typeof x === 'number');
  let lo = Math.min(...pool), hi = Math.max(...pool);
  const pad = Math.max((hi - lo) * 0.2, v === 'pressure' ? 1 : v === 'humidity' ? 5 : 2);
  lo -= pad; hi += pad;
  const X = (i) => padL + ((w - padL - padR) * i) / Math.max(1, n - 1);
  const Y = (x) => padT + (h - padT - padB) * (1 - (x - lo) / (hi - lo));

  g.strokeStyle = '#c5d0d8'; g.fillStyle = '#4d6071'; g.font = '12px system-ui, sans-serif'; g.lineWidth = 1;
  for (let k = 0; k <= 3; k++) {
    const val = lo + ((hi - lo) * k) / 3;
    const y = Y(val);
    g.beginPath(); g.moveTo(padL, y); g.lineTo(w - padR, y); g.stroke();
    g.fillText(val.toFixed(v === 'pressure' ? 1 : 0), 4, y + 4);
  }

  g.strokeStyle = COLORS[v]; g.lineWidth = 1.6; g.beginPath();
  let pen = false;
  obs.forEach((o, i) => {
    const x = o[v];
    if (typeof x !== 'number' || res[i].flagged || x < lo || x > hi) { pen = false; return; }
    if (pen) g.lineTo(X(i), Y(x)); else g.moveTo(X(i), Y(x));
    pen = true;
  });
  g.stroke();

  obs.forEach((o, i) => {
    const r = res[i];
    if (!r.flagged || !(r.variablesAffected.includes(v) || r.variablesAffected.includes('multiple'))) return;
    const x = o[v];
    g.fillStyle = SEV[r.severity] || '#c98a00';
    if (typeof x === 'number' && x >= lo && x <= hi) {
      g.beginPath(); g.arc(X(i), Y(x), 4, 0, 6.283); g.fill();
    } else {
      const top = typeof x === 'number' && x > hi;
      const y = top ? padT + 5 : h - padB - 5;
      g.beginPath();
      g.moveTo(X(i), top ? y - 4 : y + 4); g.lineTo(X(i) - 5, top ? y + 5 : y - 5); g.lineTo(X(i) + 5, top ? y + 5 : y - 5);
      g.closePath(); g.fill();
    }
    const c = r.corrected && r.corrected[v];
    if (typeof c === 'number' && c >= lo && c <= hi) {
      g.strokeStyle = '#12263a'; g.lineWidth = 1.4;
      const cx = X(i), cy = Y(c);
      g.beginPath(); g.moveTo(cx, cy - 5); g.lineTo(cx + 5, cy); g.lineTo(cx, cy + 5); g.lineTo(cx - 5, cy); g.closePath(); g.stroke();
    }
  });

  const last = obs[obs.length - 1][v];
  $(`v-${v}`).textContent = typeof last === 'number' ? `${last}${UNIT[v]}` : 'no value';
}

function render() {
  VARS.forEach(drawStrip);
  renderHealth(stream.health());
}

/* ---------- controls ---------- */
$('toggle').addEventListener('click', () => {
  if (timer) { stop(); return; }
  if (view.windowSize !== LIVE_WINDOW) resetLive();
  start();
});
$('speed').addEventListener('change', () => { if (timer) { stop(); start(); } });
document.querySelectorAll('[data-inject]').forEach((b) => b.addEventListener('click', () => {
  if (view.windowSize !== LIVE_WINDOW) resetLive();
  pending.push(INJECTIONS[b.dataset.inject]());
  if (!timer) start();
}));

function resetLive() {
  stop();
  stream = new SkyGuardStream(model);
  idx = 0; pending = [];
  view = { obs: [], results: [], windowSize: LIVE_WINDOW };
  alertItems.clear();
  $('alerts').innerHTML = '<li class="empty">No alerts yet.</li>';
  $('legend').textContent = 'Coloured dots are flagged readings. Hollow diamonds show a suggested replacement value. Triangles at the edge are readings far off the chart.';
}

$('csv').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const rows = parseCsv(await file.text());
    stop();
    const m = new SkyGuardModel().fit(rows);
    const { results, health } = analyze(m, rows);
    view = { obs: rows, results, windowSize: Math.min(rows.length, 1500) };
    alertItems.clear();
    $('alerts').innerHTML = '<li class="empty">No alerts.</li>';
    results.filter((r) => r.flagged).slice(0, 40).forEach(recordAlert);
    $('legend').textContent = `${file.name}: ${rows.length} readings, ${results.filter((r) => r.flagged).length} flagged. A single file has no neighbouring stations, so real weather events cannot be confirmed.`;
    VARS.forEach(drawStrip);
    renderHealth(health);
  } catch (err) {
    $('legend').textContent = `Could not read that file: ${err.message}`;
  }
});

window.addEventListener('resize', () => VARS.forEach(drawStrip));
render();
