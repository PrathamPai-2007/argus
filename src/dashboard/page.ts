// Self-contained dashboard page (Phase 4). No build step, no framework, no external requests.
// "Watchtower radar" aesthetic: a phosphor-green instrument console built around ARGUS —
// the hundred-eyed watchman. Reticle rings, a slow radar sweep on the brand mark, and a
// radial funding-constellation in the token detail view. Zero fonts/assets loaded remotely.

import { PERFORMANCE_STOP_BPS, PERFORMANCE_TARGET_BPS } from "../performance.ts";

const levelsLabel = "+" + ((PERFORMANCE_TARGET_BPS - 10_000) / 100) + "% / -" + ((10_000 - PERFORMANCE_STOP_BPS) / 100) + "%";

export function renderPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="dark" />
<title>ARGUS — real-time on-chain intelligence</title>
<style>
  :root {
    --bg:#04070a; --panel:#0a131c; --panel2:#0e1a26; --line:#16242f; --line2:#1f3342;
    --txt:#dce8ef; --dim:#8fa8b8; --faint:#6a8fa3;
    --acc:#3df8a8; --warn:#ffc24b; --crit:#ff5f5f; --info:#7ab3ff;
    --ok:#3df8a8; --stale:#ffc24b; --err:#ff5f5f;
    --mono:ui-monospace,"Cascadia Mono","SF Mono",Consolas,"Liberation Mono",monospace;
    --r:10px; --r-sm:6px;
    --dur:180ms; --ease:cubic-bezier(.2,.7,.2,1);
    --z-top:100; --z-skip:200;
  }
  * { box-sizing:border-box; margin:0; padding:0; }
  html { scroll-behavior:smooth; }
  body {
    font:13.5px/1.55 var(--mono); color:var(--txt); min-height:100vh; overflow-x:hidden;
    background:var(--bg);
    -webkit-font-smoothing:antialiased;
  }
  body::before {
    content:""; position:fixed; inset:0; z-index:0; pointer-events:none;
    background:
      radial-gradient(900px 420px at 50% -6%, rgba(12,34,46,.9), rgba(4,7,10,0) 60%),
      radial-gradient(1200px 900px at 50% 110%, rgba(10,28,22,.5), rgba(4,7,10,0) 60%);
  }
  body::after {
    content:""; position:fixed; inset:0; z-index:0; pointer-events:none; opacity:.5;
    background-image:
      linear-gradient(rgba(61,248,168,.028) 1px, transparent 1px),
      linear-gradient(90deg, rgba(61,248,168,.028) 1px, transparent 1px);
    background-size:44px 44px;
    -webkit-mask-image:radial-gradient(1000px 620px at 50% 0%, #000 30%, transparent 90%);
            mask-image:radial-gradient(1000px 620px at 50% 0%, #000 30%, transparent 90%);
  }
  .skip { position:absolute; left:10px; top:-48px; z-index:var(--z-skip); background:var(--acc);
    color:#04110b; font-weight:700; padding:10px 14px; border-radius:var(--r-sm); text-decoration:none; }
  .skip:focus { top:10px; }
  .wrap { position:relative; z-index:1; max-width:1500px; margin:0 auto; padding:14px 18px 40px; }

  /* ---------- top bar ---------- */
  .topbar { position:sticky; top:0; z-index:var(--z-top); display:flex; align-items:center; justify-content:space-between;
    gap:14px 22px; flex-wrap:wrap; padding:12px 0 12px; border-bottom:1px solid var(--line);
    background:rgba(4,7,10,.82); -webkit-backdrop-filter:blur(8px); backdrop-filter:blur(8px); }
  .brand { display:flex; align-items:center; gap:14px; }
  .brandmark { width:40px; height:40px; flex:none; }
  .brandmark svg { width:40px; height:40px; display:block; }
  .brandmark .ring { fill:none; stroke:var(--acc); }
  .brandmark .ring.r1 { stroke-width:1.4; }
  .brandmark .ring.r2 { stroke-width:1; opacity:.55; }
  .brandmark .ring.r3 { stroke-width:1; opacity:.3; }
  .brandmark .iris { fill:var(--acc); opacity:.9; }
  .brandmark .pupil { fill:var(--bg); }
  .brandmark .tick { stroke:var(--faint); stroke-width:1; }
  .brandmark .sweep { fill:url(#sweepGrad); animation:sweep 6s linear infinite; }
  @keyframes sweep { to { transform:rotate(360deg); } }
  .brandtext h1 { font-size:22px; letter-spacing:.42em; font-weight:700; color:var(--txt); line-height:1; }
  .brandtext .tag { display:block; margin-top:5px; font-size:10px; letter-spacing:.18em; text-transform:uppercase; color:var(--faint); }
  .metrics { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
  .metric { display:flex; flex-direction:column; align-items:flex-end; background:var(--panel);
    border:1px solid var(--line); border-radius:var(--r-sm); padding:6px 12px 7px; min-width:74px; }
  .metric .mlabel { font-size:9px; letter-spacing:.16em; text-transform:uppercase; color:var(--faint); }
  .metric .mval { font-size:16px; font-weight:700; font-variant-numeric:tabular-nums; color:var(--txt); margin-top:2px; }
  .conn { display:inline-flex; align-items:center; gap:8px; font-size:11px; letter-spacing:.12em;
    text-transform:uppercase; color:var(--dim); padding:9px 12px; border:1px solid var(--line); border-radius:var(--r-sm); }
  .conn .dot { width:8px; height:8px; border-radius:50%; background:var(--faint); flex:none; }
  .conn.live .dot { background:var(--ok); box-shadow:0 0 10px var(--ok); animation:pulse 2.4s ease-in-out infinite; }
  .conn.stale .dot { background:var(--stale); }
  .conn.down .dot { background:var(--err); box-shadow:0 0 10px var(--err); }
  .clock { font-size:11px; color:var(--faint); font-variant-numeric:tabular-nums; letter-spacing:.08em; padding:0 2px; }

  /* ---------- chain rail ---------- */
  .rail { display:flex; flex-wrap:wrap; gap:8px; margin:14px 0 16px; }
  .chip { display:inline-flex; align-items:center; gap:8px; background:var(--panel); border:1px solid var(--line);
    border-radius:var(--r-sm); padding:7px 11px; font-size:11px; color:var(--dim); white-space:nowrap; }
  .chip .dot { width:7px; height:7px; border-radius:50%; background:var(--faint); flex:none; }
  .chip .dot.live { background:var(--ok); animation:pulse 2.4s ease-in-out infinite; }
  .chip .dot.error { background:var(--err); box-shadow:0 0 8px var(--err); }
  .chip .dot.stale, .chip .dot.backfilling, .chip .dot.reconnecting { background:var(--stale); }
  .chip b { color:var(--txt); font-weight:700; }
  .prog { width:64px; height:4px; border-radius:2px; background:var(--line); overflow:hidden; }
  .prog i { display:block; height:100%; background:var(--acc); }
  @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:.35; } }

  /* ---------- layout & panels ---------- */
  .grid { display:grid; grid-template-columns:repeat(12,1fr); gap:14px; }
  .panel { background:linear-gradient(180deg, var(--panel2), var(--panel) 55%); border:1px solid var(--line);
    border-radius:var(--r); box-shadow:0 14px 34px -26px rgba(0,0,0,.9); overflow:hidden; }
  .grid > .panel { grid-column:span 6; }
  .grid > .panel.third { grid-column:span 4; }
  .panel-h { display:flex; align-items:center; gap:10px; padding:12px 16px; border-bottom:1px solid var(--line); }
  .panel-h .ret { width:9px; height:9px; border:1px solid var(--acc); border-radius:2px; transform:rotate(45deg); flex:none; }
  .panel-h h2 { font-size:10px; letter-spacing:.2em; text-transform:uppercase; color:var(--faint); font-weight:600; }
  .panel-h .live-tag { margin-left:auto; font-size:9px; letter-spacing:.18em; text-transform:uppercase; color:var(--acc);
    display:inline-flex; align-items:center; gap:6px; }
  .panel-h .live-tag i { width:6px; height:6px; border-radius:50%; background:var(--acc); animation:pulse 2s ease-in-out infinite; }
  .panel-b { padding:6px 0; }

  /* ---------- table ---------- */
  .tbl { width:100%; border-collapse:collapse; }
  .tbl th { text-align:left; font-size:9px; letter-spacing:.16em; text-transform:uppercase; color:var(--faint);
    font-weight:600; padding:10px 16px; border-bottom:1px solid var(--line); white-space:nowrap; }
  .tbl td { padding:9px 16px; border-bottom:1px solid var(--line); font-size:12px; color:var(--dim); vertical-align:middle; }
  .tbl th.tight, .tbl td.tight { padding-left:8px; padding-right:8px; }
  .tbl tr:last-child td { border-bottom:none; }
  .tbl tbody tr { transition:background var(--dur) var(--ease); }
  .tbl tbody tr:hover { background:rgba(61,248,168,.045); }
  .tbl .num { text-align:right; font-variant-numeric:tabular-nums; }
  .tbl .mono { font-size:11.5px; color:var(--txt); }
  .tbl a { color:var(--acc); text-decoration:none; border-bottom:1px dotted rgba(61,248,168,.4); }
  .tbl a:hover { border-bottom-style:solid; }

  /* ---------- feeds ---------- */
  .feed { max-height:430px; overflow-y:auto; padding:4px 0; }
  .feed::-webkit-scrollbar { width:10px; }
  .feed::-webkit-scrollbar-thumb { background:var(--line); border-radius:5px; border:2px solid var(--panel); }
  .feed::-webkit-scrollbar-track { background:transparent; }
  .evt { display:flex; align-items:baseline; gap:9px; padding:8px 16px; border-bottom:1px solid var(--line); font-size:12px; }
  .evt:last-child { border-bottom:none; }
  .evt .t { color:var(--faint); font-size:11px; font-variant-numeric:tabular-nums; flex:none; white-space:nowrap; }
  .evt .hl { color:var(--txt); }
  .evt a { color:var(--acc); text-decoration:none; border-bottom:1px dotted rgba(61,248,168,.4); }
  .evt a:hover { border-bottom-style:solid; }
  .evt.flash { animation:rise .32s var(--ease) backwards, glow 1.1s ease-out backwards; }
  @keyframes rise { from { opacity:0; transform:translateY(-7px); } to { opacity:1; transform:none; } }
  @keyframes glow { 0% { background:rgba(61,248,168,.14); } 100% { background:transparent; } }

  /* ---------- badges / severity ---------- */
  .badge { display:inline-block; font-size:9px; letter-spacing:.13em; text-transform:uppercase; font-weight:700;
    padding:2px 8px; border-radius:999px; border:1px solid var(--line); color:var(--dim); background:var(--panel2); white-space:nowrap; }
  .badge.alert { color:var(--warn); border-color:rgba(255,194,75,.45); background:rgba(255,194,75,.09); }
  .badge.critical { color:var(--crit); border-color:rgba(255,95,95,.45); background:rgba(255,95,95,.1); }
  .badge.info { color:var(--info); border-color:rgba(122,179,255,.45); background:rgba(122,179,255,.08); }
  .badge.ok { color:var(--acc); border-color:rgba(61,248,168,.45); background:rgba(61,248,168,.08); }
  .badge.target { color:var(--acc); border-color:rgba(61,248,168,.45); background:rgba(61,248,168,.08); }
  .badge.stop { color:var(--crit); border-color:rgba(255,95,95,.45); background:rgba(255,95,95,.1); }
  .badge.expired { color:var(--dim); border-color:var(--line2); background:var(--panel2); }
  .perf-stat { display:flex; gap:18px; flex-wrap:wrap; padding:12px 16px; border-bottom:1px solid var(--line); color:var(--dim); font-size:11px; }
  .perf-stat b { color:var(--txt); font-variant-numeric:tabular-nums; }
  .perf-return.pos { color:var(--acc); }
  .perf-return.neg { color:var(--crit); }
  .perf-note { padding:12px 16px; color:var(--faint); font-size:10px; letter-spacing:.05em; }
  .sev { font-weight:700; text-transform:uppercase; font-size:10px; letter-spacing:.1em; }
  .sev.alert { color:var(--warn); }
  .sev.critical { color:var(--crit); }
  .sev.info { color:var(--info); }
  .live { color:var(--ok); }
  .stale, .backfilling, .reconnecting { color:var(--stale); }
  .error { color:var(--err); }
  .muted { color:var(--dim); }
  .faint { color:var(--faint); }

  /* ---------- buttons ---------- */
  .btn { display:inline-flex; align-items:center; gap:8px; min-height:44px; padding:0 16px; background:var(--panel2);
    color:var(--txt); border:1px solid var(--line2); border-radius:var(--r-sm); font:12px var(--mono); letter-spacing:.08em;
    cursor:pointer; transition:background var(--dur) var(--ease), border-color var(--dur) var(--ease), color var(--dur) var(--ease); }
  .btn:hover { background:var(--line); border-color:var(--acc); color:var(--acc); }
  .btn:active { transform:translateY(1px); }
  :focus-visible { outline:2px solid var(--acc); outline-offset:2px; border-radius:4px; }

  /* ---------- token detail ---------- */
  .toolbar { display:flex; align-items:center; gap:16px; margin-bottom:16px; flex-wrap:wrap; }
  .tokenhead { display:flex; align-items:center; gap:12px; }
  .tokenhead h2 { font-size:13px; letter-spacing:.24em; text-transform:uppercase; color:var(--txt); font-weight:700; }
  .detail-grid { display:grid; grid-template-columns:repeat(12,1fr); gap:14px; margin-top:14px; }
  .detail-grid > .panel { grid-column:span 6; }
  .detail-grid > .panel.third { grid-column:span 4; }
  .cards { display:grid; grid-template-columns:repeat(2,1fr); gap:10px; padding:14px; }
  .card { background:var(--panel2); border:1px solid var(--line); border-radius:var(--r-sm); padding:11px 13px; }
  .card .k { font-size:9px; letter-spacing:.16em; text-transform:uppercase; color:var(--faint); }
  .card .v { margin-top:5px; font-size:12.5px; color:var(--txt); font-variant-numeric:tabular-nums; word-break:break-all; }
  .card .v.acc { color:var(--acc); font-weight:700; font-size:14px; }

  /* ---------- constellation ---------- */
  .cy { background:
      radial-gradient(circle at 50% 50%, rgba(61,248,168,.07), transparent 58%),
      linear-gradient(180deg, var(--panel2), var(--panel) 60%); }
  .cy svg { display:block; width:100%; height:auto; }
  .cy .gr { fill:none; stroke:rgba(122,179,255,.09); }
  .cy .ret { fill:none; stroke:rgba(61,248,168,.16); }
  .cy .ed { fill:none; stroke:rgba(61,248,168,.32); stroke-width:1.3; }
  .cy .ed.core { stroke:rgba(61,248,168,.75); stroke-width:1.6; }
  .cy .nd { fill:var(--panel); stroke:var(--acc); stroke-width:1.6; }
  .cy .nd.root { fill:var(--acc); stroke:#04110b; stroke-width:1.4; }
  .cy .lb { fill:var(--faint); font-size:8.5px; font-family:var(--mono); letter-spacing:.03em; }
  .cy-legend { display:flex; gap:18px; flex-wrap:wrap; padding:12px 16px; border-top:1px solid var(--line);
    font-size:10px; color:var(--faint); letter-spacing:.06em; }
  .cy-legend .k { display:inline-flex; align-items:center; gap:7px; }
  .cy-legend .sw { width:9px; height:9px; border-radius:50%; flex:none; }
  .cy-empty { display:flex; flex-direction:column; gap:8px; align-items:center; justify-content:center;
    min-height:220px; color:var(--faint); font-size:12px; text-align:center; padding:24px; }

  /* ---------- concentration ---------- */
  .conc { padding:14px 16px 6px; }
  .barstack { display:flex; height:16px; border-radius:4px; overflow:hidden; background:var(--line); margin-top:10px; }
  .barstack i { display:block; height:100%; }
  .conc-row { display:flex; justify-content:space-between; align-items:baseline; gap:12px; padding:7px 0;
    font-size:11.5px; color:var(--dim); border-bottom:1px solid var(--line); }
  .conc-row:last-child { border-bottom:none; }
  .conc-row .c { display:inline-flex; align-items:center; gap:8px; }
  .conc-row .sw { width:9px; height:9px; border-radius:2px; flex:none; }
  .conc-row b { color:var(--txt); font-weight:700; font-variant-numeric:tabular-nums; }

  /* ---------- entrance stagger ---------- */
  .reveal > .panel { animation:rise .5s var(--ease) backwards; }
  .reveal > .panel:nth-child(1) { animation-delay:.04s; }
  .reveal > .panel:nth-child(2) { animation-delay:.09s; }
  .reveal > .panel:nth-child(3) { animation-delay:.14s; }
  .reveal > .panel:nth-child(4) { animation-delay:.19s; }
  .reveal > .panel:nth-child(5) { animation-delay:.24s; }
  .reveal > .panel:nth-child(6) { animation-delay:.29s; }
  .toolbar { animation:rise .4s var(--ease) backwards; }

  /* ---------- responsive ---------- */
  @media (max-width:1100px) {
    .grid > .panel, .grid > .panel.third { grid-column:span 12; }
    .detail-grid > .panel, .detail-grid > .panel.third { grid-column:span 12; }
  }
  @media (max-width:640px) {
    .wrap { padding:10px 12px 28px; }
    .cards { grid-template-columns:1fr; }
    .metric { min-width:0; flex:1 1 0; align-items:flex-start; }
    .metrics { width:100%; }
  }

  /* ---------- reduced motion ---------- */
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation-duration:.01ms !important; animation-iteration-count:1 !important;
      transition-duration:.01ms !important; }
    html { scroll-behavior:auto; }
  }
</style>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<div class="wrap">
  <header class="topbar">
    <div class="brand">
      <div class="brandmark" aria-hidden="true">
        <svg viewBox="0 0 40 40">
          <defs>
            <radialGradient id="sweepGrad" cx="20" cy="20" r="19" gradientUnits="userSpaceOnUse">
              <stop offset="0" stop-color="#3df8a8" stop-opacity=".34"/>
              <stop offset=".55" stop-color="#3df8a8" stop-opacity=".05"/>
              <stop offset="1" stop-color="#3df8a8" stop-opacity="0"/>
            </radialGradient>
          </defs>
          <g class="sweep"><path d="M20 20 L20 1.5 A18.5 18.5 0 0 1 33.2 6.8 Z"/></g>
          <circle class="ring r3" cx="20" cy="20" r="18"/>
          <circle class="ring r2" cx="20" cy="20" r="12"/>
          <circle class="ring r1" cx="20" cy="20" r="6"/>
          <circle class="iris" cx="20" cy="20" r="3.4"/>
          <circle class="pupil" cx="20" cy="20" r="1.4"/>
          <path class="tick" d="M20 0.5 V3 M20 37 V39.5 M0.5 20 H3 M37 20 H39.5"/>
        </svg>
      </div>
      <div class="brandtext">
        <h1>ARGUS</h1>
        <span class="tag">real-time on-chain intelligence</span>
      </div>
    </div>
    <div class="metrics">
      <div class="metric"><span class="mlabel">tokens</span><span class="mval" id="cntTokens">—</span></div>
      <div class="metric"><span class="mlabel">alerts</span><span class="mval" id="cntAlerts">—</span></div>
       <div class="metric"><span class="mlabel">signals</span><span class="mval" id="cntSignals">—</span></div>
       <div class="metric"><span class="mlabel">events</span><span class="mval" id="cntEvents">—</span></div>
       <div class="metric"><span class="mlabel">watches</span><span class="mval" id="cntWatches">—</span></div>
       <span class="conn" id="conn" role="status"><span class="dot" aria-hidden="true"></span><span id="connTxt">connecting…</span></span>
      <span class="clock" id="clock" aria-hidden="true"></span>
    </div>
  </header>

  <nav class="rail" id="chainbar" aria-label="Chain status"></nav>

  <main id="main">
    <section id="mainView">
      <div class="grid reveal">
        <div class="panel third">
          <div class="panel-h"><span class="ret" aria-hidden="true"></span><h2>Watched tokens</h2></div>
          <table class="tbl" id="toktab">
            <thead><tr><th>Token</th><th class="num tight">Supply</th><th class="tight">Last alert</th></tr></thead>
            <tbody></tbody>
          </table>
        </div>

        <div class="panel third">
          <div class="panel-h"><span class="ret" aria-hidden="true"></span><h2>Live alerts</h2>
            <span class="live-tag"><i aria-hidden="true"></i>stream</span></div>
          <div class="feed" id="alerts" aria-live="polite" aria-label="Live alerts"></div>
        </div>

        <div class="panel third">
          <div class="panel-h"><span class="ret" aria-hidden="true"></span><h2>Alert performance</h2>
            <span class="live-tag"><i aria-hidden="true"></i>12h watch</span></div>
          <div id="performance" aria-live="polite"></div>
        </div>

        <div class="panel">
          <div class="panel-h"><span class="ret" aria-hidden="true"></span><h2>Recent signals</h2></div>
          <div class="feed" id="signals" aria-label="Recent signals"></div>
        </div>

        <div class="panel">
          <div class="panel-h"><span class="ret" aria-hidden="true"></span><h2>Recent events</h2></div>
          <div class="feed" id="events" aria-label="Recent events"></div>
        </div>
      </div>
    </section>

    <section id="tokenView" hidden>
      <div class="toolbar">
        <button class="btn" id="backBtn" type="button"><span aria-hidden="true">&#8592;</span> Overview</button>
        <div class="tokenhead"><h2 id="tokenHeader">Token</h2></div>
      </div>

      <div class="detail-grid reveal">
        <div class="panel">
          <div class="panel-h"><span class="ret" aria-hidden="true"></span><h2>Metadata</h2></div>
          <div class="cards" id="tokenMeta"></div>
        </div>

        <div class="panel">
          <div class="panel-h"><span class="ret" aria-hidden="true"></span><h2>Alert performance</h2></div>
          <div id="tokenPerformance"></div>
        </div>

        <div class="panel cy">
          <div class="panel-h"><span class="ret" aria-hidden="true"></span><h2>Funding constellation</h2></div>
          <div id="tokenConstellation"></div>
        </div>

        <div class="panel">
          <div class="panel-h"><span class="ret" aria-hidden="true"></span><h2>Supply concentration</h2></div>
          <div id="tokenConcentration" class="conc"></div>
        </div>

        <div class="panel">
          <div class="panel-h"><span class="ret" aria-hidden="true"></span><h2>Cluster members</h2></div>
          <div id="tokenMembers"></div>
        </div>

        <div class="panel third">
          <div class="panel-h"><span class="ret" aria-hidden="true"></span><h2>Liquidity pools</h2></div>
          <div id="tokenPools"></div>
        </div>

        <div class="panel third">
          <div class="panel-h"><span class="ret" aria-hidden="true"></span><h2>Alert history</h2></div>
          <div class="feed" id="tokenAlerts"></div>
        </div>

        <div class="panel third">
          <div class="panel-h"><span class="ret" aria-hidden="true"></span><h2>Signal history</h2></div>
          <div class="feed" id="tokenSignals"></div>
        </div>
      </div>
    </section>
  </main>
</div>

<script>
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]));
const short = (a) => (a ? a.slice(0, 6) + "…" + a.slice(-4) : "");
const sevClass = (s) => (s === "critical" ? "sev critical" : s === "alert" ? "sev alert" : "sev info");
const badgeClass = (s) => (s === "critical" ? "badge critical" : s === "alert" ? "badge alert" : "badge info");
const statusClass = (s) => (s === "live" ? "live" : s === "error" ? "error" : "stale backfilling reconnecting".includes(s) ? "stale" : "");
const PALETTE = ["#3df8a8", "#7ab3ff", "#ffc24b", "#ff7aa8", "#b28aff", "#5ad8d8"];

