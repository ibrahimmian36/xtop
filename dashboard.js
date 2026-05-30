/* Dashboard composition for xtop. Each panel builds pre-sized lines;
 * `renderDashboard(C, R)` lays them out to fill a C×R terminal. Layout
 * follows airtop's pattern: full-width strips plus a zip()'d split row. */

import {
  fg, bg, bold, dim, ital, RESET, EOL, EIGHTH, PALETTE,
  C_EXEC, C_EXIT, C_FORK, C_ALERT, C_CALM, C_CONT, C_DIM, C_AXIS,
  heatCell, gauge, mmss, compactNum, vlen, clipAnsi, fixw, TREE,
} from "./render.js";
import {
  procs, tot, liveCount, startTime, containerCount,
  currentRate, recentFeed, recentAlerts, topSpawners,
  rateHist, forkHist, isKthread, decodeExit,
  aName, aCont, aPath, HOT_MS, EVT_EXEC, EVT_EXIT, TICK_MS,
} from "./state.js";

/* ---- layout helpers (from airtop) ---------------------------------- */
function topRule(C, title) {
  const head = ` ▌ ${title} `;
  return bold + fg(51) + head + RESET + fg(C_AXIS) +
    "─".repeat(Math.max(0, C - head.length)) + RESET + EOL;
}
function botRule(C) { return fg(C_AXIS) + "─".repeat(C) + RESET + EOL; }
function sectionBar(C, text) {
  return `${fg(45)}  ${text} ${fg(C_AXIS)}${"─".repeat(Math.max(0, C - vlen(text) - 3))}${RESET}${EOL}`;
}
function sectionTitle(lw, left, right) {
  return `${fg(45)}${left}${" ".repeat(Math.max(1, lw - left.length))}${fg(C_AXIS)}│ ` +
    `${fg(45)}${right}${RESET}${EOL}`;
}
function zip(L, R, lw, rw, rows) {
  const h = Math.max(L.length, R.length);
  const bl = " ".repeat(lw), br = " ".repeat(rw);
  for (let i = 0; i < h; i++)
    rows.push(`${L[i] ?? bl}${fg(C_AXIS)}│${RESET} ${R[i] ?? br}${EOL}`);
}
const treeC = (s) => fg(C_AXIS) + s + RESET;

/* ---- panel: lineage tree ------------------------------------------- */
function nodeLabel(node, now) {
  const hot = node.bornHot > 0 && now - node.bornHot < HOT_MS;
  const dying = node.dead;
  const kth = isKthread(node);
  const nameColor = dying ? C_EXIT : hot ? C_EXEC : kth ? C_DIM : 252;
  const marker = dying ? fg(C_EXIT) + "✕ " : hot ? fg(C_EXEC) + "● " : "";
  const name = (hot ? bold : "") + fg(nameColor) + aName(node.comm || "?") + RESET;
  const pid = fg(C_DIM) + "(" + node.pid + ")" + RESET;
  let tag = "";
  if (node.container) tag = " " + fg(C_CONT) + "⬢ " + aCont(node.container) + RESET;
  let tail = "";
  if (node.cmdline && node.comm) {
    const rest = node.cmdline.split(" ").slice(1).join(" ");
    if (rest) tail = " " + fg(C_DIM) + ital + clipAnsi(aPath(rest), 40) + RESET;
  }
  return marker + name + " " + pid + tag + tail;
}

function countKthreads() {
  let n = 0;
  for (const node of procs.values())
    if (!node.dead && node.pid !== 2 && isKthread(node)) n++;
  return n;
}
function detachedRoots() {
  const out = [];
  for (const node of procs.values()) {
    if (node.pid === 1 || node.pid === 2 || isKthread(node)) continue;
    if (node.ppid === 0 || !procs.has(node.ppid)) out.push(node);
  }
  return out.sort((a, b) => a.pid - b.pid);
}

const COLLAPSE_MIN = 5; /* runs of identical-comm leaf siblings ≥ this collapse */

