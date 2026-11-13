/* MoonWindow — Lunar Landing Site Navigator (NASA Space Apps 2026)
   Static app. All data precomputed with NASA JPL Horizons (DE441).
   Series: 6-hourly Sun/Earth az/el per site. Metrics: hourly-exact, per day.
   No live API calls, no external dependencies. */
(async function () {
  "use strict";
  const $ = (id) => document.getElementById(id);

  const [sitesDoc, seriesDoc, metricsDoc] = await Promise.all([
    fetch("sites.json").then((r) => r.json()),
    fetch("data/series.json").then((r) => r.json()),
    fetch("data/metrics.json").then((r) => r.json()),
  ]);
  const SITES = sitesDoc.sites;
  const SERIES = seriesDoc.sites;      // site -> {sun:[[iso,az,el]...], earth:[...]}
  const DAILY = metricsDoc.daily;      // site -> {YYYY-MM-DD: {...}}
  const LONGEST = metricsDoc.longest_sunlit;
  const byId = Object.fromEntries(SITES.map((s) => [s.id, s]));

  // ---------- state ----------
  const state = { date: "2027-01-01", hour: 0, sortKey: "daylight_pct", sortDir: -1, A: null, B: null };

  // Default A/B: the two sites with the largest daylight-% contrast on the default date.
  (function pickDefaults() {
    const rows = SITES.map((s) => ({ id: s.id, v: DAILY[s.id]["2027-01-01"].daylight_pct }));
    rows.sort((a, b) => b.v - a.v);
    state.A = rows[0].id;
    state.B = rows[rows.length - 1].id;
  })();

  // ---------- helpers ----------
  function fmtDays(x) {
    if (x === null || x === undefined) return "—";
    if (x === 0) return "now";
    if (x < 1) return "in " + Math.round(x * 24) + " h";
    return "in " + x.toFixed(1) + " d";
  }
  function fmtStretch(L) {
    if (!L || !L.hours) return "—";
    const d = (L.hours / 24).toFixed(1);
    const s = L.start.slice(0, 10), e = L.end.slice(0, 10);
    return d + " d (" + s + " → " + e + ")";
  }
  function interp(track, dateISO, hour) {
    // track: [[iso,az,el],...] 6-hourly. Linear interpolation, azimuth unwrapped.
    const t0 = Date.parse(dateISO + "T00:00:00Z") + hour * 3600 * 1000;
    let i = 0;
    while (i < track.length - 1 && Date.parse(track[i + 1][0]) <= t0) i++;
    if (i >= track.length - 1) return { az: track[track.length - 1][1], el: track[track.length - 1][2] };
    const tA = Date.parse(track[i][0]), tB = Date.parse(track[i + 1][0]);
    const f = (t0 - tA) / (tB - tA);
    let azA = track[i][1], azB = track[i + 1][1];
    while (azB - azA > 180) azB -= 360;
    while (azB - azA < -180) azB += 360;
    let az = azA + f * (azB - azA);
    az = ((az % 360) + 360) % 360;
    return { az, el: track[i][2] + f * (track[i + 1][2] - track[i][2]) };
  }
  function dayTrack(siteId, target, dateISO) {
    // 24 hourly interpolated points for the selected date.
    const pts = [];
    for (let h = 0; h <= 24; h++) pts.push(interp(SERIES[siteId][target], dateISO, h));
    return pts;
  }

  // ---------- compare table ----------
  function renderTable() {
    const tb = document.querySelector("#compare tbody");
    const rows = SITES.map((s) => ({ s, m: DAILY[s.id][state.date] }));
    rows.sort((a, b) => (b.m[state.sortKey] - a.m[state.sortKey]) * (state.sortDir === -1 ? 1 : -1));
    tb.innerHTML = rows.map(({ s, m }) => {
      const hl = (s.id === state.A || s.id === state.B) ? ' class="hl"' : "";
      const elr = (m.earth_el_min === null) ? "—" : m.earth_el_min.toFixed(1) + "° … " + m.earth_el_max.toFixed(1) + "°";
      return "<tr" + hl + "><td><b>" + s.name + "</b><br><span style='color:#9aa3b8'>" + s.lat.toFixed(2) + "°, " + s.lon.toFixed(2) + "°</span></td>"
        + "<td>" + s.mission + "</td>"
        + "<td class='num sun'>" + m.daylight_pct.toFixed(1) + "%</td>"
        + "<td class='num earth'>" + m.earth_pct.toFixed(1) + "%</td>"
        + "<td class='num both'>" + m.both_pct.toFixed(1) + "%</td>"
        + "<td class='num'>" + fmtStretch(LONGEST[s.id]) + "</td>"
        + "<td class='num'>" + fmtDays(m.next_sunrise_days) + "</td>"
        + "<td class='num'>" + fmtDays(m.next_earthrise_days) + "</td>"
        + "<td class='num'>" + elr + "</td></tr>";
    }).join("");
    document.querySelectorAll("#compare th.sortable").forEach((th) => {
      const k = th.dataset.sort;
      th.textContent = (k === "daylight_pct" ? "Daylight %" : "Earth-visible %") + (state.sortKey === k ? (state.sortDir === -1 ? " ▼" : " ▲") : "");
    });
    $("date-note").textContent = "Lunar day runs " + state.date + " → +" + 29.53 + " days. Values are hourly estimates.";
  }
  document.querySelectorAll("#compare th.sortable").forEach((th) => {
    th.addEventListener("click", () => {
      const k = th.dataset.sort;
      if (state.sortKey === k) state.sortDir *= -1; else { state.sortKey = k; state.sortDir = -1; }
      renderTable();
    });
  });

  // ---------- sky plots ----------
  function drawPlot(canvas, siteId, dateISO, hour) {
    const ctx = canvas.getContext("2d");
    const W = canvas.width, H = canvas.height, cx = W / 2, cy = H / 2, R = W / 2 - 14;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#0e1220"; ctx.fillRect(0, 0, W, H);
    const rOf = (el) => R * (90 - el) / 100;   // el 90 -> centre, el 0 -> 0.9R, el -10 -> rim
    const xy = (az, el) => {
      const a = (az * Math.PI) / 180, r = Math.min(rOf(el), R);
      return [cx + r * Math.sin(a), cy - r * Math.cos(a)];
    };
    // rings: el 60, 30, 0 ; spokes every 30 deg
    ctx.strokeStyle = "#2a3049"; ctx.lineWidth = 1;
    [60, 30, 0].forEach((el) => { ctx.beginPath(); ctx.arc(cx, cy, rOf(el), 0, 2 * Math.PI); ctx.stroke(); });
    for (let a = 0; a < 360; a += 30) {
      const [x, y] = xy(a, -10);
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(x, y); ctx.stroke();
    }
    ctx.fillStyle = "#9aa3b8"; ctx.font = "12px system-ui, sans-serif"; ctx.textAlign = "center";
    ctx.fillText("N", cx, 14); ctx.fillText("E", W - 10, cy + 4); ctx.fillText("S", cx, H - 6); ctx.fillText("W", 10, cy + 4);
    ctx.fillText("horizon", cx + rOf(0) * 0.71, cy - rOf(0) * 0.71);
    // tracks
    const tracks = [
      { pts: dayTrack(siteId, "sun", dateISO), color: "#f5c542", label: "Sun" },
      { pts: dayTrack(siteId, "earth", dateISO), color: "#6aa9ff", label: "Earth" },
    ];
    tracks.forEach(({ pts, color }) => {
      ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.beginPath();
      pts.forEach((p, i) => { const [x, y] = xy(p.az, p.el); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      ctx.stroke();
      ctx.fillStyle = color;
      pts.forEach((p) => { const [x, y] = xy(p.az, p.el); ctx.beginPath(); ctx.arc(x, y, 2, 0, 2 * Math.PI); ctx.fill(); });
      // current hour marker
      const cur = pts[hour];
      const [x, y] = xy(cur.az, cur.el);
      ctx.beginPath(); ctx.arc(x, y, 7, 0, 2 * Math.PI); ctx.strokeStyle = "#fff"; ctx.lineWidth = 2; ctx.stroke();
      ctx.beginPath(); ctx.arc(x, y, 4, 0, 2 * Math.PI); ctx.fillStyle = color; ctx.fill();
    });
  }
  function renderPlots() {
    [$("plotA"), $("plotB")].forEach((cv, i) => {
      const id = i === 0 ? state.A : state.B;
      drawPlot(cv, id, state.date, state.hour);
    });
    const mk = (id, el) => {
      const s = interp(SERIES[id].sun, state.date, state.hour);
      const e = interp(SERIES[id].earth, state.date, state.hour);
      el.innerHTML = "At <b>" + String(state.hour).padStart(2, "0") + ":00 UT</b> — "
        + "<span class='sun'>Sun az " + s.az.toFixed(1) + "°, el " + s.el.toFixed(2) + "° (" + (s.el > 0 ? "above" : "below") + " horizon)</span> · "
        + "<span class='earth'>Earth az " + e.az.toFixed(1) + "°, el " + e.el.toFixed(2) + "° (" + (e.el > 0 ? "above" : "below") + " horizon)</span>";
    };
    $("titleA").textContent = byId[state.A].name + " — " + byId[state.A].mission;
    $("titleB").textContent = byId[state.B].name + " — " + byId[state.B].mission;
    mk(state.A, $("readA")); mk(state.B, $("readB"));
  }

  // ---------- ribbons + comparison cards ----------
  function renderRibbons() {
    const wrap = $("ribbons");
    const d0 = new Date(state.date + "T00:00:00Z");
    const dayLabs = [];
    for (let d = 0; d < 7; d++) {
      const dt = new Date(d0.getTime() + d * 86400000);
      dayLabs.push(dt.toISOString().slice(5, 10));
    }
    let html = "<h3>Next 7 days — hourly visibility ribbons (6-hourly samples; the percentages below are hourly-exact)</h3>";
    [state.A, state.B].forEach((id) => {
      const s = byId[id];
      html += "<h3>" + s.name + "</h3>";
      const rows = [
        { lab: "Sun", tgt: "sun", cls: "on-sun" },
        { lab: "Earth", tgt: "earth", cls: "on-earth" },
        { lab: "Both", tgt: null, cls: "on-both" },
      ];
      rows.forEach(({ lab, tgt, cls }) => {
        html += '<div class="ribbon"><span class="rlab">' + lab + '</span>';
        const valAt = (tid, ms) => {
          const tr = SERIES[id][tid];
          // series timestamps are "+00:00" ISO; compare by epoch ms, not string
          let lo = 0, hi = tr.length - 1, found = null;
          while (lo <= hi) { const mid = (lo + hi) >> 1; const m = Date.parse(tr[mid][0]);
            if (m === ms) { found = tr[mid]; break; } else if (m < ms) lo = mid + 1; else hi = mid - 1; }
          return found ? found[2] : null;
        };
        for (let k = 0; k < 28; k++) {
          const ms = d0.getTime() + k * 6 * 3600000;
          const iso = new Date(ms).toISOString();
          let lit;
          if (tgt) { const v = valAt(tgt, ms); lit = v !== null && v > 0; }
          else { const vs = valAt("sun", ms), ve = valAt("earth", ms); lit = vs !== null && ve !== null && vs > 0 && ve > 0; }
          html += '<span class="cell' + (lit ? " " + cls : "") + '" title="' + iso.slice(0, 16).replace("T", " ") + ' UT"></span>';
        }
        html += "</div>";
      });
      html += '<div class="ribbon"><span class="rlab"></span>' + dayLabs.map((d) => '<span class="daylab">' + d + "</span>").join("") + "</div>";
    });
    wrap.innerHTML = html;
    const mA = DAILY[state.A][state.date], mB = DAILY[state.B][state.date];
    $("cards").innerHTML = [state.A, state.B].map((id) => {
      const m = DAILY[id][state.date], s = byId[id];
      return '<div class="card"><h3>' + s.name + ' — next 7 days</h3>'
        + '<p><span class="sun big">' + m.d7_sun_pct.toFixed(0) + '%</span> Sun above horizon &nbsp;'
        + '<span class="earth big">' + m.d7_earth_pct.toFixed(0) + '%</span> Earth above horizon &nbsp;'
        + '<span class="both big">' + m.d7_both_pct.toFixed(0) + '%</span> both</p>'
        + "<p>Over the next lunar day: daylight " + m.daylight_pct.toFixed(1) + "%, Earth-visible " + m.earth_pct.toFixed(1) + "%.</p></div>";
    }).join("");
  }

  // ---------- map ----------
  function renderMap() {
    const cv = $("map"), ctx = cv.getContext("2d");
    const W = cv.width, H = cv.height;
    ctx.fillStyle = "#0e1220"; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = "#232842"; ctx.lineWidth = 1;
    for (let lon = -180; lon <= 180; lon += 30) { const x = (lon + 180) / 360 * W; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
    for (let lat = -90; lat <= 90; lat += 30) { const y = (90 - lat) / 180 * H; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
    ctx.fillStyle = "#9aa3b8"; ctx.font = "12px system-ui, sans-serif";
    ctx.fillText("180°W", 6, 14); ctx.fillText("0°", W / 2 - 6, 14); ctx.fillText("180°E", W - 46, 14);
    ctx.fillText("90°N", 6, H / 2 - 96); ctx.fillText("Equator", 6, H / 2 + 4); ctx.fillText("90°S", 6, H - 8);
    const xy = (s) => [(s.lon + 180) / 360 * W, (90 - s.lat) / 180 * H];
    SITES.forEach((s) => {
      const [x, y] = xy(s);
      const isAB = s.id === state.A || s.id === state.B;
      ctx.beginPath(); ctx.arc(x, y, isAB ? 8 : 6, 0, 2 * Math.PI);
      ctx.fillStyle = isAB ? "#f5c542" : "#6aa9ff"; ctx.fill();
      ctx.strokeStyle = "#0b0e1a"; ctx.lineWidth = 2; ctx.stroke();
      ctx.fillStyle = "#e8ecf4"; ctx.font = (isAB ? "bold " : "") + "13px system-ui, sans-serif"; ctx.textAlign = "left";
      ctx.fillText(s.name, Math.min(x + 10, W - 130), Math.max(y - 8, 14));
    });
    $("map-src").innerHTML = SITES.map((s) => "<b>" + s.name + "</b> " + s.lat.toFixed(2) + "°, " + s.lon.toFixed(2) + "° — " + s.source).join("<br>");
    cv.onclick = (ev) => {
      const r = cv.getBoundingClientRect();
      const mx = (ev.clientX - r.left) * (W / r.width), my = (ev.clientY - r.top) * (H / r.height);
      let best = null, bd = 1e9;
      SITES.forEach((s) => { const [x, y] = xy(s); const d = Math.hypot(x - mx, y - my); if (d < bd) { bd = d; best = s; } });
      if (best && bd < 40) { state.A = best.id; syncSelectors(); renderAll(); }
    };
  }

  // ---------- sources ----------
  $("sources").innerHTML = "<b>Site coordinates:</b><br>" + SITES.map((s) =>
    s.name + " — " + s.lat.toFixed(2) + "°, " + s.lon.toFixed(2) + "° — <a href='" + s.source_url + "' target='_blank' rel='noopener'>" + s.source + "</a>"
  ).join("<br>");

  // ---------- wiring ----------
  function syncSelectors() {
    const opts = SITES.map((s) => '<option value="' + s.id + '">' + s.name + " (" + s.mission + ")</option>").join("");
    $("siteA").innerHTML = opts; $("siteB").innerHTML = opts;
    $("siteA").value = state.A; $("siteB").value = state.B;
  }
  function renderAll() { renderTable(); renderPlots(); renderRibbons(); renderMap(); }
  $("date").addEventListener("change", (e) => { state.date = e.target.value; renderAll(); });
  $("siteA").addEventListener("change", (e) => { state.A = e.target.value; renderAll(); });
  $("siteB").addEventListener("change", (e) => { state.B = e.target.value; renderAll(); });
  $("hour").addEventListener("input", (e) => { state.hour = +e.target.value; $("hour-lab").textContent = String(state.hour).padStart(2, "0") + ":00"; renderPlots(); });

  syncSelectors();
  renderAll();
})();
