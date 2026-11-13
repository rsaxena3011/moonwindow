#!/usr/bin/env python3
"""MoonWindow data generation — NASA JPL Horizons, precomputed at build time.

Queries Sun (COMMAND 10) and Earth (COMMAND 399) as seen from each verified
site (CENTER='coord@301', SITE_COORD='lon,lat,0', COORD_TYPE='GEODETIC'),
2027-01-01 -> 2028-01-31, 1-hour steps, in half-year chunks.

Outputs:
  data/raw/<site>_<target>_<chunk>.json  — raw Horizons JSON (traceability)
  data/series.json  — 6-hourly Sun/Earth az/el per site (shipped to the app)
  data/metrics.json — per-site, per-day metrics computed from the HOURLY series

No data value is fabricated. If Horizons is unreachable the script fails loudly.
"""
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone

BASE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(BASE, "data")
RAW = os.path.join(DATA, "raw")

with open(os.path.join(BASE, "sites.json")) as f:
    SITES = json.load(f)["sites"]

TARGETS = {"sun": "10", "earth": "399"}
CHUNKS = [
    ("c1", "2027-01-01", "2027-07-01"),
    ("c2", "2027-07-01", "2028-01-01"),
    ("c3", "2028-01-01", "2028-02-01"),
]
STEP = "1 h"
MAX_WORKERS = 6
RETRIES = 3


def horizons_call(site, target, chunk, start, stop):
    """One Horizons API call. Returns list of (datetime, az, el)."""
    params = {
        "format": "json",
        "COMMAND": TARGETS[target],
        "EPHEM_TYPE": "OBSERVER",
        "OBJ_DATA": "NO",
        "MAKE_EPHEM": "YES",
        "CENTER": "coord@301",
        "SITE_COORD": f"{site['lon']},{site['lat']},0",
        "COORD_TYPE": "GEODETIC",
        "QUANTITIES": "1,4,9,20,23,24,29",
        "START_TIME": start,
        "STOP_TIME": stop,
        "STEP_SIZE": STEP,
        "CSV_FORMAT": "YES",
    }
    url = "https://ssd.jpl.nasa.gov/api/horizons.api?" + urllib.parse.urlencode(params)
    raw_path = os.path.join(RAW, f"{site['id']}_{target}_{chunk}.json")
    last_err = None
    for attempt in range(1, RETRIES + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "MoonWindow/1.0 (NASA Space Apps 2026; educational)"})
            with urllib.request.urlopen(req, timeout=180) as resp:
                body = resp.read().decode("utf-8", "replace")
            payload = json.loads(body)
            result = payload.get("result", "")
            with open(raw_path, "w") as f:
                f.write(body)
            rows = parse_result(result)
            if rows:
                return rows
            last_err = "no $$SOE block / empty series in result"
        except Exception as e:  # noqa: BLE001 — retry then fail loudly
            last_err = repr(e)
        print(f"  retry {attempt} {site['id']}/{target}/{chunk}: {last_err}", flush=True)
        time.sleep(5 * attempt)
    raise RuntimeError(f"Horizons call failed {site['id']}/{target}/{chunk}: {last_err}")


def parse_result(result):
    """Parse the CSV block between $$SOE / $$EOE. Returns [(datetime, az, el)]."""
    if "$$SOE" not in result or "$$EOE" not in result:
        return []
    body = result.split("$$SOE")[1].split("$$EOE")[0]
    # Header line: find the line containing 'Azi_' before $$SOE.
    header = result.split("$$SOE")[0].strip().splitlines()
    colnames = None
    for line in reversed(header):
        if "Azi_" in line:
            colnames = [c.strip() for c in line.split(",")]
            break
    if colnames is None:
        raise ValueError("CSV header with Azi_ not found")
    iaz = next(i for i, c in enumerate(colnames) if c.startswith("Azi_"))
    iel = next(i for i, c in enumerate(colnames) if c.startswith("Elev_"))
    rows = []
    for line in body.strip().splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) <= max(iaz, iel):
            continue
        try:
            dt = datetime.strptime(parts[0], "%Y-%b-%d %H:%M").replace(tzinfo=timezone.utc)
            az = float(parts[iaz])
            el = float(parts[iel])
        except ValueError:
            continue  # 'n.a.' or malformed row
        rows.append((dt, az, el))
    return rows