function fmtSupply(v) {
  if (v === null || v === undefined || v === "") return "—";
  try {
    const s = String(v);
    const n = Number(s);
    if (isNaN(n)) return esc(s);
    if (n >= 1e15) return (n / 1e15).toFixed(2) + "T";
    if (n >= 1e12) return (n / 1e12).toFixed(2) + "B";
    if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
    if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
    return n.toLocaleString();
  } catch { return esc(v); }
}

function fmtPrice(v) {
  if (v === null || v === undefined) return "—";
  const n = Number(v) / 1e18;
  if (!isFinite(n) || n <= 0) return "—";
  if (n >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (n >= 1) return n.toFixed(4);
  return n.toPrecision(5);
}

function returnPct(s) {
  const entry = Number(s.entry_price);
  const current = Number(s.current_price);
  return entry > 0 && isFinite(entry) && isFinite(current) ? ((current - entry) / entry) * 100 : null;
}

function outcomeBadge(outcome, compact) {
  if (compact) {
    if (outcome === "target_hit") return '<span class="badge target">TP</span>';
    if (outcome === "stop_hit") return '<span class="badge stop">SL</span>';
    return '<span class="faint">—</span>';
  }
  const cls = outcome === "target_hit" ? "target" : outcome === "stop_hit" ? "stop" : outcome === "expired" ? "expired" : outcome === "active" ? "ok" : "";
  const text = outcome === "target_hit" ? "target" : outcome === "stop_hit" ? "stop" : outcome === "expired" ? "expired" : outcome === "active" ? "watching" : outcome;
  return '<span class="badge ' + cls + '">' + esc(text) + "</span>";
}

const levelsLabel = "+50% / -20%";

function renderPerformance(sessions, container) {
  const rows = sessions || [];
  const active = rows.filter((s) => s.outcome === "active").length;
  const targets = rows.filter((s) => s.outcome === "target_hit").length;
  const stops = rows.filter((s) => s.outcome === "stop_hit").length;
  $("cntWatches").textContent = active;
  if (rows.length === 0) {
    container.innerHTML = '<div class="perf-note">No alert outcomes yet. Confirmed alerts with a valid pool swap price open a 12-hour watch.</div>';
    return;
  }
  const stats = '<div class="perf-stat"><span>active <b>' + active + '</b></span><span>targets <b class="live">' + targets + '</b></span><span>stops <b class="error">' + stops + '</b></span><span>window <b>12h</b></span><span>levels <b>' + levelsLabel + '</b></span></div>';
  const body = rows.slice(0, 20).map((s) => {
    const pct = returnPct(s);
    const cls = pct === null ? "" : pct >= 0 ? "pos" : "neg";
    const time = s.outcome === "active" ? Math.max(0, s.expires_at - Math.floor(Date.now() / 1000)) : 0;
    const remaining = time > 0 ? Math.floor(time / 3600) + "h " + Math.floor((time % 3600) / 60) + "m" : "—";
    return '<tr><td>' + tokenLink(s.chain_id, s.token_address) + '</td>' +
      '<td class="tight">' + outcomeBadge(s.outcome, true) + '</td>' +
      '<td class="num tight ' + cls + '">' + (pct === null ? "—" : (pct >= 0 ? "+" : "") + pct.toFixed(2) + "%") + '</td>' +
      '<td class="num tight">' + (s.outcome === "active" ? remaining : timeAgo(s.closed_at)) + '</td></tr>';
  }).join("");
  container.innerHTML = stats + '<div class="panel-b"><table class="tbl"><thead><tr><th>Token</th><th class="tight">Outcome</th><th class="num tight">Return</th><th class="num tight">Time</th></tr></thead><tbody>' + body + '</tbody></table></div>';
}

function renderTokenPerformance(sessions) {
  const el = $("tokenPerformance");
  const rows = sessions || [];
  if (rows.length === 0) {
    el.innerHTML = '<div class="perf-note">No performance session for this token yet.</div>';
    return;
  }
  const s = rows[0];
  const pct = returnPct(s);
  const cls = pct === null ? "" : pct >= 0 ? "pos" : "neg";
  const remaining = s.outcome === "active" ? Math.max(0, s.expires_at - Math.floor(Date.now() / 1000)) : 0;
  el.innerHTML = '<div class="cards">' +
    '<div class="card"><div class="k">Status</div><div class="v">' + outcomeBadge(s.outcome) + '</div></div>' +
    '<div class="card"><div class="k">Return</div><div class="v ' + (cls ? 'perf-return ' + cls : '') + '">' + (pct === null ? "—" : (pct >= 0 ? "+" : "") + pct.toFixed(2) + "%") + '</div></div>' +
    '<div class="card"><div class="k">Entry price</div><div class="v">' + fmtPrice(s.entry_price) + '</div></div>' +
    '<div class="card"><div class="k">Current price</div><div class="v">' + fmtPrice(s.current_price) + '</div></div>' +
    '<div class="card"><div class="k">Target / stop</div><div class="v">' + levelsLabel + '</div></div>' +
    '<div class="card"><div class="k">Time remaining</div><div class="v">' + (s.outcome === "active" ? Math.floor(remaining / 3600) + "h " + Math.floor((remaining % 3600) / 60) + "m" : timeAgo(s.closed_at)) + '</div></div>' +
    '</div><div class="perf-note">Pool-relative observation. This is an alert outcome journal, not an executed trade.</div>';
}

function timeAgo(sec) {
  if (sec === null || sec === undefined) return "—";
  const d = Math.floor(Date.now() / 1000) - sec;
  if (d < 5) return "now";
  if (d < 60) return d + "s";
  if (d < 3600) return Math.floor(d / 60) + "m";
  if (d < 86400) return Math.floor(d / 3600) + "h";
  return Math.floor(d / 86400) + "d";
}

function tokenLink(chainId, address) {
  return "<a href='#/token/" + esc(chainId) + "/" + esc(address) + "'>" + esc(short(address)) + "</a>";
}

function setConn(state, txt) {
  const c = $("conn");
  c.className = "conn " + state;
  $("connTxt").textContent = txt;
}

function renderChains(status) {
  const rail = $("chainbar");
  rail.innerHTML = "";
  const chains = (status && status.chains) || {};
  for (const [id, c] of Object.entries(chains)) {
    let headInfo = "head " + (c.lastHead || 0);
    let prog = "";
    if (c.status === "backfilling" && c.backfill && c.backfill.progress !== undefined) {
      headInfo = "backfill " + c.backfill.from + "&#8594;" + c.backfill.to;
      prog = '<span class="prog" aria-hidden="true"><i style="width:' + Math.min(100, c.backfill.progress) + '%"></i></span>';
    }
    const host = (c.endpoint || "").replace("wss://", "").replace("ws://", "").split("/")[0];
    const dot = '<span class="dot ' + esc(c.status) + '" aria-hidden="true"></span>';
    rail.innerHTML += '<span class="chip">' + dot + " chain <b>" + id + "</b> &middot; " + esc(headInfo) +
      prog + " &middot; <span class='faint'>" + esc(host || "") + "</span>" +
      (c.queueDepth !== undefined ? " &middot; q" + c.queueDepth : "") +
      " &middot; <span class='faint'>" + (c.eventsApplied || 0) + " evts</span></span>";
  }
  rail.innerHTML += '<span class="chip"><span class="dot" aria-hidden="true"></span>wallets <b>' + (status ? (status.wallets || 0) : 0) + "</b></span>";
}

function renderTokens(tokens) {
  $("cntTokens").textContent = tokens.length;
  const tb = $("toktab").querySelector("tbody");
  if (!tokens || tokens.length === 0) {
    tb.innerHTML = '<tr><td colspan="3" class="muted">No watched tokens yet</td></tr>';
    return;
  }
  tb.innerHTML = tokens.map((t) => {
    const a = t.lastAlert;
    let sev = null;
    if (a && a.payload_json) {
      try { sev = JSON.parse(a.payload_json).severity; } catch {}
    }
    return "<tr>" +
      "<td>" + tokenLink(t.chainId, t.address) + "</td>" +
      '<td class="num tight">' + fmtSupply(t.totalSupply) + "</td>" +
      '<td class="tight">' + (sev ? '<span class="' + badgeClass(sev) + '">' + esc(sev) + "</span>" : '<span class="faint">—</span>') + "</td></tr>";
  }).join("");
}

function renderAlerts(alerts) {
  $("cntAlerts").textContent = alerts.length;
  $("alerts").innerHTML = alerts.slice(0, 40).map((a) => {
    let p = {};
    try { p = JSON.parse(a.payload_json); } catch {}
    return '<div class="evt"><span class="t">' + timeAgo(a.created_at) + "</span> " +
      '<span class="' + sevClass(a.severity) + '">' + esc(a.severity) + "</span> " +
      tokenLink(a.chain_id || 1, a.token_address) + ' <span class="hl">' + esc(p.headline || "alert") + "</span>" +
      '<span class="faint">(' + a.score + ")</span>" +
      (a.confirmed ? "" : ' <span class="badge">unconfirmed</span>') + "</div>";
  }).join("") || '<div class="evt faint">no alerts yet</div>';
}

function renderSignals(signals) {
  $("cntSignals").textContent = signals.length;
  $("signals").innerHTML = signals.slice(0, 40).map((s) => {
    return '<div class="evt"><span class="t">' + timeAgo(s.timestamp) + "</span> " +
      '<span class="badge">' + esc(s.ruleId || s.rule_id) + "</span> " +
      tokenLink(s.chainId || s.chain_id || 1, s.tokenAddress || s.token_address) +
      '<span class="faint">w' + (s.weight || 0) + " &middot; b" + (s.blockNumber || s.block_number || 0) + "</span></div>";
  }).join("") || '<div class="evt faint">no signals yet</div>';
}

function renderEvents(events) {
  $("cntEvents").textContent = events.length;
  $("events").innerHTML = events.slice(0, 40).map((e) => {
    return '<div class="evt"><span class="t">b' + (e.block_number || e.blockNumber || 0) + "</span> " +
      '<span class="badge">' + esc(e.type || e.kind) + "</span> " +
      '<span class="mono hl">' + short(e.tx_hash || e.txHash) + "</span>" +
      (e.finalized === 1 ? "" : ' <span class="badge">unfinalized</span>') + "</div>";
  }).join("") || '<div class="evt faint">no events yet</div>';
}

async function refresh() {
  try {
    const [status, tokens, alerts, signals, events, performance] = await Promise.all([
      fetch("/api/status").then((r) => r.json()),
      fetch("/api/tokens").then((r) => r.json()),
      fetch("/api/alerts").then((r) => r.json()),
      fetch("/api/signals").then((r) => r.json()),
      fetch("/api/events/recent").then((r) => r.json()),
      fetch("/api/performance?limit=100").then((r) => r.json()),
    ]);
    renderChains(status); renderTokens(tokens); renderAlerts(alerts); renderSignals(signals); renderEvents(events); renderPerformance(performance, $("performance"));
    setConn("live", "engine: online");
  } catch {
    setConn("down", "engine: offline");
    $("chainbar").innerHTML = '<span class="chip"><span class="dot error" aria-hidden="true"></span>engine offline — API unreachable</span>';
  }
}

/* ---------- token detail ---------- */

function renderMeta(data, graph) {
  const t = data.token || { address: data.address, chainId: data.chainId, symbol: "—", totalSupply: null, source: "manual" };
  $("tokenHeader").textContent = "Token " + short(t.address) + " &middot; chain " + (t.chainId || data.chainId);
  const lastAlert = (data.alerts && data.alerts[0]);
  let sev = null;
  if (lastAlert) {
    try { sev = JSON.parse(lastAlert.payload_json).severity; } catch {}
  }
  $("tokenMeta").innerHTML =
    '<div class="card"><div class="k">Address</div><div class="v">' + esc(t.address) + "</div></div>" +
    '<div class="card"><div class="k">Symbol</div><div class="v acc">' + esc(t.symbol || "—") + "</div></div>" +
    '<div class="card"><div class="k">Total supply</div><div class="v">' + fmtSupply(t.totalSupply) + "</div></div>" +
    '<div class="card"><div class="k">Circulating</div><div class="v">' + (graph && graph.circulatingSupply !== null && graph.circulatingSupply !== undefined ? fmtSupply(graph.circulatingSupply) : "—") + "</div></div>" +
    '<div class="card"><div class="k">Decimals</div><div class="v">' + esc((graph && graph.decimals) ?? t.decimals ?? "—") + "</div></div>" +
    '<div class="card"><div class="k">Source</div><div class="v"><span class="badge">' + esc(t.source || "manual") + "</span></div></div>" +
    '<div class="card"><div class="k">Last alert</div><div class="v">' + (sev ? '<span class="' + badgeClass(sev) + '">' + esc(sev) + "</span>" : '<span class="faint">—</span>') + "</div></div>";
}

function renderPools(data) {
  const pools = data.pools || [];
  if (pools.length === 0) {
    $("tokenPools").innerHTML = '<div class="cy-empty">No pools registered for this token</div>';
    return;
  }
  $("tokenPools").innerHTML = '<table class="tbl"><thead><tr><th>Pool</th><th>Quote token</th><th>Factory</th></tr></thead><tbody>' +
    pools.map((p) => '<tr><td class="mono">' + short(p.pool_address) + "</td><td class='mono'>" + (p.quote_token ? short(p.quote_token) : "—") + '</td><td><span class="badge">' + esc(p.factory) + "</span></td></tr>").join("") +
    "</tbody></table>";
}

function renderConstellation(graph) {
  const el = $("tokenConstellation");
  const clusters = (graph && graph.clusters) || [];
  if (clusters.length === 0) {
    el.innerHTML = '<div class="cy-empty">No clusters tracked for this token yet<br/><span class="faint">clusters form once wallets accumulate from a shared funder</span></div>';
    return;
  }
  const hero = clusters.slice().sort((a, b) => b.pctOfSupply - a.pctOfSupply)[0];
  const members = hero.members || [];
  const totalSupply = Number(graph.totalSupply);
  const nodeSet = new Set(members.map((m) => m.address));
  const edges = (graph.funding || []).filter((e) => nodeSet.has(e.funder) && nodeSet.has(e.funded));

  const adj = {}; const indeg = {};
  for (const e of edges) {
    (adj[e.funder] = adj[e.funder] || []).push(e.funded);
    indeg[e.funded] = (indeg[e.funded] || 0) + 1;
  }
  let roots = members.map((m) => m.address).filter((n) => !indeg[n]);
  if (roots.length === 0 && members.length > 0) roots = [members[0].address];

  const depth = {}; const queue = [];
  for (const r of roots) { depth[r] = 0; queue.push(r); }
  while (queue.length) {
    const n = queue.shift();
    for (const c of (adj[n] || [])) {
      if (depth[c] === undefined) { depth[c] = depth[n] + 1; queue.push(c); }
    }
  }
  const maxDepth = members.reduce((mx, m) => Math.max(mx, depth[m.address] ?? 0), 0);
  const cx = 280, cy = 280, R = 236;
  const ringByDepth = {};
  for (const m of members) {
    const d = depth[m.address] ?? 0;
    (ringByDepth[d] = ringByDepth[d] || []).push(m);
  }
  const maxBal = members.reduce((mx, m) => Math.max(mx, Number(m.balance) || 0), 1);
  const pos = {};
  for (const dStr of Object.keys(ringByDepth)) {
    const d = Number(dStr);
    const list = ringByDepth[d];
    const r = 36 + d * ((R - 40) / Math.max(1, maxDepth));
    const n = list.length;
    const off = (d % 2) ? Math.PI / Math.max(n, 1) : 0;
    list.forEach((m, i) => {
      const a = -Math.PI / 2 + (i / n) * 2 * Math.PI + off;
      const b = Number(m.balance) || 0;
      const pr = Math.min(17, Math.max(6, 6 + 9 * Math.sqrt(b / maxBal)));
      pos[m.address] = { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r, r: pr, m, d };
    });
  }
  const edgePath = (e) => {
    const a = pos[e.funder], b = pos[e.funded];
    if (!a || !b) return "";
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const dx = b.x - a.x, dy = b.y - a.y;
    const L = Math.hypot(dx, dy) || 1;
    const f = 0.16 * Math.min(L, 140);
    const ox = (-dy / L) * f, oy = (dx / L) * f;
    return "M" + a.x.toFixed(1) + " " + a.y.toFixed(1) + " Q" + (mx + ox).toFixed(1) + " " + (my + oy).toFixed(1) + " " + b.x.toFixed(1) + " " + b.y.toFixed(1);
  };

  let svg = "";
  for (let r = 0; r < 3; r++) {
    const rad = R * (r + 1) / 3;
    svg += '<circle class="gr" cx="' + cx + '" cy="' + cy + '" r="' + rad.toFixed(1) + '"/>';
  }
  svg += '<line class="gr" x1="' + (cx - R) + '" y1="' + cy + '" x2="' + (cx + R) + '" y2="' + cy + '"/>' +
         '<line class="gr" x1="' + cx + '" y1="' + (cy - R) + '" x2="' + cx + '" y2="' + (cy + R) + '"/>';
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * 2 * Math.PI;
    svg += '<line class="gr" x1="' + (cx + Math.cos(a) * (R - 4)).toFixed(1) + '" y1="' + (cy + Math.sin(a) * (R - 4)).toFixed(1) + '" x2="' + (cx + Math.cos(a) * R).toFixed(1) + '" y2="' + (cy + Math.sin(a) * R).toFixed(1) + '"/>';
  }
  for (const e of edges) {
    const p = edgePath(e);
    if (!p) continue;
    const core = depth[e.funder] === 0;
    svg += '<path class="ed' + (core ? " core" : "") + '" d="' + p + '" stroke-linecap="round">' +
      '<title>' + esc(e.funder) + " &#8594; " + esc(e.funded) + " &middot; " + fmtSupply(e.amount) + "</title></path>";
  }
  const byBal = members.slice().sort((a, b) => (Number(b.balance) || 0) - (Number(a.balance) || 0));
  for (const m of members) {
    const p = pos[m.address];
    if (!p) continue;
    const isRoot = depth[m.address] === 0;
    const bal = Number(m.balance) || 0;
    const pct = totalSupply > 0 ? (bal / totalSupply) * 100 : 0;
    svg += '<circle class="nd' + (isRoot ? " root" : "") + '" cx="' + p.x.toFixed(1) + '" cy="' + p.y.toFixed(1) + '" r="' + p.r.toFixed(1) + '">' +
      "<title>" + esc(m.address) + " &middot; " + fmtSupply(bal) + (pct > 0 ? " &middot; " + pct.toFixed(2) + "% supply" : "") + (m.label ? " &middot; " + esc(m.label) : "") + "</title></circle>";
  }
  for (let i = 0; i < Math.min(4, byBal.length); i++) {
    const m = byBal[i];
    const p = pos[m.address];
    if (!p) continue;
    svg += '<text class="lb" x="' + (p.x + p.r + 4).toFixed(1) + '" y="' + (p.y + 3).toFixed(1) + '">' + esc(short(m.address)) + "</text>";
  }
  const heroPct = hero.pctOfSupply !== undefined ? hero.pctOfSupply : (() => { const s = Number(graph.totalSupply) || 1; return Number(hero.balance) / s * 100; })();
  const summary = "Cluster with " + hero.memberCount + " wallets holding " + Number(heroPct).toFixed(2) + "% of supply. " +
    "Largest holders: " + byBal.slice(0, 4).map((m) => short(m.address) + " (" + (Number(m.balance) || 0) + ")").join(", ") + ". " +
    "Funding links: " + edges.length + ".";
  el.innerHTML =
    '<svg viewBox="0 0 560 560" role="img" aria-label="' + esc(summary) + '">' +
    '<desc>' + esc(summary) + "</desc>" + svg + "</svg>" +
    '<div class="cy-legend"><span class="k"><span class="sw" style="background:var(--acc)"></span>funder / root</span>' +
    '<span class="k"><span class="sw" style="background:var(--panel);border:1.6px solid var(--acc)"></span>cluster wallet</span>' +
    '<span class="k"><span class="sw" style="background:transparent;border:1px dashed var(--faint)"></span>node size = balance</span></div>';
}

