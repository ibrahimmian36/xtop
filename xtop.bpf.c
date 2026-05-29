#include "vmlinux.h"
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_core_read.h>
#include <bpf/bpf_tracing.h>

/* xtop — live process-execution observatory.
 *
 * Three scheduler tracepoints, one ring buffer. Every execve, fork, and
 * process exit on the box becomes a typed event in userspace. We attach to
 * `tp_btf/` (BTF-typed raw tracepoints) so the handlers receive real
 * `task_struct *` pointers and CO-RE relocates every field by name at load
 * — no per-kernel recompile, no syscall hooking, no /proc polling on the
 * hot path. */

#define COMM_LEN 16          /* matches TASK_COMM_LEN */
#define FILE_LEN 96          /* exec path; bounded to keep events small */
#define CG_LEN   64          /* leaf cgroup name == docker's 64-hex id */

enum evt_kind {
    EVT_EXEC = 0,
    EVT_FORK = 1,
    EVT_EXIT = 2,
};

/* One record per scheduler event. Field names here are exactly what the
 * JS side reads off the decoded object (yeet wraps it as `proc_evt`). */
struct proc_evt {
    __u64 ts_ns;             /* bpf_ktime_get_ns at emit */
    __u32 kind;              /* enum evt_kind */
    __u32 pid;               /* tgid (the "process id") */
    __u32 ppid;              /* parent tgid */
    __u32 uid;               /* effective-ish uid from task creds */
    __u32 exit_code;         /* raw task->exit_code (EXIT only) */
    __u64 cgroup_id;         /* kernfs id of the leaf cgroup */
    char  comm[COMM_LEN];    /* this task's comm (post-exec name on EXEC) */
    char  pcomm[COMM_LEN];   /* parent's comm */
    char  filename[FILE_LEN];/* execve target path (EXEC only) */
    char  cgroup[CG_LEN];    /* leaf cgroup kernfs name (container id, if any) */
};

/* clang can drop BTF for a struct only reached through a local pointer.
 * Anchor it in a __used global so the ring-buf bind can resolve it by name
 * via `btf_struct` (same trick airtop uses for its event structs). */
__attribute__((used)) static const struct proc_evt __proc_evt_anchor;

struct {
    __uint(type, BPF_MAP_TYPE_RINGBUF);
    __uint(max_entries, 1 << 18);
} events SEC(".maps");

/* Fill the parts every event shares. `self` is the task the event is
 * "about" (the child on FORK, the execing/exiting task otherwise). */
static __always_inline void
fill_common(struct proc_evt *e, struct task_struct *self)
{
    e->ts_ns     = bpf_ktime_get_ns();
    e->pid       = BPF_CORE_READ(self, tgid);
    e->ppid      = BPF_CORE_READ(self, real_parent, tgid);
    e->uid       = BPF_CORE_READ(self, cred, uid.val);
    e->exit_code = 0;
    e->cgroup_id = BPF_CORE_READ(self, cgroups, dfl_cgrp, kn, id);
    e->filename[0] = '\0';
    e->cgroup[0]   = '\0';
    BPF_CORE_READ_STR_INTO(&e->comm,  self, comm);
    BPF_CORE_READ_STR_INTO(&e->pcomm, self, real_parent, comm);
    /* cgroup-v2 leaf kernfs name. On docker (cgroupfs driver) this is the
     * 64-hex container id; on the systemd driver it's docker-<id>.scope.
     * Empty on pure cgroup-v1 hosts — userspace treats that as "host". */
    BPF_CORE_READ_STR_INTO(&e->cgroup, self, cgroups, dfl_cgrp, kn, name);
}

/* execve completed: task->comm and creds already reflect the new image.
 * `bprm->filename` is the path that was executed. */
SEC("tp_btf/sched_process_exec")
int BPF_PROG(on_exec, struct task_struct *p, pid_t old_pid,
             struct linux_binprm *bprm)
{
    struct proc_evt *e = bpf_ringbuf_reserve(&events, sizeof(*e), 0);
    if (!e)
        return 0;

    e->kind = EVT_EXEC;
    fill_common(e, p);
    if (bprm)
        BPF_CORE_READ_STR_INTO(&e->filename, bprm, filename);

    bpf_ringbuf_submit(e, 0);
    return 0;
}

/* a new task was forked. Fires for userspace fork()/clone() *and* for
 * kthreadd spawning kernel workers — userspace tells the two apart by
 * cgroup/ppid. On FORK the child's comm is still the parent's until it
 * execs; the EXEC event that usually follows carries the real name. */
SEC("tp_btf/sched_process_fork")
int BPF_PROG(on_fork, struct task_struct *parent, struct task_struct *child)
{
    struct proc_evt *e = bpf_ringbuf_reserve(&events, sizeof(*e), 0);
    if (!e)
        return 0;

    e->kind = EVT_FORK;
    fill_common(e, child);
    /* fill_common read ppid from child->real_parent; pin it to the actual
     * forking task in case the child was already reparented. */
    e->ppid = BPF_CORE_READ(parent, tgid);
    BPF_CORE_READ_STR_INTO(&e->pcomm, parent, comm);

    bpf_ringbuf_submit(e, 0);
    return 0;
}

/* a task exited. The tracepoint fires per-thread; emit only for the
 * thread-group leader so the feed is process exits, not thread teardown. */
SEC("tp_btf/sched_process_exit")
int BPF_PROG(on_exit, struct task_struct *p)
{
    __u32 pid  = BPF_CORE_READ(p, pid);
    __u32 tgid = BPF_CORE_READ(p, tgid);
    if (pid != tgid)
        return 0;

    struct proc_evt *e = bpf_ringbuf_reserve(&events, sizeof(*e), 0);
    if (!e)
        return 0;

    e->kind = EVT_EXIT;
    fill_common(e, p);
    e->exit_code = BPF_CORE_READ(p, exit_code);

    bpf_ringbuf_submit(e, 0);
    return 0;
}

char LICENSE[] SEC("license") = "GPL";
