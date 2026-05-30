# xtop

**`strace -fe execve -p 1`, but for the whole machine, rendered** — a live process-execution observatory in your terminal.

<p align="center">
  <img src="https://img.shields.io/badge/platform-Linux-1793D1" alt="Linux">
  <img src="https://img.shields.io/badge/built%20with-yeet%20%2B%20eBPF-8A2BE2" alt="yeet + eBPF">
  <img src="https://img.shields.io/badge/license-GPL-3DA639" alt="GPL">
</p>

<!-- To record the demo GIF, run `vhs assets/xtop.tape` on a Linux box
     with yeet installed, then add:
     <p align="center">
       <img src="assets/xtop.gif" alt="xtop running in anonymize mode" width="820">
     </p>
     here. -->

**xtop turns every process birth and death on your box into a live terminal dashboard** — a process lineage tree that grows and prunes itself in real time, a scrolling exec/exit feed, a leaderboard of the busiest spawners, a heuristic alert panel for suspicious exec patterns, and an exec-rate heatmap split by host / container / kernel — drawn with block and braille graphics over eBPF.

> [!TIP]
> **No `/proc` polling on the hot path, no syscall hooking.** xtop attaches eBPF programs to the scheduler's `sched_process_*` tracepoints and sees every `execve`, `fork`, and `exit` the instant the kernel does — then uses yeet's system graph to seed the tree from `/proc` and attribute processes to their containers.

## Quick start

```sh
curl -fsSL https://yeet.cx | sh
yeet run https://github.com/YOUR-USERNAME/xtop
```

For a shareable screenshot, anonymize command names, paths, and container names (everything identifying gets relabeled `proc-01`, `container-02`, …):

```sh
yeet run https://github.com/YOUR-USERNAME/xtop -- --anonymize
```

Runs until `Ctrl-C`. Resize the terminal and the layout reflows; minimum 80×28.

Want to see it light up? Generate some process activity in another shell:

```sh
for i in $(seq 20); do (sleep 0.1; true) & done; wait    # a little fork/exec storm
```

## A 60-second process primer

On Linux, processes don't appear from nowhere — they're **forked** from a parent and then usually **exec** a new program. The mental model:

**Everything has a parent.** Every process is created by another process with `fork()`/`clone()`, forming one giant tree rooted at `init` (PID 1). PID 2 (`kthreadd`) roots a second tree: the kernel's own threads.

**Three events in a process's life:**

| Event | Tracepoint | Means |
|---|---|---|
| fork | `sched_process_fork` | a parent created a child (a near-copy of itself) |
| exec | `sched_process_exec` | a process replaced its image with a new program |
| exit | `sched_process_exit` | a process ended (with a status code or a fatal signal) |

**fork-then-exec is the norm.** A shell running `ls` doesn't *become* `ls` — it forks a child that's still the shell, and that child `exec`s `/usr/bin/ls`. That's why xtop tracks fork and exec separately: the **fork** tells you the lineage, the **exec** tells you what actually ran.

**cgroups & containers.** Every task belongs to a control group. Containers are just processes in their own cgroup, and on cgroup v2 the leaf cgroup's name is the container's ID — so xtop reads it in-kernel and matches it against Docker to label each process with the container it lives in.

**Exit status.** A process exits with an 8-bit code (`0` = success) — *unless* it was killed, in which case the low bits carry the **signal** number (e.g. `sig 9` = `SIGKILL`, `sig 11` = segfault). xtop shows whichever applies.

## Common use cases

Mostly ops and security folks watching what a box is actually executing.

- A server feels busy but `top` looks idle — what's the storm of short-lived processes?
- You suspect a compromise — is something exec'ing shells out of `/tmp` or piping `curl` into `sh`?
- A deploy misbehaves — which parent is fork-bombing, and what's it spawning?
- You're learning a system — what does its process tree actually look like, live?

## What you're looking at

Each panel maps onto the concepts above:

**Header** — uptime, total execs seen, current exec rate (per second), total forks, live process count, container count, and a suspicious-pattern counter (red if any non-zero). The alert counter is the one to keep an eye on; a quiet box stays at zero.

**Lineage** — the live process tree, rooted at `init`, redrawn every tick. **Newly spawned processes flash `●` green; exiting ones show `✕` red and fade.** Runs of identical siblings (think 64 `cc1` from a parallel build, or a worker pool) collapse to a single `cc1 ×64` line so the interesting structure stays visible, and the kernel-thread forest is summarized to one line. This is the panel to watch — it's a process tree with a *time dimension*.

**Exec feed** — a scrolling ledger of lifecycle events: `▸` for an exec (`parent → child`, with the binary path and container), `✕` for an exit (with its code or signal). The thing `ps` can never show you: what happened, in order.

**Top spawners** — the parents that created the most children in the rolling window, as a gauge leaderboard. A healthy `make -j` sits at the top during a build; a process that shouldn't be spawning anything sitting at the top is a smell.

**Pattern alerts** — heuristic flags on suspicious execs: a fetch tool piping into a shell (`curl → sh`), a service process spawning a shell (the classic webshell/RCE shape), execs from world-writable paths (`/tmp`, `/dev/shm`), or netcat-family tools. **Not a security product** — a fast, legible signal of the patterns worth a second look.