function renderConcentration(graph) {
  const el = $("tokenConcentration");
  const clusters = (graph && graph.clusters) || [];
  const totalSupply = Number(graph.totalSupply);
  if (clusters.length === 0) {
    el.innerHTML = '<div class="cy-empty">No clusters yet</div>';
    return;
  }
  const used = clusters.reduce((s, c) => s + (Number(c.pctOfSupply) || 0), 0);
  const rem = Math.max(0, 100 - used);
  let bar = '<div class="barstack" role="img" aria-label="Supply concentration">';
  clusters.forEach((c, i) => {
    const w = Number(c.pctOfSupply) || 0;
    if (w <= 0) return;
    bar += '<i style="width:' + w + '%;background:' + PALETTE[i % PALETTE.length] + '"></i>';
  });
  if (rem > 0.01) bar += '<i style="width:' + rem + '%;background:var(--line)"></i>';
  bar += "</div>";

  const rows = clusters.map((c, i) => {
    const color = PALETTE[i % PALETTE.length];
    return '<div class="conc-row"><span class="c"><span class="sw" style="background:' + color + '"></span>' +
      "cluster #" + (i + 1) + " &middot; " + c.memberCount + " wallets</span>" +
      "<b>" + (Number(c.pctOfSupply) || 0).toFixed(2) + "%</b></div>";
  }).join("");
  const sumPct = (totalSupply > 0) ? "<span class='faint'>unclustered " + rem.toFixed(2) + "%</span>" : "";
  el.innerHTML = rows + bar + '<div style="padding:8px 0 0;font-size:10px;color:var(--faint);letter-spacing:.08em">' +
    "share of total supply tracked in clusters &middot; " + sumPct + "</div>";
}