function groupLabel(run, now) {
  const comm = run[0].comm || "?";
  const hot = run.filter((r) => r.bornHot > 0 && now - r.bornHot < HOT_MS).length;
  const dead = run.filter((r) => r.dead).length;
  const marker = hot ? fg(C_EXEC) + "● " : "";
  const meta = [];
  if (hot) meta.push(fg(C_EXEC) + hot + " new" + RESET);
  if (dead) meta.push(fg(C_EXIT) + dead + " exiting" + RESET);
  const metaStr = meta.length
    ? " " + fg(C_DIM) + "(" + RESET + meta.join(fg(C_DIM) + " · " + RESET) + fg(C_DIM) + ")" + RESET
    : "";
  return marker + fg(252) + aName(comm) + RESET + " " + fg(C_DIM) + "×" + run.length + RESET + metaStr;
}

function walk(pid, prefix, isLast, out, now, seen) {
  const node = procs.get(pid);
  if (!node || seen.has(pid)) return;        /* guard against cycles */
  seen.add(pid);
  const conn = prefix === "" ? "" : treeC(prefix + (isLast ? TREE.ELL : TREE.TEE));
  out.push(conn + nodeLabel(node, now));

  /* visible children, grouped by comm so identical-leaf runs can collapse */
  const kids = [...node.kids].map((k) => procs.get(k))
    .filter((n) => n && !isKthread(n))
    .sort((a, b) => (a.comm < b.comm ? -1 : a.comm > b.comm ? 1 : 0) || (a.pid - b.pid));
  const items = [];
  for (let i = 0; i < kids.length;) {
    let j = i + 1;
    while (j < kids.length && kids[j].comm === kids[i].comm) j++;
    const run = kids.slice(i, j);
    if (run.length >= COLLAPSE_MIN && run.every((r) => r.kids.size === 0)) items.push({ run });
    else for (const r of run) items.push({ node: r });
    i = j;
  }

  const cpRaw = prefix + (prefix === "" ? "" : (isLast ? TREE.GAP : TREE.BAR));
  const cp = cpRaw === "" ? "  " : cpRaw;
  for (let k = 0; k < items.length; k++) {
    const last = k === items.length - 1;
    if (items[k].node) walk(items[k].node.pid, cp, last, out, now, seen);
    else out.push(treeC(cp + (last ? TREE.ELL : TREE.TEE)) + groupLabel(items[k].run, now));
  }
}

function renderTree(C, H, now) {
  const out = [];
  const seen = new Set();
  if (procs.has(1)) walk(1, "", true, out, now, seen);
  else out.push(fg(C_DIM) + "  init (pid 1) not seen yet — seeding from /proc…" + RESET);

  const kc = countKthreads();
  if (kc > 0)
    out.push(treeC(TREE.ELL) + " " + fg(C_DIM) + "[" + aName("kernel threads") + "] ×" + kc + RESET);

  const det = detachedRoots();
  if (det.length) {
    out.push(fg(C_DIM) + "(detached)" + RESET);
    for (let i = 0; i < det.length; i++)
      walk(det[i].pid, "", i === det.length - 1, out, now, seen);
  }

  /* fit to height: if overflowing, keep the head and summarize the rest */
  let lines = out;
  if (lines.length > H) {
    const extra = lines.length - (H - 1);
    lines = lines.slice(0, H - 1);
    lines.push(fg(C_DIM) + `  … +${extra} more processes` + RESET);
  }
  while (lines.length < H) lines.push("");
  return lines.map((l) => clipAnsi(l, C) + EOL);
}

