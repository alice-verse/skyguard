# SkyGuard

Checks temperature, pressure and humidity readings from an automatic weather station (AWS), flags the ones that look wrong, and explains why.

This is an independent prototype inspired by the public Smart India Hackathon 2026 problem statement SIH26073 ("anomaly detection for Automatic Weather Stations"). It is not an SIH submission and has not been used by any weather service. All data in this repository is simulated.

## Why this problem matters

Weather stations send readings every few minutes. Sensors fail, links drop, and loggers send placeholder values. A wrong reading that reaches a forecast model is worse than a missing one, because nobody knows to distrust it. The hard part is telling a **faulty sensor** from **real weather**: a sudden 7 °C drop can be a cold-air outflow from a thunderstorm or a broken thermometer.

SkyGuard separates the two by asking: does this change make physical sense, does it match the station's own history, and do neighbouring stations see the same thing?

## Quick start

Requires Node.js 18 or newer. There are no dependencies to install.

```bash
npm test                 # 27 automated tests
npm run demo             # the 55 °C example from the problem statement, then an evaluation
npm run evaluate         # accuracy on simulated faults, 5 random seeds, two noise levels
npm run detect           # check data/sample.csv
node examples/use_cases.mjs   # seven worked use cases (see docs/USE_CASES.md)
npm run serve            # then open http://localhost:8080 for the dashboard (needs Python 3)
```

Check your own file: `node src/cli.js detect yourfile.csv`. Columns: `timestamp,temperature,pressure,humidity` (readings every 10 minutes by default).

## What it checks

| Check | What it catches |
|---|---|
| Missing / placeholder | `null`, `NaN`, `-999`, `9999`: communication errors |
| Physical range | Temperature outside -60 to 60 °C, humidity outside 0 to 100 %, pressure outside 400 to 1100 hPa |
| Sudden jump | Change between readings larger than a limit; re-labelled **spike** if the next reading returns to normal, **level shift** if it stays |
| Frozen value | Same value for 18 readings (3 hours); saturated 100 % humidity is exempt |
| Dew point | Combinations like 55 °C with 97 % humidity that cannot occur in practice |
| Learned daily pattern | Distance from the typical value for that hour of the day, learned from history |
| Learned joint behaviour | Temperature, pressure and humidity changing together in a way never seen in history (Mahalanobis distance) |
| Neighbouring stations (optional) | Disagreement with the median of nearby stations; also **confirms** real weather when neighbours change the same way |
| Timestamps | Duplicate, out-of-order, unreadable, and gaps in the record |

Each reading gets a confidence score, a severity (medium, high, critical), a root cause, a plain-language explanation showing how much each check contributed, and (when it flags something) a suggested replacement value based on the learned daily pattern.

Sensor health looks at the last 24 hours: how many readings were flagged, and whether a sensor has been reading consistently above or below expectations (possible calibration drift, judged against neighbours when available).

All thresholds are in `src/config.js` and are **assumptions** for a 10-minute interval, not official meteorological limits.

## How it maps to the problem statement

| Objective in the problem statement | Status |
|---|---|
| Detect anomalies in real-time streams | Done. One reading is processed at a time (about 25 microseconds each on my test machine; not a formal benchmark). |
| Identify faults, spikes, frozen values, communication errors | Done |
| Learn normal temporal and seasonal patterns | **Partial.** Learns a pattern for each hour of the day. No longer-term seasonal model. |
| Multivariate consistency analysis | Done (learned joint changes plus dew point check) |
| Confidence scores and explainable reasoning | Done as a transparent rule breakdown. **Not SHAP or LIME.** |
| Predict sensor degradation | **Partial.** Rolling health status and drift detection. No forecasting model. |
| Suggest corrected values | Done (simple estimate from the daily pattern) |
| Spatial consistency with neighbours | Done (optional input) |
| Visualisation dashboard | Done. See the note on testing below. |
| Edge deployment on ESP32 | **Not done** |

On "AI/ML": the learned parts are statistical (hourly baselines with robust spreads, and a covariance model of simultaneous changes). There is no deep learning. The rest is explicit rules, which is deliberate: every alert can be explained.

## Results on simulated data

Run `npm run evaluate` to reproduce. The simulator injects known faults (spikes, frozen sensors, dropouts, out-of-range values, impossible readings, duplicates, gaps, and deliberately small "subtle" errors) plus real weather events that change every station.

| Setting | Fault recall | False alarms on clean readings | Real weather events wrongly alerted | Subtle-fault recall |
|---|---|---|---|---|
| Quiet sensors, 5 seeds | 100% on all 5 | 0.00% | 0 of 4 on every seed | 100% |
| Noisy sensors (noise x4), 5 seeds | 90% to 100% | 0.00% | 0 to 2 of 4 (2 on seed 3) | 25% to 100% |

How to read this: quiet simulated data is easy, so 100% says little. The noisy setting shows where the detector weakens: small errors hide in the noise, and a real weather event can be mistaken for a fault. A frozen sensor is only flagged after 18 identical readings (reported delay: 17 samples after it froze), by design.

**These numbers come from simulated data with known faults and thresholds I chose. They do not predict performance on real stations.**

## Project layout

```
src/detector.js    the model, the streaming checks, explanations, health
src/config.js      every threshold, with comments
src/simulate.js    seeded weather simulator with fault injection
src/evaluate.js    scoring against injected faults
src/csv.js         CSV reader and writer
src/cli.js         command-line interface
index.html, app.js dashboard (live simulated station, fault buttons, CSV upload)
tests/             27 automated tests (Node's built-in test runner)
examples/          worked use cases
docs/              USE_CASES.md, BUGS.md and saved outputs
data/sample.csv    28 days of simulated readings, faults in the second half
```

## Dashboard testing note

The dashboard logic was exercised against a stubbed page in Node (160 simulated readings, fault buttons, alerts, health panel) with no errors. It has **not** been opened in a real browser by its author yet. Visual layout and canvas drawing are unverified.

## Limitations

- Simulated data only. Real stations have sensor noise, altitude effects, rain and fog behaviour, and local quirks that this simulator does not capture.
- Thresholds are untuned assumptions. A hilltop, a coastal site and a desert station need different values.
- Without neighbouring stations, a real weather event with a very sharp change can be flagged as a fault, and drift is judged only against the station's own pattern (slow weather systems can look like drift).
- Faults smaller than the thresholds go undetected, especially when sensors are noisy.
- The learned pattern uses hour of day only, so it does not know the season. Train on data from a similar time of year.
- Timestamps are read as UTC for the hour-of-day pattern. Consistency matters, not the time zone.
- The corrected value is a rough estimate and must not be treated as a measurement.
- Single-threaded JavaScript; scale to thousands of stations has not been tested.

## Next steps

- Browser tests with Playwright for the dashboard.
- Validate on a real, openly licensed AWS dataset and tune thresholds per station type.
- Compare against a standard method such as an isolation forest on the same simulated data.
- Optional: port the core checks to run on a microcontroller.

## Licence

MIT (add a `LICENSE` file before publishing).