function renderMembers(graph) {
  const el = $("tokenMembers");
  const clusters = (graph && graph.clusters) || [];
  if (clusters.length === 0) {
    el.innerHTML = '<div class="cy-empty">No cluster members yet</div>';
    return;
  }
  const totalSupply = Number(graph.totalSupply);
  let rows = "";
  clusters.forEach((c, ci) => {
    const color = PALETTE[ci % PALETTE.length];
    for (const m of (c.members || [])) {
      const bal = Number(m.balance) || 0;
      const pct = totalSupply > 0 ? (bal / totalSupply) * 100 : 0;
      rows += "<tr>" +
        '<td><span class="badge" style="color:' + color + ';border-color:' + color + '66;background:' + color + '14">#' + (ci + 1) + '</span></td>' +
        '<td class="mono">' + esc(short(m.address)) + "</td>" +
        "<td>" + (m.label ? esc(m.label) : '<span class="faint">—</span>') + "</td>" +
        '<td class="num">' + fmtSupply(bal) + "</td>" +
        '<td class="num">' + pct.toFixed(2) + "%</td>" +
        "<td>" + (m.funder ? '<span class="faint">' + esc(short(m.funder)) + "</span>" : '<span class="faint">—</span>') + "</td></tr>";
    }
  });
  el.innerHTML = '<div class="panel-b"><table class="tbl"><thead><tr><th>Cluster</th><th>Address</th><th>Label</th>' +
    '<th class="num">Balance</th><th class="num">% supply</th><th>Funder</th></tr></thead><tbody>' + rows + "</tbody></table></div>";
}

