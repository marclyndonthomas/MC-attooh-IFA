import { useState, useEffect, useRef, useCallback } from "react";
import { DNA_MODELS, INFLATION_ASSUMPTION } from "./models/dnaModels";
import { MONARCH_MODELS } from "./models/monarchModels";

const COLORS = { p95: "#8B5CF6", p90: "#378ADD", p50: "#1D9E75", p10: "#D85A30", linear: "#f59e0b" };

function fmt(v) {
  if (v >= 1e6) return "R" + (v / 1e6).toFixed(2) + "M";
  if (v >= 1e3) return "R" + (v / 1e3).toFixed(0) + "k";
  return "R" + Math.round(v);
}

function randn() {
  let u = 0, v = 0;
  while (!u) u = Math.random();
  while (!v) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

let uid = 0;

export default function App() {
  const [init, setInit]               = useState(1000000);
  const [contrib, setContrib]         = useState(0);
  const [contribEsc, setContribEsc]   = useState(0);
  const [withdraw, setWithdraw]       = useState(0);
  const [escMode, setEscMode]         = useState("none");
  const [customEsc, setCustomEsc]     = useState(5);
  const [skipMode, setSkipMode]       = useState("none");
  const [skipEvery, setSkipEvery]     = useState(3);
  const [ret, setRet]                 = useState(8);
  const [vol, setVol]                 = useState(15);
  const [years, setYears]             = useState(20);
  const [sims, setSims]               = useState(2000);
  const [inflation, setInflation]     = useState(5.0);
  const [adviceFee, setAdviceFee]     = useState(0.5);          // %/yr — ongoing advisor fee, deducted from expected return
  const [platformFee, setPlatformFee] = useState(0.5);          // %/yr — LISP/platform/product fee, on top of the model's own cost, deducted from expected return
  const otherFees = adviceFee + platformFee;
  const [modelRange, setModelRange]   = useState("dna");         // "dna" | "monarch" — which preset list is shown
  const [modelKey, setModelKey]       = useState("");            // selected model preset within modelRange ("" = custom)
  const [lumps, setLumps]             = useState([]);
  const [results, setResults]         = useState(null);
  const [chartReady, setChartReady]   = useState(false);
  const c1Ref = useRef(null); const c1Inst = useRef(null);
  const c2Ref = useRef(null); const c2Inst = useRef(null);

  useEffect(() => {
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js";
    s.onload = () => setChartReady(true);
    document.head.appendChild(s);
  }, []);

  const effEsc = escMode === "none" ? 0 : customEsc;
  const wr = init > 0 ? (withdraw * 12 / init * 100) : 0;

  // Model presets — return + volatility linked to the model-portfolio spreadsheet
  // (models/dnaModels.ts + models/monarchModels.ts, regenerated via `npm run sync-models`).
  // Keys are only unique WITHIN a range (e.g. both ranges have an "income" model), so every
  // lookup below is scoped to modelRange — never search across both lists by key alone.
  const modelList = modelRange === "monarch" ? MONARCH_MODELS : DNA_MODELS;

  const applyRange = (range: string) => {
    setModelRange(range);
    setModelKey(""); // switching range always falls back to custom until a new model is picked
  };
  const applyModel = (key: string) => {
    setModelKey(key);
    const m = modelList.find(x => x.key === key);
    if (!m) return;
    setRet(m.nominalReturn);
    setVol(m.vol);
    setInflation(INFLATION_ASSUMPTION);
  };
  const activeModel = modelList.find(x => x.key === modelKey) || null;
  const modelMatches = !!activeModel
    && ret === activeModel.nominalReturn
    && vol === activeModel.vol
    && inflation === INFLATION_ASSUMPTION;

  const runSim = useCallback(() => {
    const months = years * 12;
    const netRet = ret - otherFees; // other fees (advice/platform/etc.) reduce the return actually earned
    const muM = netRet / 100 / 12;
    const sigM = vol / 100 / Math.sqrt(12);
    const N = sims;
    const wEsc = effEsc / 100;
    const cEsc = contribEsc / 100;

    const lumpMap = {};
    lumps.forEach(l => { const k = l.year * 12; lumpMap[k] = (lumpMap[k] || 0) + l.amount; });

    const finals = [], paths = [], wpaths = [];
    let totSkip = 0, totInc = 0;

    for (let s = 0; s < N; s++) {
      // Generate raw monthly returns — each path draws independently, so results
      // carry both mean uncertainty and sequence-of-returns risk.
      const monthlyReturns = Array.from({ length: months }, () => muM + sigM * randn());

      let val = init, curW = withdraw, curC = contrib, yrStart = init;
      const path = [val], wpath = [curW];

      for (let m = 0; m < months; m++) {
        if (m > 0 && m % 12 === 0) {
          const yr = m / 12;
          if (wEsc > 0) {
            const neg = yrStart > 0 && (val - yrStart) / yrStart < 0;
            const skip = skipMode === "negative" ? neg : skipMode === "fixed" ? (yr % skipEvery === 0) : false;
            if (skip) { totSkip++; } else { curW *= (1 + wEsc); totInc++; }
          }
          if (cEsc > 0) curC *= (1 + cEsc);
          yrStart = val;
          wpath.push(curW);
        } else if (m === 0) {
          yrStart = val;
        }
        if (lumpMap[m]) val += lumpMap[m];
        val = val * (1 + monthlyReturns[m]) + curC - curW;
        if (val < 0) val = 0;
        if ((m + 1) % 12 === 0) path.push(val);
      }
      finals.push(val); paths.push(path); wpaths.push(wpath);
    }

    finals.sort((a, b) => a - b);
    const pct = p => finals[Math.floor(p / 100 * N)];

    const p5a = [], p50a = [], p75a = [], p95a = [];
    const w5a = [], w50a = [], w75a = [], w95a = [];

    for (let y = 0; y <= years; y++) {
      const pv = paths.map(p => (typeof p[y] === "number" && !isNaN(p[y])) ? p[y] : 0).sort((a, b) => a - b);
      p5a.push(pv[Math.floor(0.05 * N)]);
      p50a.push(pv[Math.floor(0.50 * N)]);
      p75a.push(pv[Math.floor(0.75 * N)]);
      p95a.push(pv[Math.floor(0.95 * N)]);
      const wv = wpaths.map(p => (p && typeof p[y] === "number" && !isNaN(p[y])) ? p[y] * 12 : (p && p.length ? p[p.length - 1] * 12 : 0)).sort((a, b) => a - b);
      w5a.push(wv[Math.floor(0.05 * N)]);
      w50a.push(wv[Math.floor(0.50 * N)]);
      w75a.push(wv[Math.floor(0.75 * N)]);
      w95a.push(wv[Math.floor(0.95 * N)]);
    }

    // Linear portfolio path
    const linPort = (() => {
      let val = init, curW = withdraw, curC = contrib;
      const path = [val];
      for (let m = 0; m < months; m++) {
        if (m > 0 && m % 12 === 0) {
          const yr = m / 12;
          if (wEsc > 0) {
            const skip = skipMode === "fixed" ? (yr % skipEvery === 0) : false;
            if (!skip) curW *= (1 + wEsc);
          }
          if (cEsc > 0) curC *= (1 + cEsc);
        }
        if (lumpMap[m]) val += lumpMap[m];
        val = val * (1 + muM) + curC - curW;
        if (val < 0) val = 0;
        if ((m + 1) % 12 === 0) path.push(val);
      }
      return path;
    })();

    // Linear withdrawal path
    const linW = (() => {
      let curW = withdraw;
      const path = [curW * 12];
      for (let yr = 1; yr <= years; yr++) {
        const skip = skipMode === "fixed" ? (yr % skipEvery === 0) : false;
        if (!skip && wEsc > 0) curW *= (1 + wEsc);
        path.push(curW * 12);
      }
      return path;
    })();

    // Depletion month/year
    const depletionYearIdx = arr => { for (let y = 0; y < arr.length; y++) { if (arr[y] <= 0) return y; } return null; };
    const now = new Date();
    const baseYear = now.getFullYear(), baseMonth = now.getMonth();
    const monthNames = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const fmtDeplete = yr => {
      if (yr === null) return null;
      const tot = baseMonth + yr * 12;
      return monthNames[tot % 12] + " " + (baseYear + Math.floor(tot / 12));
    };
    const dep = {
      p5: fmtDeplete(depletionYearIdx(p5a)),
      p50: fmtDeplete(depletionYearIdx(p50a)),
      p75: fmtDeplete(depletionYearIdx(p75a)),
      p95: fmtDeplete(depletionYearIdx(p95a)),
      linear: fmtDeplete(depletionYearIdx(linPort)),
    };

    // Real values
    const inflFactor = Math.pow(1 + inflation / 100, years);
    const real = {
      p5: pct(5) / inflFactor,
      p50: pct(50) / inflFactor,
      p75: pct(75) / inflFactor,
      p95: pct(95) / inflFactor,
      linear: linPort[linPort.length - 1] / inflFactor,
    };

    // Implied CAGR
    const cagr = t => (init <= 0 || t <= 0 || years <= 0) ? null : (Math.pow(t / init, 1 / years) - 1) * 100;
    const avgReturn = {
      p5: cagr(pct(5)),
      p50: cagr(pct(50)),
      p75: cagr(pct(75)),
      p95: cagr(pct(95)),
      linear: cagr(linPort[linPort.length - 1]),
    };

    const finalContrib = cEsc > 0 ? contrib * Math.pow(1 + cEsc, years) : contrib;

    setResults({
      p5: pct(5), p50: pct(50), p75: pct(75), p95: pct(95),
      pctSuccess: Math.round(100 * finals.filter(v => v > 1).length / N),
      pctBeat: Math.round(100 * finals.filter(v => v > init).length / N),
      pctRuined: Math.round(100 * finals.filter(v => v === 0).length / N),
      totalIn: init + contrib * 12 * years + lumps.reduce((s, l) => s + l.amount, 0),
      p5a, p50a, p75a, p95a, w5a, w50a, w75a, w95a, linPort, linW, dep, real, avgReturn,
      labels: Array.from({ length: years + 1 }, (_, i) => "Yr " + i),
      avgInc: (totInc / N).toFixed(1), avgSkip: (totSkip / N).toFixed(1), finalContrib,
    });
  }, [init, contrib, contribEsc, withdraw, escMode, customEsc, skipMode, skipEvery, ret, vol, years, sims, effEsc, lumps, inflation, otherFees]);

  useEffect(() => { if (chartReady) runSim(); }, [chartReady]);

  // Portfolio chart
  useEffect(() => {
    if (!chartReady || !results || !c1Ref.current) return;
    if (c1Inst.current) c1Inst.current.destroy();
    const band = results.p75a.map((v, i) => ({ x: results.labels[i], y: [results.p5a[i], v] }));
    const annPlugin = {
      id: "ann", afterDraw(ch) {
        lumps.forEach(({ year, amount }) => {
          const { ctx: c, scales: { x, y } } = ch;
          const xp = x.getPixelForValue(year);
          c.save(); c.beginPath(); c.moveTo(xp, y.top); c.lineTo(xp, y.bottom);
          c.strokeStyle = "rgba(29,158,117,.6)"; c.lineWidth = 1.5; c.setLineDash([4, 3]); c.stroke();
          c.setLineDash([]); c.fillStyle = "rgba(29,158,117,.85)"; c.font = "10px sans-serif";
          c.textAlign = "center"; c.fillText("+" + fmt(amount), xp, y.top + 10); c.restore();
        });
      }
    };
    c1Inst.current = new window.Chart(c1Ref.current.getContext("2d"), {
      type: "bar", data: { labels: results.labels, datasets: [
        { type: "bar",  label: "band",   data: band,            backgroundColor: "rgba(136,135,128,.18)", borderColor: "transparent", barPercentage: 1, categoryPercentage: 1, order: 5 },
        { type: "line", label: "P95",    data: results.p95a,    borderColor: COLORS.p95,    borderWidth: 2,   pointRadius: 0, tension: .4, fill: false, borderDash: [2, 3], order: 1 },
        { type: "line", label: "P75",    data: results.p75a,    borderColor: COLORS.p90,    borderWidth: 2,   pointRadius: 0, tension: .4, fill: false, borderDash: [6, 3], order: 1 },
        { type: "line", label: "P50",    data: results.p50a,    borderColor: COLORS.p50,    borderWidth: 2.5, pointRadius: 0, tension: .4, fill: false, order: 0 },
        { type: "line", label: "P5",     data: results.p5a,     borderColor: COLORS.p10,    borderWidth: 2,   pointRadius: 0, tension: .4, fill: false, borderDash: [4, 4], order: 2 },
        { type: "line", label: "Fixed return", data: results.linPort, borderColor: COLORS.linear, borderWidth: 2,   pointRadius: 0, tension: 0,  fill: false, borderDash: [8, 4], order: 3 },
      ]},
      options: {
        responsive: true, maintainAspectRatio: false, animation: { duration: 350 },
        scales: {
          x: { ticks: { color: "#999", font: { size: 10 }, autoSkip: true, maxTicksLimit: 10 }, grid: { color: "rgba(0,0,0,.05)" } },
          y: { min: 0, ticks: { color: "#999", font: { size: 10 }, callback: v => fmt(v) }, grid: { color: "rgba(0,0,0,.05)" } }
        },
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => { const v = c.raw; return typeof v === "object" && Array.isArray(v.y) ? `Band: ${fmt(v.y[0])}–${fmt(v.y[1])}` : `${c.dataset.label}: ${fmt(v)}`; } } } }
      }, plugins: [annPlugin]
    });
  }, [results, chartReady, lumps]);

  // Withdrawal chart
  useEffect(() => {
    if (!chartReady || !results || !c2Ref.current || withdraw === 0) return;
    if (c2Inst.current) c2Inst.current.destroy();
    const band2 = results.w75a.map((v, i) => ({ x: results.labels[i], y: [results.w5a[i], v] }));
    c2Inst.current = new window.Chart(c2Ref.current.getContext("2d"), {
      type: "bar", data: { labels: results.labels, datasets: [
        { type: "bar",  label: "W-band",   data: band2,           backgroundColor: "rgba(211,90,48,.12)", borderColor: "transparent", barPercentage: 1, categoryPercentage: 1, order: 5 },
        { type: "line", label: "W-P95",    data: results.w95a,    borderColor: COLORS.p95,    borderWidth: 2,   pointRadius: 0, tension: .4, fill: false, borderDash: [2, 3], order: 1 },
        { type: "line", label: "W-P75",    data: results.w75a,    borderColor: COLORS.p90,    borderWidth: 2,   pointRadius: 0, tension: .4, fill: false, borderDash: [6, 3], order: 1 },
        { type: "line", label: "W-P50",    data: results.w50a,    borderColor: COLORS.p50,    borderWidth: 2.5, pointRadius: 0, tension: .4, fill: false, order: 0 },
        { type: "line", label: "W-P5",     data: results.w5a,     borderColor: COLORS.p10,    borderWidth: 2,   pointRadius: 0, tension: .4, fill: false, borderDash: [4, 4], order: 2 },
        { type: "line", label: "Fixed return", data: results.linW,    borderColor: COLORS.linear, borderWidth: 2,   pointRadius: 0, tension: 0,  fill: false, borderDash: [8, 4], order: 3 },
      ]},
      options: {
        responsive: true, maintainAspectRatio: false, animation: { duration: 350 },
        scales: {
          x: { ticks: { color: "#999", font: { size: 10 }, autoSkip: true, maxTicksLimit: 10 }, grid: { color: "rgba(0,0,0,.05)" } },
          y: { min: 0, ticks: { color: "#999", font: { size: 10 }, callback: v => fmt(v) }, grid: { color: "rgba(0,0,0,.05)" } }
        },
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => { const v = c.raw; return typeof v === "object" && Array.isArray(v.y) ? `Band: ${fmt(v.y[0])}–${fmt(v.y[1])}` : `${c.dataset.label}: ${fmt(v)}`; } } } }
      }
    });
  }, [results, chartReady, withdraw]);

  const sRow = (label, min, max, step, val, set, disp, col) => (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
        <span style={{ fontSize: 12, color: "#666" }}>{label}</span>
        <span style={{ fontSize: 12, fontWeight: 600, color: col || "#222" }}>{disp}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={val}
        onChange={e => set(Number(e.target.value))} style={{ width: "100%", accentColor: "#1D9E75" }} />
    </div>
  );

  // Exact-value number box (no slider), for fields advisors need to enter precisely (e.g. for a Record of Advice).
  const sRowN = (label, min, max, step, val, set, prefix, col, suffix) => (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 12, color: "#666", marginBottom: 3 }}>{label}</div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, border: "1px solid #ccc", borderRadius: 6, padding: "4px 8px", background: "#fff" }}>
        {prefix && <span style={{ fontSize: 12, color: col || "#666" }}>{prefix}</span>}
        <input type="number" min={min} max={max} step={step} value={val}
          onChange={e => { const v = e.target.value === "" ? 0 : Number(e.target.value); if (!Number.isNaN(v)) set(v); }}
          onFocus={e => e.target.select()}
          style={{ flex: 1, width: "100%", padding: "3px 0", fontSize: 12, fontWeight: 600, color: col || "#222", border: "none", outline: "none" }} />
        {suffix && <span style={{ fontSize: 12, color: col || "#666" }}>{suffix}</span>}
      </div>
    </div>
  );

  const segRow = (opts, val, set) => (
    <div style={{ display: "flex", borderRadius: 6, overflow: "hidden", border: "1px solid #ddd", marginBottom: 10 }}>
      {opts.map(([k, lbl], i) => (
        <button key={k} onClick={() => set(k)} style={{
          flex: 1, padding: "5px 2px", fontSize: 11, fontWeight: val === k ? 600 : 400,
          background: val === k ? "#1D9E75" : "#fff", color: val === k ? "#fff" : "#555",
          border: "none", borderRight: i < opts.length - 1 ? "1px solid #ddd" : "none", cursor: "pointer"
        }}>{lbl}</button>
      ))}
    </div>
  );

  const hr = <div style={{ borderTop: "1px solid #eee", margin: "10px 0 12px" }} />;
  const secLabel = t => <div style={{ fontSize: 11, fontWeight: 700, color: "#aaa", textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 8 }}>{t}</div>;
  const legend = items => (
    <div style={{ display: "flex", gap: 14, marginBottom: 8, fontSize: 11, color: "#888", flexWrap: "wrap" }}>
      {items.map(([c, l, d]) => (
        <span key={l} style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <span style={{ display: "inline-block", width: 20, height: 2, background: c, opacity: d ? .7 : 1 }} />{l}
        </span>
      ))}
      <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <span style={{ display: "inline-block", width: 12, height: 10, background: "rgba(136,135,128,.2)", borderRadius: 2 }} />band
      </span>
    </div>
  );

  return (
    <div style={{ display: "flex", border: "1px solid #e0e0e0", borderRadius: 12, overflow: "hidden", fontFamily: "system-ui,sans-serif", background: "#fff", minHeight: 500 }}>

      {/* SIDEBAR */}
      <div style={{ width: 256, minWidth: 256, background: "#f8f8f6", borderRight: "1px solid #e0e0e0", padding: "14px 13px", overflowY: "auto", maxHeight: "90vh", flexShrink: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "#333", marginBottom: 12, paddingBottom: 10, borderBottom: "1px solid #e0e0e0" }}>⚙ Parameters</div>

        {secLabel("Portfolio")}
        {sRowN("Starting value (R)", 100000, 200000000, 100000, init, setInit, "R")}
        {sRowN("Monthly contribution (R)", 0, 100000, 500, contrib, setContrib, "R")}
        {sRow("Contribution escalation (%/yr)", 0, 20, 0.5, contribEsc, setContribEsc, contribEsc === 0 ? "None" : contribEsc.toFixed(1) + "%/yr", contribEsc > 0 ? "#1D9E75" : undefined)}
        {contribEsc > 0 && results && <div style={{ fontSize: 11, color: "#1D9E75", marginTop: -8, marginBottom: 10 }}>Yr {years} contribution: {fmt(results.finalContrib)}/mo</div>}

        {hr}
        {secLabel("Withdrawal")}
        {sRowN("Monthly withdrawal (R)", 0, 500000, 1000, withdraw, setWithdraw, "R", withdraw > 0 ? "#D85A30" : undefined)}
        {withdraw > 0 && (
          <div style={{ fontSize: 11, color: "#888", marginTop: -8, marginBottom: 10 }}>
            WR: <strong style={{ color: wr > 5 ? "#D85A30" : wr > 3.5 ? "#BA7517" : "#1D9E75" }}>{wr.toFixed(1)}%/yr</strong>
            {" · "}
            <span style={{ color: (contrib - withdraw) < 0 ? "#D85A30" : "#1D9E75" }}>
              Net: {contrib - withdraw >= 0 ? "+" : "-"}R{Math.abs(contrib - withdraw).toLocaleString()}/mo
            </span>
          </div>
        )}

        <div style={{ fontSize: 11, fontWeight: 600, color: "#555", marginBottom: 6 }}>Annual withdrawal escalation</div>
        {segRow([["none", "None"], ["custom", "Custom %"]], escMode, setEscMode)}
        {escMode === "custom" && sRow("Escalation rate (%)", 0, 20, .5, customEsc, setCustomEsc, customEsc.toFixed(1) + "%", "#D85A30")}

        {escMode !== "none" && (
          <div>
            <div style={{ fontSize: 11, fontWeight: 600, color: "#555", marginBottom: 6 }}>Skip escalation when</div>
            {segRow([["none", "Never"], ["negative", "–ve return"], ["fixed", "Fixed cadence"]], skipMode, setSkipMode)}
            {skipMode === "negative" && <div style={{ fontSize: 11, color: "#993C1D", background: "#fff7ed", border: "1px solid #f5c4b3", borderRadius: 6, padding: "7px 9px", marginBottom: 10 }}>Skips the increase in any year the portfolio return was negative.</div>}
            {skipMode === "fixed" && sRow("Skip every (years)", 1, 10, 1, skipEvery, setSkipEvery, `Every ${skipEvery} yr${skipEvery > 1 ? "s" : ""}`)}
            {results && skipMode !== "none" && <div style={{ fontSize: 11, color: "#888", marginBottom: 8 }}>Avg: <strong>{results.avgInc}</strong> inc · <strong>{results.avgSkip}</strong> skipped/path</div>}
          </div>
        )}

        {hr}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          {secLabel("Capital injections")}
          <button onClick={() => setLumps(l => [...l, { id: uid++, amount: 500000, year: Math.max(1, Math.floor(years / 2)) }])}
            style={{ fontSize: 11, padding: "3px 8px", borderRadius: 5, border: "1px solid #1D9E75", background: "none", color: "#1D9E75", cursor: "pointer", fontWeight: 600, marginTop: -6 }}>+ Add</button>
        </div>
        {lumps.length === 0 && <div style={{ fontSize: 11, color: "#ccc", marginBottom: 8 }}>No injections yet.</div>}
        {lumps.map(l => (
          <div key={l.id} style={{ background: "#fff", border: "1px solid #e8e8e8", borderRadius: 8, padding: "8px 10px", marginBottom: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: "#1D9E75" }}>R{Math.round(l.amount).toLocaleString()} @ Yr {l.year}</span>
              <button onClick={() => setLumps(ls => ls.filter(x => x.id !== l.id))} style={{ background: "none", border: "none", color: "#ccc", fontSize: 16, cursor: "pointer" }}>×</button>
            </div>
            {sRow("Amount", 10000, 20000000, 10000, l.amount, v => setLumps(ls => ls.map(x => x.id === l.id ? { ...x, amount: v } : x)), "R" + Math.round(l.amount).toLocaleString(), "#1D9E75")}
            {sRow("Inject at year", 1, years - 1, 1, l.year, v => setLumps(ls => ls.map(x => x.id === l.id ? { ...x, year: v } : x)), "Yr " + l.year, "#378ADD")}
          </div>
        ))}
        {lumps.length > 0 && <div style={{ fontSize: 11, color: "#888", marginBottom: 8 }}>Total: <strong style={{ color: "#1D9E75" }}>R{lumps.reduce((s, l) => s + l.amount, 0).toLocaleString()}</strong></div>}

        {hr}
        {secLabel("Portfolio return target")}

        {/* Model preset — return + σ linked to the model-portfolio spreadsheet.
            Two ranges (DNA, Monarch); switching range resets the model to custom. */}
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 12, color: "#666", marginBottom: 4 }}>Model range</div>
          <div style={{ display: "flex", borderRadius: 6, overflow: "hidden", border: "1px solid #ddd", marginBottom: 8 }}>
            {[["dna", "DNA"], ["monarch", "Monarch"]].map(([k, lbl], i) => (
              <button key={k} onClick={() => applyRange(k)} style={{
                flex: 1, padding: "5px 2px", fontSize: 12, fontWeight: modelRange === k ? 600 : 400,
                background: modelRange === k ? "#1D9E75" : "#fff", color: modelRange === k ? "#fff" : "#555",
                border: "none", borderRight: i === 0 ? "1px solid #ddd" : "none", cursor: "pointer"
              }}>{lbl}</button>
            ))}
          </div>
          <div style={{ fontSize: 12, color: "#666", marginBottom: 4 }}>Model preset</div>
          <select value={modelKey} onChange={e => applyModel(e.target.value)}
            style={{ width: "100%", padding: "6px 8px", fontSize: 12, borderRadius: 6, border: "1px solid #ddd", background: "#fff", color: "#333", cursor: "pointer" }}>
            <option value="">Custom (manual)</option>
            {modelList.map(m => <option key={m.key} value={m.key}>{m.name.replace(/^(DNA|Monarch Integrate) /, "")}</option>)}
          </select>
          {activeModel && (
            <div style={{ fontSize: 11, color: modelMatches ? "#1D9E75" : "#BA7517", marginTop: 4 }}>
              {modelMatches
                ? (modelRange === "monarch"
                    ? <>Linked to spreadsheet · CPI+{activeModel.cpiPlusTarget}% target · cost {activeModel.totalEffectiveCost}% · σ {activeModel.volPeriod}{!activeModel.reg28 ? " · Reg 28: No" : ""}</>
                    : <>Linked to spreadsheet · CPI+{activeModel.cpiPlusTarget}% target · TER {activeModel.ter}% · σ {activeModel.volPeriod}</>)
                : <>Customised — differs from {activeModel.name.replace(/^(DNA|Monarch Integrate) /, "")}</>}
            </div>
          )}
          {activeModel && (() => {
            const modelCost = modelRange === "monarch" ? activeModel.totalEffectiveCost : activeModel.ter;
            const requiredGross = activeModel.nominalReturn + modelCost;
            return (
              <div style={{ fontSize: 11, color: "#666", marginTop: 3, background: "#f8f8f6", border: "1px solid #eee", borderRadius: 5, padding: "5px 7px" }}>
                To net this category's {activeModel.nominalReturn.toFixed(1)}% target after its own {modelCost.toFixed(2)}% cost, this model needs to earn{" "}
                <strong style={{ color: "#333" }}>{requiredGross.toFixed(2)}%</strong> gross · doesn't include advice/platform fees
              </div>
            );
          })()}
        </div>

        {sRow("Expected return (average %/yr)", 1, 20, .5, ret, setRet, ret.toFixed(1) + "%")}
        {results && results.avgReturn.p50 != null && (
          <div style={{ fontSize: 11, color: "#888", marginTop: -8, marginBottom: 10 }}>
            Typical compound growth ≈ <strong style={{ color: "#1D9E75" }}>{results.avgReturn.p50.toFixed(2)}%</strong> once volatility is allowed for
          </div>
        )}
        {sRow("Annual volatility %", 1, 40, .5, vol, setVol, vol.toFixed(1) + "%")}

        {hr}
        {secLabel("Other fees")}
        <div style={{ fontSize: 11, color: "#888", marginTop: -4, marginBottom: 8 }}>
          Fees not already included in the return above (a model preset's return already nets out that model's own cost). Both are deducted from the expected return before the simulation runs.
        </div>
        {sRowN("Advice fee (%/yr)", 0, 10, .05, adviceFee, setAdviceFee, undefined, adviceFee > 0 ? "#D85A30" : undefined, "%")}
        {sRowN("Platform / product fee (%/yr)", 0, 10, .05, platformFee, setPlatformFee, undefined, platformFee > 0 ? "#D85A30" : undefined, "%")}
        {otherFees > 0 && (
          <div style={{ fontSize: 11, color: "#888", marginTop: -8, marginBottom: 10 }}>
            Net expected return: <strong style={{ color: "#D85A30" }}>{(ret - otherFees).toFixed(2)}%</strong> (was {ret.toFixed(1)}%, total other fees {otherFees.toFixed(2)}%)
          </div>
        )}

        {hr}
        {secLabel("Simulation")}
        {sRow("Time horizon (years)", 5, 40, 1, years, setYears, years + " yrs")}
        {sRow("Simulations", 500, 10000, 500, sims, setSims, sims.toLocaleString())}
        {sRow("Inflation rate (%/yr)", 0, 15, 0.5, inflation, setInflation, inflation.toFixed(1) + "%", "#888")}

        <button onClick={runSim} style={{ width: "100%", marginTop: 4, padding: "9px 0", fontSize: 13, fontWeight: 600, borderRadius: 8, border: "1px solid #ccc", background: "#fff", cursor: "pointer" }}>
          Run simulation ↗
        </button>
      </div>

      {/* MAIN */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, overflowY: "auto" }}>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 16px", borderBottom: "1px solid #eee" }}>
          <span style={{ fontSize: 15, fontWeight: 700 }}>Monte Carlo forecast</span>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <span style={{ fontSize: 11, padding: "3px 8px", borderRadius: 6, background: "#f0f0f0", color: "#555" }}>
              Variable return and sequence risk
            </span>
            {lumps.length > 0 && <span style={{ fontSize: 11, padding: "3px 8px", borderRadius: 6, background: "#e8f7ef", color: "#1a7a4a" }}>{lumps.length} injection{lumps.length > 1 ? "s" : ""}</span>}
            {contribEsc > 0 && <span style={{ fontSize: 11, padding: "3px 8px", borderRadius: 6, background: "#e8f7ef", color: "#1a7a4a" }}>contrib +{contribEsc.toFixed(1)}%/yr</span>}
            {escMode !== "none" && <span style={{ fontSize: 11, padding: "3px 8px", borderRadius: 6, background: "#faece7", color: "#993C1D" }}>withdraw +{effEsc.toFixed(1)}%/yr{skipMode !== "none" ? " · skip" : ""}</span>}
            <span style={{ fontSize: 11, padding: "3px 8px", borderRadius: 6, background: "#e6f1fb", color: "#185FA5" }}>{sims.toLocaleString()} paths · {years} yrs</span>
          </div>
        </div>

        {/* Metric cards */}
        <div style={{ display: "flex", borderBottom: "1px solid #eee", flexWrap: "wrap" }}>
          {[
            ["Median (P50)",      results ? fmt(results.p50) : "—", "50th percentile", COLORS.p50,  results ? results.dep.p50 : null,    results ? results.real.p50 : null,    results ? results.avgReturn.p50 : null],
            ["Optimistic (P75)",  results ? fmt(results.p75) : "—", "75th percentile", COLORS.p90,  results ? results.dep.p75 : null,    results ? results.real.p75 : null,    results ? results.avgReturn.p75 : null],
            ["Best case (P95)",   results ? fmt(results.p95) : "—", "95th percentile", COLORS.p95,  results ? results.dep.p95 : null,    results ? results.real.p95 : null,    results ? results.avgReturn.p95 : null],
            ["Conservative (P5)", results ? fmt(results.p5) : "—",  "5th percentile",  COLORS.p10,  results ? results.dep.p5 : null,     results ? results.real.p5 : null,     results ? results.avgReturn.p5 : null],
            ["Fixed-return projection", results ? fmt(results.linPort ? results.linPort[results.linPort.length - 1] : 0) : "—", "same return every year, no ups and downs", COLORS.linear, results ? results.dep.linear : null, results ? results.real.linear : null, results ? results.avgReturn.linear : null],
          ].map(([label, value, sub, color, depleteAt, realVal, cagr]) => (
            <div key={label} style={{ flex: 1, minWidth: 80, padding: "10px 12px", borderRight: "1px solid #eee" }}>
              <div style={{ fontSize: 11, color: "#999", marginBottom: 3 }}>{label}</div>
              <div style={{ fontSize: 17, fontWeight: 600, color: color || "#111" }}>{value}</div>
              <div style={{ fontSize: 11, color: "#bbb" }}>{sub}</div>
              {cagr != null && <div style={{ fontSize: 11, color: "#888", marginTop: 3 }}>CAGR: <strong style={{ color: cagr >= 0 ? "#1D9E75" : "#D85A30" }}>{cagr.toFixed(2)}%</strong></div>}
              {realVal != null && <div style={{ fontSize: 11, color: "#888", marginTop: 2 }}>Real: <strong style={{ color: "#555" }}>{fmt(realVal)}</strong></div>}
              {depleteAt && <div style={{ fontSize: 11, color: "#D85A30", marginTop: 3, fontWeight: 500 }}>⚠ {depleteAt}</div>}
            </div>
          ))}
          {results && (() => {
            const p = results.pctSuccess, color = p >= 80 ? "#1D9E75" : p >= 60 ? "#BA7517" : "#D85A30";
            const r = 26, circ = 2 * Math.PI * r;
            return (
              <div style={{ padding: "8px 14px", display: "flex", alignItems: "center", gap: 8 }}>
                <svg width={64} height={64} viewBox="0 0 64 64">
                  <circle cx={32} cy={32} r={r} fill="none" stroke="#eee" strokeWidth={7} />
                  <circle cx={32} cy={32} r={r} fill="none" stroke={color} strokeWidth={7}
                    strokeDasharray={`${circ * p / 100} ${circ}`} strokeLinecap="round" transform="rotate(-90 32 32)" />
                  <text x={32} y={36} textAnchor="middle" fontSize={12} fontWeight={600} fill={color}>{p}%</text>
                </svg>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 600, color }}>{p >= 90 ? "Excellent" : p >= 75 ? "Good" : p >= 60 ? "Moderate" : "At risk"}</div>
                  <div style={{ fontSize: 11, color: "#aaa" }}>success rate</div>
                </div>
              </div>
            );
          })()}
        </div>

        {/* Portfolio chart */}
        <div style={{ padding: "12px 16px 14px" }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "#444", marginBottom: 8 }}>Portfolio value</div>
          {legend([[COLORS.p95, "P95 best case", true], [COLORS.p90, "P75 optimistic", true], [COLORS.p50, "P50 median", false], [COLORS.p10, "P5 conservative", true], [COLORS.linear, "Fixed return", true]])}
          <div style={{ position: "relative", height: 220 }}><canvas ref={c1Ref} /></div>
        </div>

        {/* Withdrawal chart */}
        {withdraw > 0 && (
          <div style={{ padding: "12px 16px 14px", borderTop: "1px solid #eee" }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "#444", marginBottom: 8 }}>Annual income withdrawal</div>
            {legend([[COLORS.p95, "P95 best case", true], [COLORS.p90, "P75 optimistic", true], [COLORS.p50, "P50 median", false], [COLORS.p10, "P5 conservative", true], [COLORS.linear, "Fixed return", true]])}
            <div style={{ position: "relative", height: 200 }}><canvas ref={c2Ref} /></div>
          </div>
        )}

        {/* Footer */}
        {results && (
          <div style={{ padding: "8px 16px", borderTop: "1px solid #eee", display: "flex", gap: 16, flexWrap: "wrap", fontSize: 12, color: "#888", marginTop: "auto" }}>
            <span>Beat start: <strong style={{ color: "#222" }}>{results.pctBeat}%</strong></span>
            <span>Total invested: <strong style={{ color: "#222" }}>{fmt(results.totalIn)}</strong></span>
            {withdraw > 0 && results.pctRuined > 0 && <span style={{ color: results.pctRuined > 20 ? "#D85A30" : "#888" }}>Depleted: <strong>{results.pctRuined}%</strong></span>}
          </div>
        )}
      </div>
    </div>
  );
}
