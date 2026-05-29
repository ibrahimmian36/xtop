import { RingBuf } from "yeet:bpf";
import bpf from "./bin/xtop.bpf.o";

import { ESC, HOME, CLEAR, HIDE, RESET, bold, fg } from "./render.js";
import { onEvent, reconcileProcs, updateContainers, advance, TICK_MS } from "./state.js";
import { renderDashboard } from "./dashboard.js";

/* ---- terminal size ------------------------------------------------ */
let TCOLS = 100, TROWS = 32;
function refreshSize() {
  try {
    const s = globalThis.tty?.size?.();
    if (s) { TCOLS = Math.max(1, s.cols | 0 || 100); TROWS = Math.max(1, s.rows | 0 || 32); }
  } catch { /* keep current */ }
}

const MIN_COLS = 80, MIN_ROWS = 24;
function centerLine(text, pre = "") {
  const pad = Math.max(0, (TCOLS - text.length) >> 1);
  return " ".repeat(pad) + pre + text + RESET;
}

/* synchronized, flicker-free output via the tty builtin; console fallback */
function paint(out) {
  const t = globalThis.tty;
  if (t?.write) { t.beginFrame?.(); t.write(out); t.endFrame?.(); }
  else console.log(out);
}

function render() {
  if (TCOLS < MIN_COLS || TROWS < MIN_ROWS) {
    let out = HOME + `${ESC}J`;
    for (let i = 0; i < Math.max(0, (TROWS >> 1) - 1); i++) out += "\n";
    out += centerLine("terminal too small", bold + fg(196)) + "\n";
    out += centerLine(`need ≥ ${MIN_COLS}×${MIN_ROWS} · have ${TCOLS}×${TROWS}`, fg(244));
    paint(out);
    return;
  }
  advance();
  let out = HOME;
  for (const line of renderDashboard(TCOLS, TROWS)) out += line + "\n";
  out += `${ESC}J`;
  paint(out);
}

/* ---- BPF: one ring buffer of exec/fork/exit events ---------------- */
const control = await bpf
  .bind("events", { kind: "ringbuf", btf_struct: "proc_evt" })
  .start();

await new RingBuf(control, "events").subscribe(
  (evt) => onEvent(evt.proc_evt ?? evt),
  (err) => console.error(err.message),
);

/* ---- system graph: seed the tree, keep it fresh, attribute -------- */
const unwrap = (r) => r.data ?? r;

/* one-shot snapshot so the tree has depth from boot on the first frame */
try {
  const r = await yeet.graph.query("{ procs { pid cmdline stat { comm ppid } } }");
  const list = unwrap(r)?.procs;
  if (Array.isArray(list)) reconcileProcs(list, true);
} catch { /* graph may lag at startup; the subscription below seeds shortly */ }

/* periodic refresh: picks up cmdlines, backfills processes that predate
 * attach, and self-heals any exit the ring buffer dropped under load */
yeet.graph.subscribe(
  `subscription { procs(interval_ms: 2000) { pid cmdline stat { comm ppid } } }`,
  (r) => {
    const list = unwrap(r)?.procs;
    if (Array.isArray(list)) reconcileProcs(list, false);
  },
);

/* container attribution: docker.list_containers maps cgroup → name.
 * Best-effort — if docker isn't present every process is "host", fine. */
async function pollDocker() {
  try {
    const r = await yeet.graph.query(
      `{ docker { list_containers(opts: { all: true }) { id names name image state } } }`);
    const list = r.data?.docker?.list_containers;
    if (Array.isArray(list)) updateContainers(list);
  } catch { /* no docker socket — nothing to attribute */ }
}
await pollDocker();
setInterval(pollDocker, 3000);

/* ---- terminal + render loop --------------------------------------- */
refreshSize();
globalThis.tty?.on?.("resize", (s) => {
  if (s) { TCOLS = Math.max(1, s.cols | 0 || TCOLS); TROWS = Math.max(1, s.rows | 0 || TROWS); }
  paint(CLEAR); /* drop stale cells from the old geometry */
});

paint(HIDE + CLEAR);
setInterval(render, TICK_MS);

/* Runs until Ctrl-C. */
await new Promise(() => {});