function renderAlertsFeed(container, alerts) {
  if (!alerts || alerts.length === 0) {
    container.innerHTML = '<div class="evt faint">No alerts for this token</div>';
    return;
  }
  container.innerHTML = alerts.map((a) => {
    let p = {};
    try { p = JSON.parse(a.payload_json); } catch {}
    return '<div class="evt"><span class="t">' + timeAgo(a.created_at) + "</span> " +
      '<span class="' + sevClass(a.severity) + '">' + esc(a.severity) + '</span> <span class="hl">' + esc(p.headline || "alert") + "</span>" +
      '<span class="faint">(' + a.score + ")</span>" +
      (a.confirmed ? "" : ' <span class="badge">unconfirmed</span>') + "</div>";
  }).join("");
}

function renderSignalsFeed(container, signals) {
  if (!signals || signals.length === 0) {
    container.innerHTML = '<div class="evt faint">No signals for this token</div>';
    return;
  }
  container.innerHTML = signals.map((s) => {
    return '<div class="evt"><span class="t">' + timeAgo(s.timestamp) + "</span> " +
      '<span class="badge">' + esc(s.ruleId || s.rule_id) + "</span>" +
      '<span class="faint">w' + (s.weight || 0) + " &middot; b" + (s.blockNumber || s.block_number || 0) + "</span></div>";
  }).join("");
}

