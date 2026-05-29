/* Application state + ingest for xtop.
 *
 * Two data sources feed one model:
 *   • the BPF ring buffer  → live exec/fork/exit events (authoritative, timely)
 *   • the yeet system graph → procs snapshots (seed the tree at startup,
 *                              refresh cmdlines, and self-heal dropped events)
 *                            + docker.list_containers (cgroup → container name)
 *
 * `advance()` rolls the per-tick rate history and reaps dead branches. */

export const TICK_MS = 200;       /* render cadence + rate-sample spacing */
export const HOT_MS = 1600;       /* a node shows "just spawned" this long */
export const FADE_MS = 1400;      /* a dead node lingers (fading) this long */
export const WINDOW_MS = 10000;   /* rolling window: current rate + top spawners */
const RATE_HIST = 240;            /* ticks of rate history retained */
const FEED_MAX = 400, ALERT_MAX = 200, SPAWN_MAX = 8000, EXECTS_MAX = 8000;

export const EVT_EXEC = 0, EVT_FORK = 1, EVT_EXIT = 2;

/* ---- model ---------------------------------------------------------- */
export const procs = new Map();        /* pid -> node */
export const startTime = Date.now();
export const tot = { exec: 0, fork: 0, exit: 0, alerts: 0 };
export let liveCount = 0;

const feed = [];                       /* recent EXEC/EXIT events (lifecycle) */
const alerts = [];                     /* recent flagged events */
const recentSpawns = [];               /* {ts, key:ppid, name:pcomm} per FORK */
const recentExecTs = [];               /* exec timestamps, for instantaneous rate */

let tickRate = { host: 0, cont: 0, kth: 0 }; /* EXECs this tick, by source */
let tickFork = 0;
export const rateHist = { host: [], cont: [], kth: [] };
export const forkHist = [];

/* ---- container attribution ----------------------------------------- */
let containerById = new Map();         /* lower-hex id -> {name, image, state} */
let containerList = [];                 /* [{id, name}] for prefix matching */
export let containerCount = 0;

export function updateContainers(list) {
  const byId = new Map();
  const arr = [];
  for (const c of list ?? []) {
    const id = String(c.id ?? "").toLowerCase();
    if (!id) continue;
    const name = nameOfContainer(c);
    byId.set(id, { name, image: c.image ?? "", state: c.state ?? "" });
    arr.push({ id, name });
  }
  containerById = byId;
  containerList = arr;
  containerCount = arr.filter((c) => {
    const m = byId.get(c.id);
    return m && /run/i.test(m.state || "");
  }).length || arr.length;
  /* back-fill container names for nodes we only had a cgroup for */
  for (const n of procs.values()) {
    if (n.cgroup && !n.container) n.container = resolveContainer(n.cgroup);
  }
}

