import test from 'node:test';
import assert from 'node:assert/strict';
import { SkyGuardModel, SkyGuardStream, explain, toMs } from '../src/detector.js';
import { generateScenario } from '../src/simulate.js';
import { evaluate } from '../src/evaluate.js';
import { parseCsv, toCsv } from '../src/csv.js';
import { DEFAULTS } from '../src/config.js';

// Shared fixture: 14 days of clean history plus 3 clean days to stream.
const scn = generateScenario({ trainDays: 14, testDays: 3, seed: 11, inject: false });
const model = new SkyGuardModel().fit(scn.train);
const at = (i) => scn.test[i];
const nb = (i) => scn.neighborsAt(toMs(at(i).t));
const hasRule = (r, rule, variable) =>
  r.checks.some((c) => c.rule === rule && (!variable || c.variable === variable));

function warm(n = 150) {
  const st = new SkyGuardStream(model);
  for (let i = 0; i < n; i++) st.ingest(at(i), nb(i));
  return st;
}

test('clean data raises no alerts', () => {
  const st = warm(300);
  assert.equal(st.results.filter((r) => r.flagged).length, 0);
  assert.equal(st.health().status, 'Healthy');
});

test('simulator is reproducible for the same seed', () => {
  const a = generateScenario({ seed: 5 });
  const b = generateScenario({ seed: 5 });
  assert.deepEqual(a.test, b.test);
  assert.notDeepEqual(a.test, generateScenario({ seed: 6 }).test);
});

/* ---------- missing and out-of-range values ---------- */

test('out-of-range temperature is flagged as a sensor fault', () => {
  const st = warm();
  const r = st.ingest({ ...at(150), temperature: 85 }, nb(150));
  assert.ok(r.flagged);
  assert.equal(r.severity, 'critical');
  assert.match(r.rootCause, /outside physical range/);
});

test('range limits are inclusive: 100% humidity is valid, 100.1% is not', () => {
  const ok = warm().ingest({ ...at(150), humidity: 100 }, nb(150));
  assert.ok(!hasRule(ok, 'range'));
  const bad = warm().ingest({ ...at(150), humidity: 100.1 }, nb(150));
  assert.ok(hasRule(bad, 'range', 'humidity'));
});

test('null and placeholder values are treated as communication errors', () => {
  for (const bad of [null, undefined, NaN, -999, 9999]) {
    const r = warm().ingest({ ...at(150), pressure: bad }, nb(150));
    assert.ok(r.flagged, `value ${bad} should be flagged`);
    assert.match(r.rootCause, /Communication error/);
  }
});

test('a missing value does not corrupt later readings', () => {
  const st = warm();
  st.ingest({ ...at(150), temperature: null }, nb(150));
  const next = st.ingest(at(151), nb(151));
  assert.ok(!next.flagged);
});

/* ---------- jump boundary ---------- */

test('temperature step exactly at the limit is accepted, just above is flagged', () => {
  const base = at(149).temperature;
  const limit = DEFAULTS.maxStep.temperature;
  const atLimit = warm().ingest({ ...at(150), temperature: +(base + limit).toFixed(1) });
  assert.ok(!hasRule(atLimit, 'jump', 'temperature'), 'exactly at limit must pass');
  const above = warm().ingest({ ...at(150), temperature: +(base + limit + 0.1).toFixed(1) });
  assert.ok(hasRule(above, 'jump', 'temperature'), 'just above limit must be flagged');
});

test('regression: floating-point noise must not turn a change of exactly 6.0 into 6.000000000000004', () => {
  // 32.2 - 26.2 is 6.0000000000000036 in floating point. Without rounding in the detector,
  // a change of exactly the 6 C limit was wrongly flagged as a jump.
  const st = new SkyGuardStream(new SkyGuardModel()); // no learned model: only the basic rules apply
  const obs = (i, temperature) => ({
    t: new Date(Date.UTC(2026, 5, 1, 12, i * 10)).toISOString(), temperature, pressure: 1000, humidity: 60,
  });
  st.ingest(obs(0, 26.2));
  const r = st.ingest(obs(1, 32.2));
  assert.equal(32.2 - 26.2 > 6, true, 'precondition: plain subtraction exceeds the limit');
  assert.ok(!hasRule(r, 'jump', 'temperature'));
  const above = st.ingest(obs(2, 38.3)); // 6.1 above the previous reading
  assert.ok(hasRule(above, 'jump', 'temperature'));
});