async function openToken(chainId, address) {
  $("mainView").hidden = true;
  $("tokenView").hidden = false;
  const grid = document.querySelector("#tokenView .detail-grid");
  if (grid) {
    grid.classList.remove("reveal");
    void grid.offsetWidth;
    grid.classList.add("reveal");
  }
  $("tokenHeader").textContent = "Loading token…";
  $("tokenConstellation").innerHTML = '<div class="cy-empty">Scanning cluster graph…</div>';
  $("tokenMeta").innerHTML = '<div class="cy-empty" style="min-height:120px">Loading…</div>';

  try {
    const [data, graph] = await Promise.all([
      fetch("/api/token/" + chainId + "/" + address, { headers: { "accept": "application/json" } }).then((r) => r.json()),
      fetch("/api/graph/token/" + chainId + "/" + address).then((r) => r.json()),
    ]);
    renderMeta(data, graph);
    renderPools(data);
    renderConstellation(graph);
    renderConcentration(graph);
    renderMembers(graph);
    renderTokenPerformance(data.performance || []);
    renderAlertsFeed($("tokenAlerts"), data.alerts || []);
    renderSignalsFeed($("tokenSignals"), data.signals || []);
  } catch (e) {
    $("tokenHeader").textContent = "Token " + short(address) + " &middot; chain " + chainId;
    $("tokenMeta").innerHTML = '<div class="cy-empty" style="min-height:120px"><span class="error">Failed to load token details</span><span class="faint">the graph or detail endpoint did not respond</span></div>';
  }
}