/* ---- panel: exec / exit feed --------------------------------------- */
function clock(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function exitStr(code) {
  const x = decodeExit(code);
  if (!x) return fg(C_DIM) + "gone" + RESET;
  if (x.kind === "sig") return fg(C_ALERT) + "sig " + x.n + RESET;
  return x.n === 0 ? fg(C_CALM) + "ok" + RESET : fg(C_EXIT) + "code " + x.n + RESET;
}
function panelFeed(w, h) {
  const evs = recentFeed(h);
  const lines = [];
  for (const e of evs) {
    const ts = fg(C_DIM) + clock(e.ts) + RESET;
    let body;
    if (e.kind === EVT_EXEC) {
      const base = e.filename ? aPath(e.filename).split("/").pop() : "";
      const tag = e.container ? " " + fg(C_CONT) + "⬢" + aCont(e.container) + RESET : "";
      body = fg(C_EXEC) + "▸ " + RESET + fg(248) + aName(e.pcomm || "?") +
        fg(C_DIM) + "→" + RESET + fg(252) + bold + aName(e.comm) + RESET +
        (base ? " " + fg(C_DIM) + base + RESET : "") + tag;
    } else {
      const tag = e.container ? " " + fg(C_CONT) + "⬢" + aCont(e.container) + RESET : "";
      body = fg(C_EXIT) + "✕ " + RESET + fg(248) + aName(e.comm) + RESET +
        " " + fg(C_DIM) + "exit" + RESET + " " + exitStr(e.exitCode) + tag;
    }
    lines.push(fixw(ts + " " + body, w));
  }
  while (lines.length < h) lines.push(" ".repeat(w));
  return lines;
}

/* ---- panel: top spawners ------------------------------------------- */
function panelSpawners(w, h) {
  const rows = topSpawners(h);
  const max = rows.reduce((m, r) => Math.max(m, r.count), 1);
  const cntW = 5;
  const barW = Math.max(6, Math.min(16, w - 18));
  const nameW = Math.max(6, w - barW - cntW - 3);
  const lines = rows.map((r, i) => {
    const color = PALETTE[i % PALETTE.length];
    const name = fg(252) + clipAnsi(aName(r.name), nameW) + RESET;
    const g = gauge(r.count / max, barW, color);
    const cnt = fg(248) + String(r.count).padStart(cntW) + RESET;
    return fixw(`${fixw(name, nameW)} ${g} ${cnt}`, w);
  });
  while (lines.length < h) lines.push(" ".repeat(w));
  return lines;
}

/* ---- panel: pattern alerts ----------------------------------------- */
function panelAlerts(C, h) {
  const al = recentAlerts(h);
  const lines = [];
  if (al.length === 0) {
    lines.push("  " + fg(C_CALM) + "✓ no anomalous exec patterns in the last window" + RESET);
  } else {
    for (const a of al) {
      const sev = a.sev >= 2 ? fg(C_ALERT) + bold + "⚠" + RESET : fg(214) + "▲" + RESET;
      const ts = fg(C_DIM) + clock(a.ts) + RESET;
      const ctx = fg(C_DIM) + ` ${aName(a.pcomm || "?")}→${aName(a.comm)}` +
        (a.filename ? " " + aPath(a.filename) : "") +
        (a.container ? " ⬢" + aCont(a.container) : "") + RESET;
      lines.push(`  ${sev} ${ts} ${fg(252)}${a.reason}${RESET}${ctx}`);
    }
  }
  while (lines.length < h) lines.push("");
  return lines.map((l) => clipAnsi(l, C) + EOL);
}

/* ---- panel: exec-rate heatmap -------------------------------------- */
const RATE_ROWS = [
  { key: "host", label: "host", color: 252 },
  { key: "cont", label: "container", color: C_CONT },
  { key: "kth", label: "kernel", color: 109 },
];
function panelRate(C, withFork) {
  const labelW = 10;
  const stripN = Math.max(8, C - labelW - 1);
  let max = 1;
  for (const r of RATE_ROWS)
    for (const v of rateHist[r.key].slice(-stripN)) max = Math.max(max, v);
  if (withFork) for (const v of forkHist.slice(-stripN)) max = Math.max(max, v);

  const mk = (label, color, data) => {
    const lbl = fg(color) + label.padEnd(labelW) + RESET;
    const d = data.slice(-stripN);
    let strip = "";
    for (let k = 0; k < stripN - d.length; k++) strip += heatCell(-1);
    for (const v of d) strip += heatCell(v === 0 ? -1 : Math.max(0.12, v / max));
    return lbl + " " + strip + EOL;
  };
  const lines = RATE_ROWS.map((r) => mk(r.label, r.color, rateHist[r.key]));
  if (withFork) lines.push(mk("fork", C_FORK, forkHist));
  return lines;
}

/* ---- composition --------------------------------------------------- */
const MIN_COLS = 80;
const MIN_ROWS = 28;

export function renderDashboard(C, R) {
  if (C < MIN_COLS || R < MIN_ROWS) return smallTerm(C, R);
  const now = Date.now();
  const rows = [];
  const lw = Math.floor((C - 2) / 2), rw = C - 2 - lw;

  /* adaptive density, mirroring airtop's showFrames gate */
  const big = R >= 32;
  const ALERT_ROWS = big ? 3 : 2;
  const withFork = big;
  const rateRows = (withFork ? 4 : 3);
  const capRow = R >= 30 ? 1 : 0;

  /* chrome (non-content) lines: header2 blank treeTitle blank midTitle
   * blank alertTitle blank rateTitle bottomRule = 11 */
  const body = Math.max(7, R - 11 - ALERT_ROWS - rateRows - capRow);
  const hTree = Math.max(4, Math.round(body * 0.6));
  const hMid = Math.max(3, body - hTree);

  /* header */
  rows.push(topRule(C, "PROCESS EXECUTION MONITOR"));
  const rate = currentRate();
  const alertStr = tot.alerts
    ? `${fg(C_ALERT)}${bold}${tot.alerts}${RESET}${fg(244)}` : "0";
  rows.push(`  ${fg(C_EXEC)}●${fg(244)} LIVE ${fg(C_DIM)}${mmss(now - startTime)}${fg(244)}  ` +
    `${fg(252)}${compactNum(tot.exec)}${fg(244)} exec · ` +
    `${fg(252)}${rate}${fg(244)}/s · ` +
    `${fg(252)}${compactNum(tot.fork)}${fg(244)} fork · ` +
    `${fg(252)}${liveCount}${fg(244)} procs · ` +
    `${fg(C_CONT)}${containerCount}${fg(244)} cont · ` +
    `alerts ${alertStr}${RESET}${EOL}`);
  rows.push(EOL);

  /* lineage tree */
  rows.push(sectionBar(C, "LINEAGE · live process tree · ● new  ✕ exiting"));
  for (const line of renderTree(C, hTree, now)) rows.push(line);
  rows.push(EOL);

  /* exec feed | top spawners */
  rows.push(sectionTitle(lw, "EXEC FEED · exec ▸ / exit ✕", `TOP SPAWNERS · ${mmss(0).slice(-2)}s window`.replace("00", "10")));
  zip(panelFeed(lw, hMid), panelSpawners(rw, hMid), lw, rw, rows);
  rows.push(EOL);

  /* pattern alerts */
  rows.push(sectionBar(C, "PATTERN ALERTS · heuristic"));
  for (const line of panelAlerts(C, ALERT_ROWS)) rows.push(line);
  rows.push(EOL);

  /* exec-rate heatmap */
  rows.push(sectionBar(C, "EXEC RATE · /200 ms slice · newest → right"));
  for (const line of panelRate(C, withFork)) rows.push(line);
  if (capRow) {
    const span = Math.round((Math.max(8, C - 11) * TICK_MS) / 1000);
    rows.push(fg(C_DIM) + `  ← ${span}s` + " ".repeat(Math.max(0, C - 12)) + "now" + RESET + EOL);
  }
  rows.push(botRule(C));
  return rows;
}

function smallTerm(C, R) {
  /* renderDashboard returns an array of lines; mirror that shape. Keep
   * each line within the available width. */
  return [
    `xtop: terminal too small`.slice(0, Math.max(1, C)),
    `need ≥ ${MIN_COLS}×${MIN_ROWS}`.slice(0, Math.max(1, C)),
    `have ${C}×${R}`.slice(0, Math.max(1, C)),
  ];
}