**Exec rate** — a heatmap of exec volume over time, split into `host`, `container`, and `kernel` rows (plus `fork` on taller terminals); cell color = how many happened per 200 ms slice. A build or a fork bomb lights up `host`; a busy container lights up `container`.

## How it works

A single BPF object (`xtop.bpf.c`) attaches three BTF-typed tracepoint programs and streams events to userspace over one ring buffer:

| Hook | What it captures |
|---|---|
| `tp_btf/sched_process_exec` | every successful `execve`: new comm, executable path, pid/ppid, uid, cgroup |
| `tp_btf/sched_process_fork` | every `fork`/`clone`: parent→child pids and names |
| `tp_btf/sched_process_exit` | every process exit (thread-group leader): raw exit code / signal |

Because they're `tp_btf` programs, the handlers receive real `task_struct *` pointers and CO-RE relocates every field by name at load — no per-kernel recompile. The dashboard runs in yeet's V8 runtime, subscribing to that ring buffer and rendering the UI, while leaning on yeet's **system graph** for two things the ring buffer can't give you: a `procs` snapshot to seed the tree with processes that predate xtop (and to self-heal any event dropped under load), and `docker.list_containers` to turn cgroup IDs into container names.

```
main.js       entry: tty size, render loop, BPF subscribe, graph wiring
state.js      live process tree, ingest, pattern detection, container map
render.js     ANSI, color ramps, braille canvas, gauges, tree glyphs (pure)
dashboard.js  panels + layout (renderDashboard)
```

## Requirements

> [!IMPORTANT]
> Linux with BTF: `CONFIG_DEBUG_INFO_BTF=y`. Default on current Arch, Fedora, Ubuntu, and Debian 12+. CO-RE means no per-kernel recompile.

- A reasonably recent kernel (the `sched_process_*` tracepoints are long-stable; `tp_btf` needs BTF, ~5.2+).
- cgroup v2 for container attribution (the default on modern distros). On pure cgroup v1 the container column stays empty — everything reads as host.
- The yeet daemon, which handles the privileged BPF load. `curl -fsSL https://yeet.cx | sh` installs it.

## Honest caveats

> [!NOTE]
> What xtop doesn't do:

- **It's a process monitor, not a thread monitor.** Events are at process (thread-group) granularity; individual thread creation/exit is intentionally filtered out.
- **Container attribution depends on cgroup v2.** On cgroup-v1 hosts, or for containers Docker doesn't know about (raw `runc`, some k8s setups), you'll see a short cgroup ID instead of a friendly name, or nothing.
- **Kernel-thread detection is a heuristic** (based on PID 2 / parentage). It's right for the common cases and summarized into one line regardless.
- **Pattern alerts are heuristics, not detections.** They flag *shapes* (curl→sh, service→shell, exec-from-tmp), and will both miss things and occasionally fire on benign activity. Treat them as a prompt, not a verdict.
- **Exit codes are the raw `task->exit_code`**, decoded into code-vs-signal; exotic cases (ptrace stops, core dumps) are simplified.

## Community questions

**Does this need root?**
You don't run it as root — the yeet daemon does the privileged BPF load for you. Same model as the rest of yeet.

**Will it slow my system down?**
Tracepoints are about as cheap as kernel instrumentation gets, and events go over a ring buffer, not per-event syscalls. The one workload that generates real volume is something exec-bombing (a runaway build, a fork bomb) — which is exactly when you'll want to be watching.

**Why do some processes show up as `?`?**
xtop saw a child's `fork`/`exec` before it had learned about the parent. The parent fills in within a second or two from the next `/proc` snapshot; transient ones that already exited get reaped.

**How is this different from `execsnoop`, `forkstat`, `ps`, or `htop`?**
`execsnoop`/`forkstat` are flat streams of one event type; `ps`/`htop` are point-in-time snapshots. xtop combines all three event types into a single **live tree** plus a feed, a spawner leaderboard, and a rate heatmap — the time dimension and the lineage are the point. For scripting one event type, the bpftrace one-liners are great; this is the dashboard.

**How does it know which container a process is in?**
It reads the leaf cgroup name in-kernel (on cgroup v2 that's the container ID) and matches it against `docker.list_containers` from yeet's graph. No container runtime API calls on the hot path.

## Building from source

```sh
make          # generates include/vmlinux.h, builds bin/xtop.bpf.o
make vmlinux  # force-refresh the kernel type header
make clean
```

Needs `clang` (BPF target) and `bpftool`; your distro's `libbpf` / `libbpf-dev` for headers. The generated `include/vmlinux.h` and `bin/` are gitignored — `yeet run` builds them for you on first launch.

## Recording the demo

The GIF is produced with [VHS](https://github.com/charmbracelet/vhs) from `assets/xtop.tape`:

```sh
vhs assets/xtop.tape    # -> assets/xtop.gif
```

It launches xtop off-camera so the GIF opens on the live dashboard. Kick off a fork/exec storm in another shell while recording to fill the tree and feed.

## License

The BPF program is GPL (`SEC("license") = "GPL"`), as required by the kernel helpers it uses.

---

Built by [yeet](https://yeet.cx). yeet is a Linux runtime for writing eBPF programs and live system dashboards in JavaScript.