function nameOfContainer(c) {
  const n = (Array.isArray(c.names) && c.names[0]) || c.name;
  if (n) return String(n).replace(/^\//, "");
  return String(c.id ?? "").slice(0, 12);
}

/* A docker cgroup leaf is the 64-hex container id (cgroupfs driver) or
 * docker-<id>.scope (systemd driver); k8s/podman use similar id-bearing
 * names. Host system units (user.slice, init.scope, *.service) carry no
 * long hex run, so they resolve to null == "host". */
function resolveContainer(cgroup) {
  if (!cgroup) return null;
  const m = /([0-9a-f]{12,64})/i.exec(cgroup);
  if (!m) return null;
  const id = m[1].toLowerCase();
  for (const c of containerList) {
    if (c.id.startsWith(id) || id.startsWith(c.id.slice(0, 12))) return c.name;
  }
  return id.slice(0, 12); /* in a container we don't have metadata for */
}

/* ---- anonymize (screenshot-safe relabeling) ------------------------- */
const anon = !!globalThis.yeet?.args?.anonymize;
const aliasMaps = { name: new Map(), cont: new Map(), path: new Map() };
function aliasGen(kind, key, prefix) {
  const m = aliasMaps[kind];
  let a = m.get(key);
  if (!a) { a = prefix + String(m.size + 1).padStart(2, "0"); m.set(key, a); }
  return a;
}
export function aName(s) { return anon && s ? aliasGen("name", s, "proc-") : s; }
export function aCont(s) { return anon && s ? aliasGen("cont", s, "container-") : s; }
export function aPath(p) {
  if (!anon || !p) return p;
  const base = p.split("/").pop() || p;
  return "/redacted/" + aliasGen("path", base, "bin-");
}

/* ---- helpers -------------------------------------------------------- */
function newNode(pid, now, subject) {
  return {
    pid, ppid: 0, comm: "", cmdline: null, filename: null, uid: 0,
    cgroup: "", container: null, kthread: pid === 2 || pid === 0,
    born: now, bornHot: subject ? now : 0,
    dead: false, diedAt: null, exitCode: null,
    execs: 0, forks: 0, kids: new Set(),
    preexisting: false, stub: !subject,
  };
}
function getOrCreate(pid, now, subject) {
  let n = procs.get(pid);
  if (!n) { n = newNode(pid, now, subject); procs.set(pid, n); }
  else if (subject) n.stub = false;
  return n;
}
function linkParent(node, ppid, now) {
  if (!ppid || ppid === node.pid) return;
  if (node.ppid && node.ppid !== ppid) {
    const old = procs.get(node.ppid);
    if (old) old.kids.delete(node.pid);
  }
  node.ppid = ppid;
  getOrCreate(ppid, now, false).kids.add(node.pid);
}
function sourceOf(node) {
  return node.container ? "cont" : (node.kthread ? "kth" : "host");
}
export function isKthread(node) {
  return node.kthread || node.ppid === 2 || node.pid === 2 || node.pid === 0;
}
export function decodeExit(code) {
  if (code == null) return null;
  const sig = code & 0x7f;
  if (sig) return { kind: "sig", n: sig };
  return { kind: "code", n: (code >> 8) & 0xff };
}

/* ---- live BPF ingest ------------------------------------------------ */
export function onEvent(e) {
  const now = Date.now();
  const pid = e.pid | 0;
  if (pid <= 0) return;
  const ppid = e.ppid | 0;
  const comm = str(e.comm), pcomm = str(e.pcomm);
  const cgroup = str(e.cgroup);

  const node = getOrCreate(pid, now, true);
  node.uid = e.uid | 0;
  if (cgroup) { node.cgroup = cgroup; node.container = resolveContainer(cgroup); }
  node.kthread = isKthread({ ...node, ppid: ppid || node.ppid });
  linkParent(node, ppid, now);

  if (e.kind === EVT_FORK) {
    if (comm && !node.comm) node.comm = comm; /* child inherits parent comm pre-exec */
    node.bornHot = now;                        /* newly spawned → highlight */
    const par = procs.get(node.ppid);
    if (par) { par.forks++; if (pcomm && !par.comm) par.comm = pcomm; }
    tot.fork++; tickFork++;
    push(recentSpawns, { ts: now, key: node.ppid, name: pcomm || "?" }, SPAWN_MAX);
    return;
  }

  if (e.kind === EVT_EXEC) {
    if (comm) node.comm = comm;
    const fn = str(e.filename);
    if (fn) node.filename = fn;
    node.execs++; node.bornHot = now; node.dead = false; node.diedAt = null;
    tot.exec++;
    tickRate[sourceOf(node)]++;
    push(recentExecTs, now, EXECTS_MAX);
    push(feed, {
      ts: now, kind: EVT_EXEC, pid, ppid: node.ppid,
      comm: node.comm, pcomm, filename: node.filename, container: node.container,
    }, FEED_MAX);
    const flag = classify(node, pcomm);
    if (flag) {
      tot.alerts++;
      push(alerts, {
        ts: now, pid, comm: node.comm, pcomm, filename: node.filename,
        container: node.container, reason: flag.reason, sev: flag.sev,
      }, ALERT_MAX);
    }
    return;
  }

  if (e.kind === EVT_EXIT) {
    if (comm) node.comm = comm;
    node.dead = true; node.diedAt = now; node.exitCode = e.exit_code | 0;
    tot.exit++;
    push(feed, {
      ts: now, kind: EVT_EXIT, pid, ppid: node.ppid,
      comm: node.comm, pcomm, exitCode: node.exitCode, container: node.container,
    }, FEED_MAX);
  }
}

/* ---- pattern detection (heuristic, per-exec) ------------------------ */
const SHELLS = new Set(["sh", "bash", "dash", "zsh", "ksh", "ash", "fish"]);
const NETCATS = new Set(["nc", "ncat", "netcat", "socat"]);
const FETCHERS = new Set(["curl", "wget"]);
const SERVICES = new Set([
  "nginx", "apache2", "httpd", "php-fpm", "php", "node", "python", "python3",
  "ruby", "java", "postgres", "mysqld", "redis-server", "sshd",
]);
const TMP_RE = /^\/(tmp|dev\/shm|var\/tmp|run|root)\//;

/* `node` is the freshly-exec'd process; `pcomm` its parent's name. */
function classify(node, pcomm) {
  const c = node.comm, p = pcomm || "";
  if (FETCHERS.has(p) && SHELLS.has(c))
    return { reason: `pipe to shell (${p} → ${c})`, sev: 2 };
  if (SERVICES.has(p) && SHELLS.has(c))
    return { reason: `service spawned shell (${p} → ${c})`, sev: 2 };
  if (NETCATS.has(c))
    return { reason: `netcat-family exec (${c})`, sev: 1 };
  if (node.filename && TMP_RE.test(node.filename))
    return { reason: `exec from ${node.filename.split("/")[1]}`, sev: 1 };
  if (node.uid === 0 && SHELLS.has(c) && SERVICES.has(p))
    return { reason: `root shell from service (${p})`, sev: 2 };
  return null;
}

/* ---- graph reconciliation ------------------------------------------- */
let lastSnapPids = new Set();
export function reconcileProcs(list, seed) {
  const now = Date.now();
  const seen = new Set();
  for (const p of list ?? []) {
    const pid = p.pid | 0;
    if (pid <= 0) continue;
    seen.add(pid);
    const fresh = !procs.has(pid);
    const node = getOrCreate(pid, seed ? startTime : now, true);
    if (fresh) { node.preexisting = true; node.bornHot = 0; node.born = startTime; }
    const ppid = p.stat?.ppid | 0;
    if (ppid) linkParent(node, ppid, now);
    const comm = p.stat?.comm;
    if (comm && !node.comm) node.comm = String(comm);
    if (Array.isArray(p.cmdline) && p.cmdline.length)
      node.cmdline = p.cmdline.join(" ");
    node.kthread = isKthread(node);
    /* the snapshot proves it's alive — correct any stale/ missed exit */
    if (node.dead) { node.dead = false; node.diedAt = null; }
  }
  if (!seed) {
    /* a pid that was in the last snapshot and is now gone, without a BPF
     * exit, gets marked dead here — keeps the tree honest under drops */
    for (const pid of lastSnapPids) {
      if (seen.has(pid)) continue;
      const n = procs.get(pid);
      if (n && !n.dead && pid > 2) { n.dead = true; n.diedAt = now; n.exitCode = null; }
    }
  }
  lastSnapPids = seen;
}

/* ---- per-tick roll + reap ------------------------------------------- */
export function advance() {
  const now = Date.now();
  for (const k of ["host", "cont", "kth"]) {
    push(rateHist[k], tickRate[k], RATE_HIST); tickRate[k] = 0;
  }
  push(forkHist, tickFork, RATE_HIST); tickFork = 0;

  prune(recentExecTs, now, WINDOW_MS, (x) => x);
  prune(recentSpawns, now, WINDOW_MS, (x) => x.ts);

  let live = 0;
  for (const [pid, n] of procs) {
    if (!n.dead) live++;
    const dead = n.dead && now - n.diedAt > FADE_MS && n.kids.size === 0;
    const deadStub = n.stub && n.kids.size === 0 && now - n.born > 2 * FADE_MS;
    if ((dead || deadStub) && pid > 2) {
      const par = procs.get(n.ppid);
      if (par) par.kids.delete(pid);
      /* kernel reparents survivors to init; mirror that so they don't vanish */
      for (const kid of n.kids) {
        const kn = procs.get(kid);
        if (kn) { kn.ppid = 1; const root = procs.get(1); if (root) root.kids.add(kid); }
      }
      procs.delete(pid);
    }
  }
  liveCount = live;
}

/* ---- accessors for the dashboard ------------------------------------ */
export function currentRate() {
  const now = Date.now();
  let n = 0;
  for (let i = recentExecTs.length - 1; i >= 0 && now - recentExecTs[i] <= 1000; i--) n++;
  return n; /* execs in the last second */
}
export function childrenOf(pid) {
  const n = procs.get(pid);
  if (!n) return [];
  return [...n.kids].map((k) => procs.get(k)).filter(Boolean);
}
export function recentFeed(n) { return feed.slice(-n).reverse(); }
export function recentAlerts(n) { return alerts.slice(-n).reverse(); }
export function topSpawners(n) {
  const now = Date.now();
  const agg = new Map(); /* key -> {key, name, count} */
  for (const s of recentSpawns) {
    if (now - s.ts > WINDOW_MS) continue;
    let a = agg.get(s.key);
    if (!a) { a = { key: s.key, name: s.name, count: 0 }; agg.set(s.key, a); }
    a.count++;
  }
  for (const a of agg.values()) {
    const node = procs.get(a.key);          /* prefer the parent's current name */
    if (node && node.comm) a.name = node.comm;
  }
  return [...agg.values()].sort((x, y) => y.count - x.count).slice(0, n);
}

/* ---- tiny utils ----------------------------------------------------- */
function str(v) { return v == null ? "" : String(v); }
function push(arr, v, max) { arr.push(v); if (arr.length > max) arr.shift(); }
function prune(arr, now, win, tsOf) {
  while (arr.length && now - tsOf(arr[0]) > win) arr.shift();
}