function showMain() {
  $("tokenView").hidden = true;
  $("mainView").hidden = false;
  refresh();
}

function route() {
  const hash = window.location.hash;
  const path = window.location.pathname;
  const routeParts = (value) => {
    if (!value) return null;
    const m = value.match(/^[#/]*token\\/(\\d+)\\/(0x[0-9a-fA-F]{40})$/);
    if (!m) return null;
    const chain = Number(m[1]);
    return Number.isInteger(chain) ? [chain, m[2]] : null;
  };
  const match = routeParts(hash) || routeParts(path);
  if (match) {
    openToken(match[0], match[1]);
  } else {
    $("tokenView").hidden = true;
    $("mainView").hidden = false;
    refresh();
  }
}

function connect() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = protocol + "//" + location.host + "/ws";
  let ws;
  let retryTimer;

  function init() {
    if (ws) { try { ws.close(); } catch {} }
    ws = new WebSocket(wsUrl);
    ws.onopen = () => {
      setConn("live", "ws: live");
      refresh();
    };
    ws.onclose = () => {
      setConn("stale", "ws: reconnecting");
      clearTimeout(retryTimer);
      retryTimer = setTimeout(init, 2000);
    };
    ws.onerror = () => {
      setConn("stale", "ws: reconnecting");
    };
    ws.onmessage = (msg) => {
      let p;
      try { p = JSON.parse(msg.data); } catch { return; }
      if (p.type === "alert") {
        const el = document.createElement("div");
        el.className = "evt flash";
        el.innerHTML = '<span class="t">' + timeAgo(Math.floor(Date.now() / 1000)) + "</span> " +
          '<span class="' + sevClass(p.severity) + '">' + esc(p.severity) + "</span> " +
          tokenLink(p.chainId || 1, p.tokenAddress) + ' <span class="hl">' + esc(p.headline) + "</span>" +
          '<span class="faint">(' + p.score + ")</span>";
        const feed = $("alerts");
        if (feed) {
          feed.prepend(el);
          while (feed.children.length > 40) feed.lastChild.remove();
        }
        refresh();
      } else if (p.type === "signal" && p.data) {
        const s = p.data;
        const el = document.createElement("div");
        el.className = "evt flash";
        el.innerHTML = '<span class="t">' + timeAgo(s.timestamp || Math.floor(Date.now() / 1000)) + "</span> " +
          '<span class="badge">' + esc(s.ruleId || s.rule_id) + "</span> " +
          tokenLink(s.chainId || s.chain_id || 1, s.tokenAddress || s.token_address) +
          '<span class="faint">w' + (s.weight || 0) + " &middot; b" + (s.blockNumber || s.block_number || 0) + "</span>";
        const feed = $("signals");
        if (feed) {
          feed.prepend(el);
          while (feed.children.length > 40) feed.lastChild.remove();
        }
      } else if (p.type === "event" && p.data) {
        const e = p.data;
        const el = document.createElement("div");
        el.className = "evt flash";
        el.innerHTML = '<span class="t">b' + (e.block_number || e.blockNumber || 0) + "</span> " +
          '<span class="badge">' + esc(e.type || e.kind) + "</span> " +
          '<span class="mono hl">' + short(e.tx_hash || e.txHash) + "</span>" +
          (e.finalized === 1 ? "" : ' <span class="badge">unfinalized</span>');
        const feed = $("events");
        if (feed) {
          feed.prepend(el);
          while (feed.children.length > 40) feed.lastChild.remove();
        }
      } else if (p.type === "performance") {
        refresh();
      } else if (p.type === "status" && p.status) {
        renderChains(p.status);
      }
    };
  }
  init();
}

function tickClock() {
  const now = new Date();
  $("clock").textContent = now.toISOString().slice(11, 19) + " UTC";
}
setInterval(tickClock, 1000);
tickClock();

window.addEventListener("hashchange", route);
window.addEventListener("popstate", route);
$("backBtn").addEventListener("click", () => { window.location.hash = "#/"; showMain(); });

route();
connect();
setInterval(refresh, 10000);
</script>
</body>
</html>`;
}