test('a spike that returns to normal is re-labelled as a spike', () => {
  const st = warm();
  const spike = st.ingest({ ...at(150), temperature: at(150).temperature + 25 });
  assert.ok(spike.flagged);
  assert.ok(hasRule(spike, 'jump', 'temperature'));
  const next = st.ingest(at(151));
  assert.ok(!next.flagged);
  assert.equal(next.revises.length, 1);
  assert.ok(hasRule(st.results[150], 'spike', 'temperature'));
});

test('a jump that stays is reported as a level shift, not an endless spike', () => {
  const st = warm();
  const shifted = (i) => ({ ...at(i), temperature: at(i).temperature + 12 });
  const results = [150, 151, 152, 153, 154].map((i) => st.ingest(shifted(i)));
  assert.ok(hasRule(results[2], 'level_shift', 'temperature'));
  // After acceptance the jump itself is no longer reported. The station still reads far
  // above its usual pattern, so that deviation keeps being reported separately.
  assert.ok(!hasRule(results[4], 'jump') && !hasRule(results[4], 'level_shift'));
});

/* ---------- frozen sensor ---------- */

test('frozen temperature: 17 identical readings pass, the 18th is flagged', () => {
  const st = warm();
  const flags = [];
  for (let k = 0; k < 20; k++) {
    const r = st.ingest({ ...at(150 + k), temperature: 22.0 });
    flags.push(hasRule(r, 'flatline', 'temperature'));
  }
  assert.equal(flags.indexOf(true), 17);
});

test('saturated humidity at 100% is not treated as frozen', () => {
  const st = warm();
  for (let k = 0; k < 40; k++) {
    const r = st.ingest({ ...at(150 + k), humidity: 100 });
    assert.ok(!hasRule(r, 'flatline', 'humidity'));
  }
});

/* ---------- physical consistency ---------- */

test('55 C with 97% humidity is physically implausible', () => {
  const r = warm().ingest({ ...at(150), temperature: 55, humidity: 97 }, nb(150));
  assert.ok(hasRule(r, 'physical_dewpoint'));
  assert.match(r.rootCause, /Physically inconsistent/);
  assert.ok(r.corrected && r.corrected.temperature < 40, 'suggests a sensible replacement');
});

/* ---------- genuine weather vs sensor fault ---------- */

test('a sudden drop confirmed by neighbours is not an alert; the same drop alone is', () => {
  const change = (o) => ({ ...o, temperature: o.temperature - 7, humidity: Math.min(99, o.humidity + 20) });
  const drop = change(at(150));
  const neighboursAlsoDrop = nb(150).map(change);
  const confirmed = warm().ingest(drop, neighboursAlsoDrop);
  assert.ok(!confirmed.flagged, explain(confirmed));
  assert.ok(confirmed.genuineEvent);

  const alone = warm().ingest(drop, nb(150));
  assert.ok(alone.flagged);
  assert.ok(!alone.genuineEvent);
});

test('station that disagrees with neighbours is flagged even without a big jump', () => {
  const st = warm();
  // +5.5 C is under the 6 C step limit but above the 4 C neighbour tolerance, even after
  // allowing for each station's small fixed offset.
  const offset = (o) => ({ ...o, temperature: o.temperature + 5.5 });
  const r = st.ingest(offset(at(150)), nb(150));
  assert.ok(hasRule(r, 'spatial_inconsistency', 'temperature'));
});

/* ---------- timestamps ---------- */

test('a record older than the latest one is flagged as out of order', () => {
  const r = warm().ingest(at(140));
  assert.ok(hasRule(r, 'out_of_order'));
});

test('five missing observations are reported as a communication gap', () => {
  const gap = warm().ingest(at(155), nb(155)); // records 150-154 never arrived
  const c = gap.checks.find((x) => x.rule === 'communication_gap');
  assert.ok(c);
  assert.match(c.message, /5 observation/);
});