def merge(rows_list):
    merged = {}
    for rows in rows_list:
        for dt, az, el in rows:
            merged[dt] = (az, el)
    return sorted(merged.items())  # [(datetime, (az, el))]


def compute_metrics(hourly):
    """hourly: sorted [(datetime, (az, el))] for Sun and Earth separately.
    Returns (daily_metrics, longest_sunlit)."""
    sun = dict(hourly["sun"])
    earth = dict(hourly["earth"])
    times = sorted(sun.keys())
    start0 = times[0]
    # hourly grid completeness check
    expected = int((times[-1] - times[0]).total_seconds() // 3600) + 1
    assert len(times) == expected, f"hourly grid has gaps: {len(times)} vs {expected}"
    assert set(earth.keys()) == set(times), "sun/earth time grids differ"

    def frac_above(d0, days, which):
        d = dict(sun if which == "sun" else earth)
        n = 0
        tot = 0
        t = d0
        end = d0 + timedelta(days=days)
        while t < end:
            if t in d:
                tot += 1
                if d[t][1] > 0:
                    n += 1
            t += timedelta(hours=1)
        return (100.0 * n / tot) if tot else None

    def next_upward(d0, which):
        d = dict(sun if which == "sun" else earth)
        prev = None
        t = d0
        while t <= times[-1]:
            if t in d:
                el = d[t][1]
                if prev is not None and prev <= 0 < el:
                    return (t - d0).total_seconds() / 86400.0
                prev = el
            t += timedelta(hours=1)
        return None

    def longest_run(which):
        d = dict(sun if which == "sun" else earth)
        best_len, best_start = 0, None
        cur_len, cur_start = 0, None
        for t in times:
            if d[t][1] > 0:
                if cur_len == 0:
                    cur_start = t
                cur_len += 1
                if cur_len > best_len:
                    best_len, best_start = cur_len, cur_start
            else:
                cur_len = 0
        end = best_start + timedelta(hours=best_len) if best_start else None
        return {"hours": best_len, "start": best_start.isoformat() if best_start else None,
                "end": end.isoformat() if end else None}

    def el_range(d0, days):
        vals = [earth[t][1] for t in times if d0 <= t < d0 + timedelta(days=days)]
        return (min(vals), max(vals)) if vals else (None, None)

    daily = {}
    d = datetime(2027, 1, 1, tzinfo=timezone.utc)
    last = datetime(2027, 12, 31, tzinfo=timezone.utc)
    while d <= last:
        key = d.strftime("%Y-%m-%d")
        day = frac_above(d, 29.53, "sun")
        ear = frac_above(d, 29.53, "earth")
        # both-visible: fraction with both > 0
        n = tot = 0
        t = d
        end = d + timedelta(days=29.53)
        while t < end:
            if t in sun:
                tot += 1
                if sun[t][1] > 0 and earth[t][1] > 0:
                    n += 1
            t += timedelta(hours=1)
        both = 100.0 * n / tot if tot else None
        d7s = frac_above(d, 7, "sun")
        d7e = frac_above(d, 7, "earth")
        n7 = tot7 = 0
        t = d
        end7 = d + timedelta(days=7)
        while t < end7:
            if t in sun:
                tot7 += 1
                if sun[t][1] > 0 and earth[t][1] > 0:
                    n7 += 1
            t += timedelta(hours=1)
        d7b = 100.0 * n7 / tot7 if tot7 else None
        emin, emax = el_range(d, 29.53)
        daily[key] = {
            "daylight_pct": round(day, 1) if day is not None else None,
            "earth_pct": round(ear, 1) if ear is not None else None,
            "both_pct": round(both, 1) if both is not None else None,
            "d7_sun_pct": round(d7s, 1) if d7s is not None else None,
            "d7_earth_pct": round(d7e, 1) if d7e is not None else None,
            "d7_both_pct": round(d7b, 1) if d7b is not None else None,
            "next_sunrise_days": (round(next_upward(d, "sun"), 2) if next_upward(d, "sun") is not None else None),
            "next_earthrise_days": (round(next_upward(d, "earth"), 2) if next_upward(d, "earth") is not None else None),
            "earth_el_min": round(emin, 2) if emin is not None else None,
            "earth_el_max": round(emax, 2) if emax is not None else None,
        }
        d += timedelta(days=1)
    return daily, longest_run("sun")


def main():
    only_smoke = "--smoke" in sys.argv
    os.makedirs(RAW, exist_ok=True)
    jobs = []
    for site in SITES:
        for target in ("sun", "earth"):
            if only_smoke:
                jobs.append((site, target, "smoke", "2027-01-01", "2027-01-08"))
            else:
                for chunk, start, stop in CHUNKS:
                    jobs.append((site, target, chunk, start, stop))
    print(f"{len(jobs)} Horizons calls queued", flush=True)
    results = {}  # (site_id, target) -> merged sorted list
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as ex:
        futs = {ex.submit(horizons_call, s, t, c, a, b): (s["id"], t) for s, t, c, a, b in jobs}
        for fut in as_completed(futs):
            sid, tgt = futs[fut]
            try:
                rows = fut.result()
            except Exception as e:  # noqa: BLE001
                print(f"FAILED {sid}/{tgt}: {e}", flush=True)
                raise
            results.setdefault((sid, tgt), []).append(rows)
            print(f"  ok {sid}/{tgt} ({len(rows)} rows, {time.time()-t0:.0f}s)", flush=True)
    print(f"all calls done in {time.time()-t0:.0f}s", flush=True)

    if only_smoke:
        for (sid, tgt), parts in sorted(results.items()):
            merged = merge(parts)
            print(sid, tgt, "rows:", len(merged), "first:", merged[0], "sample Jan1 00:00:",
                  [r for r in merged if r[0] == datetime(2027, 1, 1, tzinfo=timezone.utc)])
        return

    series = {}
    metrics_daily = {}
    longest = {}
    for site in SITES:
        sid = site["id"]
        hourly = {}
        for tgt in ("sun", "earth"):
            merged = merge(results[(sid, tgt)])
            hourly[tgt] = merged
            # 6-hourly series for the app
            six = [(dt.isoformat(), round(az, 2), round(el, 2))
                   for dt, (az, el) in merged if dt.hour % 6 == 0]
            series.setdefault(sid, {})[tgt] = six
            print(sid, tgt, "hourly rows:", len(merged), "6-hourly rows:", len(six), flush=True)
        daily, long_sun = compute_metrics(hourly)
        metrics_daily[sid] = daily
        longest[sid] = long_sun
        print(sid, "longest sunlit stretch:", long_sun, flush=True)

    with open(os.path.join(DATA, "series.json"), "w") as f:
        json.dump({"generated": datetime.now(timezone.utc).isoformat(),
                   "horizon": "flat (ideal horizon, elevation > 0)",
                   "times_utc": True, "step_hours": 6,
                   "sites": series}, f)
    with open(os.path.join(DATA, "metrics.json"), "w") as f:
        json.dump({"generated": datetime.now(timezone.utc).isoformat(),
                   "horizon": "flat (ideal horizon, elevation > 0)",
                   "lunar_day_days": 29.53,
                   "sites": {s["id"]: {k: v for k, v in s.items() if k != "id"} for s in SITES},
                   "daily": metrics_daily, "longest_sunlit": longest}, f)
    print("wrote data/series.json and data/metrics.json", flush=True)


if __name__ == "__main__":
    main()