test('the change across a communication gap is not judged as a one-step change', () => {
  // Without neighbours to excuse it, a 50-minute change used to trip the multivariate check.
  const st = warm();
  const r = st.ingest(at(155)); // records 150-154 never arrived, and no neighbour data supplied
  assert.ok(hasRule(r, 'communication_gap'));
  assert.ok(!hasRule(r, 'multivariate_step'));
  assert.ok(!hasRule(r, 'jump'));
});

test('exact duplicate of the latest record is a duplicate timestamp', () => {
  const st = warm();
  const last = st.results.length - 1;
  const r = st.ingest({ ...at(last) });
  assert.ok(hasRule(r, 'duplicate_timestamp'));
});

test('unreadable timestamp is flagged', () => {
  const r = warm().ingest({ ...at(150), t: 'not a date' });
  assert.ok(hasRule(r, 'invalid_timestamp'));
});

/* ---------- sensor health ---------- */

test('frequent faults make the sensor Degraded and recommend maintenance', () => {
  const st = new SkyGuardStream(model);
  for (let i = 0; i < 144; i++) {
    const o = i % 10 === 5 ? { ...at(i), temperature: 85 } : at(i);
    st.ingest(o, nb(i));
  }
  const h = st.health();
  assert.equal(h.status, 'Degraded');
  assert.ok(h.maintenanceRecommended);
  assert.ok(h.perVariable.temperature >= 10);
});

test('a slow calibration offset is reported as drift', () => {
  const st = new SkyGuardStream(model);
  const n = 400;
  let early = null;
  for (let i = 0; i < n; i++) {
    const drift = Math.min(i * 0.02, 4); // up to +4 C over the run
    st.ingest({ ...at(i), temperature: +(at(i).temperature + drift).toFixed(1) }, nb(i));
    if (i === 143) early = st.health();
  }
  // Regression: after one day a slow pressure system used to be reported as pressure drift.
  assert.ok(!early.reasons.some((x) => /pressure|humidity/.test(x)), JSON.stringify(early.reasons));
  const h = st.health();
  assert.ok(h.reasons.some((x) => /temperature.*calibration drift/.test(x)), JSON.stringify(h));
  assert.ok(!h.reasons.some((x) => /pressure|humidity/.test(x)), 'only the drifting sensor is blamed');
  assert.ok(h.maintenanceRecommended);
});

/* ---------- model ---------- */

test('with too little history the model skips learned checks instead of crashing', () => {
  const tiny = new SkyGuardModel().fit(scn.train.slice(0, 10));
  const st = new SkyGuardStream(tiny);
  const r = st.ingest(at(0));
  assert.ok(!r.flagged);
  assert.ok(st.ingest({ ...at(1), temperature: 85 }).flagged, 'basic range checks still work');
});

test('explain() lists evidence and a suggested replacement', () => {
  const r = warm().ingest({ ...at(150), temperature: 85 }, nb(150));
  const text = explain(r);
  assert.match(text, /Alert \(critical/);
  assert.match(text, /Suggested replacement/);
});

/* ---------- CSV ---------- */

test('CSV round trip keeps values and blanks become null', () => {
  const rows = [
    { t: '2026-05-01T00:00:00Z', temperature: 25.5, pressure: 1000.1, humidity: 60 },
    { t: '2026-05-01T00:10:00Z', temperature: null, pressure: 1000.2, humidity: 61 },
  ];
  assert.deepEqual(parseCsv(toCsv(rows)), rows);
});

test('CSV accepts column aliases and rejects missing columns', () => {
  const ok = parseCsv('time,Temp,Pres,RH\n2026-05-01T00:00:00Z,20,1000,50\n');
  assert.equal(ok[0].humidity, 50);
  assert.throws(() => parseCsv('timestamp,temperature,pressure\n2026-05-01,20,1000\n'), /humidity/);
  assert.throws(() => parseCsv('timestamp,temperature,pressure,humidity\n'), /at least one data row/);
});

/* ---------- end-to-end evaluation on injected faults ---------- */

test('on quiet simulated data it catches nearly every injected fault with no false alarms', () => {
  const m = evaluate();
  assert.ok(m.eventRecall >= 0.9, `recall ${m.eventRecall}`);
  assert.ok(m.falseAlarmRate < 0.01, `false alarm rate ${m.falseAlarmRate}`);
  assert.equal(m.genuineEventsWronglyAlerted, 0);
});
