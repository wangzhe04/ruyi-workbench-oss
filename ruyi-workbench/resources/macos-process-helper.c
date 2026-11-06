// Ruyi's macOS process identity and observed-descendant cleanup helper.
// Uses only public libproc/POSIX APIs. No process names or command lines are emitted.
#include <errno.h>
#include <inttypes.h>
#include <limits.h>
#include <libproc.h>
#include <signal.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/proc.h>
#include <sys/proc_info.h>
#include <unistd.h>
#include <time.h>
#include <fcntl.h>
#include <poll.h>
#include <sys/stat.h>
#include <sys/wait.h>

#define MAX_ROWS 32768
#define MAX_PASSES 8

typedef struct {
    pid_t pid;
    pid_t ppid;
    pid_t pgid;
    uint64_t created;
    bool zombie;
    bool is_stopped;
    bool resume_after_stop;
    bool termination_requested;
} ProcessRow;

static volatile sig_atomic_t interrupted = 0;

static void on_interrupt(int signal_number) {
    (void)signal_number;
    interrupted = 1;
}

static bool read_process(pid_t pid, ProcessRow *row) {
    struct proc_bsdinfo info;
    errno = 0;
    int count = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info));
    if (count != sizeof(info)) { if (!errno) errno = EIO; return false; }
    if (info.pbi_uid != getuid()) { errno = EPERM; return false; }
    row->pid = pid;
    row->ppid = (pid_t)info.pbi_ppid;
    row->pgid = (pid_t)info.pbi_pgid;
    row->created = info.pbi_start_tvsec * UINT64_C(1000000) + info.pbi_start_tvusec;
    row->zombie = info.pbi_status == SZOMB;
    row->is_stopped = info.pbi_status == SSTOP;
    row->resume_after_stop = false;
    row->termination_requested = false;
    if (!row->created) { errno = EIO; return false; }
    return true;
}

static ProcessRow *snapshot(size_t *length) {
    pid_t *pids = calloc(MAX_ROWS, sizeof(*pids));
    ProcessRow *rows = calloc(MAX_ROWS, sizeof(*rows));
    if (!pids || !rows) { free(pids); free(rows); return NULL; }
    int count = proc_listallpids(pids, MAX_ROWS * sizeof(*pids));
    if (count <= 0 || count >= MAX_ROWS) { free(pids); free(rows); return NULL; }
    *length = 0;
    for (int i = 0; i < count && !interrupted; i++) {
        if (pids[i] > 1 && read_process(pids[i], &rows[*length])) (*length)++;
    }
    free(pids);
    if (interrupted) { free(rows); return NULL; }
    return rows;
}

// 1 = signalled, 0 = exited or PID identity changed, -1 = signal failed.
static int signal_verified(const ProcessRow *expected, int signal_number) {
    ProcessRow current;
    if (!read_process(expected->pid, &current)) return errno == ESRCH ? 0 : -1;
    if (current.created != expected->created || current.zombie) return 0;
    if (signal_number == SIGSTOP && current.is_stopped) return 0;
    if (kill(expected->pid, signal_number) == 0) return 1;
    return errno == ESRCH ? 0 : -1;
}

static bool contains_identity(const ProcessRow *rows, size_t length, const ProcessRow *candidate) {
    for (size_t i = 0; i < length; i++) {
        if (rows[i].pid == candidate->pid && rows[i].created == candidate->created) return true;
    }
    return false;
}

static void resume_stopped(ProcessRow *rows, size_t length) {
    for (size_t i = length; i > 0; i--) {
        if (rows[i - 1].resume_after_stop) (void)signal_verified(&rows[i - 1], SIGCONT);
    }
}

// Confirm identity disappearance or zombie state. A successful kill syscall alone is insufficient.
static bool identity_exited(const ProcessRow *expected) {
    ProcessRow current;
    if (!read_process(expected->pid, &current)) return errno == ESRCH;
    return current.created != expected->created || current.zombie;
}

static uint64_t monotonic_milliseconds(void) {
    struct timespec now;
    if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) return 0;
    return (uint64_t)now.tv_sec * 1000 + (uint64_t)now.tv_nsec / 1000000;
}

static size_t confirm_exits(const ProcessRow *rows, size_t length) {
    uint64_t started = monotonic_milliseconds();
    size_t terminated = 0, already_exited = 0, unconfirmed = length;
    do {
        terminated = 0; already_exited = 0; unconfirmed = 0;
        for (size_t i = 0; i < length; i++) {
            uint64_t scan_time = monotonic_milliseconds();
            if (interrupted || !started || !scan_time || scan_time - started >= 500) {
                unconfirmed += length - i;
                break;
            }
            if (!identity_exited(&rows[i])) unconfirmed++;
            else if (rows[i].termination_requested) terminated++;
            else already_exited++;
        }
        uint64_t now = monotonic_milliseconds();
        if (!unconfirmed || interrupted || !started || !now || now - started >= 500) break;
        usleep(10000);
    } while (true);
    printf("EXIT-COUNTS %zu %zu %zu\n", terminated, already_exited, unconfirmed);
    return unconfirmed;
}

// A queued SIGSTOP does not establish a fork barrier until the process is stopped.
static bool await_quiescent(const ProcessRow *expected, uint64_t deadline) {
    uint64_t started = monotonic_milliseconds();
    do {
        ProcessRow current;
        if (!read_process(expected->pid, &current)) return errno == ESRCH;
        if (current.created != expected->created || current.zombie || current.is_stopped) return true;
        uint64_t now = monotonic_milliseconds();
        if (interrupted || !started || !now || now - started >= 100 || now >= deadline) return false;
        usleep(1000);
    } while (true);
}

static int terminate_child_tree(pid_t pid) {
    ProcessRow root;
    ProcessRow owner;
    pid_t owner_pid = getppid();
    if (owner_pid <= 1 || !read_process(owner_pid, &owner)) {
        puts("REFUSED caller-identity-unavailable"); return 3;
    }
    if (!read_process(pid, &root)) {
        if (errno == ESRCH) { puts("ROOT-GONE"); return 0; }
        puts("REFUSED root-identity-unavailable"); return 3;
    }
    // A raw PID cannot authorize an unrelated tree. Only the caller's direct child is admitted.
    if (pid <= 1 || pid == getpid() || pid == owner_pid || root.ppid != owner_pid
        || root.created < owner.created || getppid() != owner_pid) {
        puts("REFUSED root-not-owned"); return 3;
    }
    ProcessRow *known = calloc(MAX_ROWS, sizeof(*known));
    if (!known) return 4;
    known[0] = root;
    size_t length = 1;
    bool incomplete = false;
    bool stable = false;
    int frozen = signal_verified(&known[0], SIGSTOP);
    if (frozen < 0) { free(known); puts("INCOMPLETE root-stop-failed"); return 4; }
    known[0].resume_after_stop = frozen == 1;
    if (!await_quiescent(&known[0], monotonic_milliseconds() + 100)) incomplete = true;

    // Freeze parents before walking successive snapshots, limiting new forks while collecting.
    // Recheck creation timestamps before every signal, including cleanup after an interrupted helper.
    for (int pass = 0; pass < MAX_PASSES && !interrupted; pass++) {
        size_t table_length = 0;
        ProcessRow *table = snapshot(&table_length);
        if (!table) { incomplete = true; break; }
        size_t before = length;
        for (size_t parent = 0; parent < length && !interrupted; parent++) {
            ProcessRow current;
            if (!read_process(known[parent].pid, &current) || current.created != known[parent].created) continue;
            // A live session leader anchors an isolated group even after a command parent exits.
            bool anchors_group = current.pgid == current.pid && getsid(current.pid) == current.pid;
            for (size_t i = 0; i < table_length && !interrupted; i++) {
                bool child_or_group = table[i].ppid == current.pid || (anchors_group && table[i].pgid == current.pid);
                if (!child_or_group || table[i].pid == getpid() || table[i].created < current.created
                    || contains_identity(known, length, &table[i])) continue;
                if (length == MAX_ROWS) { incomplete = true; break; }
                known[length] = table[i];
                frozen = signal_verified(&known[length], SIGSTOP);
                known[length].resume_after_stop = frozen == 1;
                if (frozen < 0 || !await_quiescent(&known[length], monotonic_milliseconds() + 100)) incomplete = true;
                length++;
            }
        }
        free(table);
        if (length == before) { stable = true; break; }
    }
    if (interrupted) {
        resume_stopped(known, length); free(known);
        puts("INCOMPLETE helper-interrupted"); return 4;
    }
    if (!stable) incomplete = true;
    size_t killed = 0;
    for (size_t i = length; i > 0 && !interrupted; i--) {
        int result = signal_verified(&known[i - 1], SIGKILL);
        if (result < 0) incomplete = true;
        if (result == 1) {
            known[i - 1].termination_requested = true;
            printf("KILLED %d\n", known[i - 1].pid); killed++;
        }
    }
    resume_stopped(known, length);
    if (confirm_exits(known, length) > 0) incomplete = true;
    free(known);
    printf("OBSERVED-TREE %zu %zu\n", length, killed);
    if (incomplete || interrupted) { puts("INCOMPLETE cleanup-unconfirmed"); return 4; }
    return 0;
}

// The supervisor remains the session/group anchor after the executable exits. The private
// socket is closed before exec, so target stdout and descendants cannot forge control frames.
static void supervisor_report(int fd, const char *event, int value, int detail) {
    char message[160];
    int length = snprintf(message, sizeof(message), "{\"event\":\"%s\",\"value\":%d,\"detail\":%d}\n", event, value, detail);
    if (length > 0 && length < (int)sizeof(message)) (void)write(fd, message, (size_t)length);
}

static bool collect_supervised(ProcessRow *known, size_t *length, const ProcessRow *anchor, bool freeze) {
    size_t table_length = 0;
    ProcessRow *table = snapshot(&table_length);
    if (!table) return false;
    bool complete = true;
    uint64_t collection_started = monotonic_milliseconds();
    uint64_t deadline = collection_started + 500;
    for (size_t i = 0; i < table_length; i++) {
        uint64_t now = monotonic_milliseconds();
        if (interrupted || !collection_started || !now || now >= deadline) { complete = false; break; }
        ProcessRow candidate = table[i];
        if (candidate.pid == anchor->pid || candidate.pid == getpid() || candidate.created < anchor->created
            || contains_identity(known, *length, &candidate)) continue;
        bool owned = candidate.pgid == anchor->pid;
        for (size_t parent = 0; !owned && parent < *length; parent++) {
            if (candidate.ppid != known[parent].pid || candidate.created < known[parent].created) continue;
            ProcessRow current;
            owned = read_process(known[parent].pid, &current) && current.created == known[parent].created;
        }
        if (!owned) continue;
        if (*length == MAX_ROWS) { complete = false; break; }
        known[*length] = candidate;
        if (freeze) {
            int stopped = signal_verified(&known[*length], SIGSTOP);
            known[*length].resume_after_stop = stopped == 1;
            if (stopped < 0 || !await_quiescent(&known[*length], deadline)) complete = false;
        }
        (*length)++;
    }
    free(table);
    return complete;
}

typedef struct {
    bool complete;
    size_t unconfirmed;
    size_t terminated;
    size_t already_exited;
} CleanupResult;

static CleanupResult cleanup_supervised(ProcessRow *known, size_t *known_length, const ProcessRow *anchor, bool complete) {
    size_t length = *known_length;
    // Cancellation/owner EOF initiates cleanup too. Subsequent interrupts retain truthful failure.
    interrupted = 0;
    uint64_t freeze_deadline = monotonic_milliseconds() + 500;
    for (size_t i = 0; i < length; i++) {
        int stopped = signal_verified(&known[i], SIGSTOP);
        known[i].resume_after_stop = stopped == 1;
        if (stopped < 0 || !await_quiescent(&known[i], freeze_deadline)) complete = false;
    }
    bool stable = false;
    for (int pass = 0; pass < MAX_PASSES && !interrupted; pass++) {
        size_t before = length;
        if (!collect_supervised(known, &length, anchor, true)) complete = false;
        if (before == length) { stable = true; break; }
    }
    if (!stable) complete = false;
    for (size_t i = length; i > 0; i--) {
        int killed = signal_verified(&known[i - 1], SIGKILL);
        known[i - 1].termination_requested = killed == 1;
        if (killed < 0) complete = false;
    }
    resume_stopped(known, length);
    uint64_t cleanup_started = monotonic_milliseconds();
    uint64_t deadline = cleanup_started + 500;
    size_t unconfirmed, terminated, already_exited;
    do {
        unconfirmed = 0; terminated = 0; already_exited = 0;
        for (size_t i = 0; i < length; i++) {
            uint64_t now = monotonic_milliseconds();
            if (interrupted || !cleanup_started || !now || now >= deadline) { unconfirmed += length - i; break; }
            if (!identity_exited(&known[i])) unconfirmed++;
            else if (known[i].termination_requested) terminated++;
            else already_exited++;
        }
        uint64_t now = monotonic_milliseconds();
        if (!unconfirmed || interrupted || !cleanup_started || !now || now >= deadline) break;
        usleep(10000);
    } while (true);
    *known_length = length;
    return (CleanupResult){ .complete = complete && !unconfirmed && !interrupted,
        .unconfirmed = unconfirmed, .terminated = terminated, .already_exited = already_exited };
}

static int supervise(int control_fd, char **command, int extra_fds, const ProcessRow *guardian, uint64_t deadline_ms) {
    uint64_t started = monotonic_milliseconds();
    if (deadline_ms && !started) return 125;
    struct stat control_stat;
    if (fstat(control_fd, &control_stat) != 0 || !S_ISSOCK(control_stat.st_mode)) return 125;
    for (int i = 0; i < extra_fds; i++) {
        struct stat private_stat;
        if (fstat(4 + i, &private_stat) != 0 || !S_ISSOCK(private_stat.st_mode)) return 125;
    }
    int flags = fcntl(control_fd, F_GETFL);
    if (flags < 0 || fcntl(control_fd, F_SETFL, flags | O_NONBLOCK) != 0) return 125;
    ProcessRow anchor;
    if (guardian) anchor = *guardian;
    else {
        if (setsid() < 0) { supervisor_report(control_fd, "error", errno, 0); return 125; }
        if (!read_process(getpid(), &anchor)) return 125;
    }
    ProcessRow *known = calloc(MAX_ROWS, sizeof(*known));
    if (!known) return 125;
    int exec_status[2];
    if (pipe(exec_status) != 0) { free(known); return 125; }
    if (fcntl(exec_status[1], F_SETFD, FD_CLOEXEC) != 0) {
        close(exec_status[0]); close(exec_status[1]); free(known); return 125;
    }
    int admission[2];
    if (pipe(admission) != 0) { close(exec_status[0]); close(exec_status[1]); free(known); return 125; }
    pid_t child = fork();
    if (child < 0) { close(admission[0]); close(admission[1]); close(exec_status[0]); close(exec_status[1]); free(known); return 125; }
    if (child == 0) {
        close(control_fd); close(exec_status[0]); close(admission[1]);
        char admitted;
        if (read(admission[0], &admitted, 1) != 1) _exit(125);
        close(admission[0]);
        signal(SIGTERM, SIG_DFL); signal(SIGINT, SIG_DFL); signal(SIGPIPE, SIG_DFL);
        execvp(command[0], command);
        int error = errno;
        (void)write(exec_status[1], &error, sizeof(error));
        _exit(127);
    }
    close(exec_status[1]); close(admission[0]);
    // Private shell result channels belong to the target. Keeping them here would delay EOF.
    for (int i = 0; i < extra_fds; i++) close(4 + i);
    size_t length = 0;
    bool complete = read_process(child, &known[0]);
    if (complete) length = 1;
    if (complete) (void)write(admission[1], "1", 1);
    close(admission[1]);
    // The supervisor must not retain stdio pipes after its executable closes them.
    close(STDIN_FILENO); close(STDOUT_FILENO); close(STDERR_FILENO);
    int exec_error = 0;
    ssize_t error_bytes;
    do { error_bytes = read(exec_status[0], &exec_error, sizeof(exec_error)); } while (error_bytes < 0 && errno == EINTR && !interrupted);
    close(exec_status[0]);
    if (error_bytes > 0) supervisor_report(control_fd, "error", exec_error, 0);
    else if (complete) {
        char message[160];
        int size = snprintf(message, sizeof(message), "{\"event\":\"started\",\"value\":%d,\"created\":\"%" PRIu64 "\"}\n", child, known[0].created);
        if (size > 0 && size < (int)sizeof(message)) (void)write(control_fd, message, (size_t)size);
    }
    bool exited = false;
    int status = 0;
    while (!interrupted) {
        if (!collect_supervised(known, &length, &anchor, false)) complete = false;
        pid_t waited = waitpid(child, &status, WNOHANG);
        if (waited == child) { exited = true; break; }
        if (waited < 0 && errno != EINTR) { complete = false; break; }
        uint64_t now = monotonic_milliseconds();
        if (deadline_ms && (!now || now - started >= deadline_ms)) {
            if (!now) complete = false;
            supervisor_report(control_fd, "deadline", 1, 0);
            break;
        }
        struct pollfd control = { .fd = control_fd, .events = POLLIN };
        int ready = poll(&control, 1, 20);
        if (ready > 0) {
            char buffer[32];
            ssize_t count = read(control_fd, buffer, sizeof(buffer));
            if (count >= 0 || (errno != EAGAIN && errno != EINTR)) break;
        } else if (ready < 0 && errno != EINTR) { complete = false; break; }
    }
    CleanupResult cleanup = cleanup_supervised(known, &length, &anchor, complete);
    complete = cleanup.complete;
    size_t unconfirmed = cleanup.unconfirmed, terminated = cleanup.terminated, already_exited = cleanup.already_exited;
    if (!exited) {
        pid_t waited = waitpid(child, &status, WNOHANG);
        exited = waited == child;
    }
    if (!exited || unconfirmed || interrupted) complete = false;
    char cleanup_message[240];
    int cleanup_size = snprintf(cleanup_message, sizeof(cleanup_message),
        "{\"event\":\"cleanup\",\"value\":%zu,\"detail\":%d,\"terminated\":%zu,\"alreadyExited\":%zu,\"observed\":%zu}\n",
        unconfirmed, complete ? 1 : 0, terminated, already_exited, length);
    if (cleanup_size > 0 && cleanup_size < (int)sizeof(cleanup_message)) (void)write(control_fd, cleanup_message, (size_t)cleanup_size);
    supervisor_report(control_fd, "exit", exited && WIFEXITED(status) ? WEXITSTATUS(status) : -1,
        exited && WIFSIGNALED(status) ? WTERMSIG(status) : 0);
    free(known);
    close(control_fd);
    if (exited && WIFSIGNALED(status)) {
        int term_signal = WTERMSIG(status);
        signal(term_signal, SIG_DFL);
        kill(getpid(), term_signal);
        return 128 + term_signal;
    }
    return exited && WIFEXITED(status) ? WEXITSTATUS(status) : 125;
}

// Keep a live session/group anchor independent of the primary supervisor. Its death
// cannot orphan an unobserved same-group target between fork and the first snapshot.
static int supervise_guarded(int control_fd, char **command, int extra_fds, uint64_t deadline_ms) {
    uint64_t started = monotonic_milliseconds();
    if (deadline_ms && !started) return 125;
    struct stat control_stat;
    if (fstat(control_fd, &control_stat) != 0 || !S_ISSOCK(control_stat.st_mode)) return 125;
    if (setsid() < 0) return 125;
    ProcessRow anchor;
    if (!read_process(getpid(), &anchor)) return 125;
    ProcessRow *known = calloc(MAX_ROWS, sizeof(*known));
    if (!known) return 125;
    pid_t primary = fork();
    if (primary < 0) { free(known); return 125; }
    if (primary == 0) {
        free(known);
        return supervise(control_fd, command, extra_fds, &anchor, deadline_ms);
    }
    close(STDIN_FILENO); close(STDOUT_FILENO); close(STDERR_FILENO);
    for (int i = 0; i < extra_fds; i++) close(4 + i);
    // Only the primary reads owner cancellation. Retaining the write endpoint keeps
    // Node's completion pending until the guardian's own cleanup has finished.
    size_t length = 0;
    bool complete = true, exited = false;
    int status = 0;
    while (!interrupted) {
        if (!collect_supervised(known, &length, &anchor, false)) complete = false;
        pid_t waited = waitpid(primary, &status, WNOHANG);
        if (waited == primary) { exited = true; break; }
        if (waited < 0 && errno != EINTR) { complete = false; break; }
        // Give primary cleanup a bounded grace period, then recover even if it is
        // stopped or blocked in the exec handshake. Missing primary frames remain visible.
        uint64_t now = monotonic_milliseconds();
        if (deadline_ms && (!now || now - started >= deadline_ms + 1500)) {
            if (!now) complete = false;
            break;
        }
        usleep(20000);
    }
    CleanupResult cleanup = cleanup_supervised(known, &length, &anchor, complete);
    if (!exited) exited = waitpid(primary, &status, WNOHANG) == primary;
    char report[240];
    int report_size = snprintf(report, sizeof(report),
        "{\"event\":\"guardian-cleanup\",\"value\":%zu,\"detail\":%d,\"terminated\":%zu,\"alreadyExited\":%zu,\"observed\":%zu}\n",
        cleanup.unconfirmed, cleanup.complete && exited ? 1 : 0, cleanup.terminated, cleanup.already_exited, length);
    if (report_size > 0 && report_size < (int)sizeof(report)) (void)write(control_fd, report, (size_t)report_size);
    free(known);
    close(control_fd);
    if (exited && WIFSIGNALED(status)) {
        int term_signal = WTERMSIG(status);
        signal(term_signal, SIG_DFL);
        kill(getpid(), term_signal);
        return 128 + term_signal;
    }
    return exited && WIFEXITED(status) ? WEXITSTATUS(status) : 125;
}

int main(int argc, char **argv) {
    signal(SIGTERM, on_interrupt);
    signal(SIGINT, on_interrupt);
    signal(SIGPIPE, on_interrupt);
    if (argc >= 3 && strcmp(argv[1], "--supervise-v2") == 0) return supervise_guarded(3, &argv[2], 0, 0);
    if (argc >= 4 && strcmp(argv[1], "--supervise-v2-with-fds") == 0 && strcmp(argv[2], "1") == 0) return supervise_guarded(3, &argv[3], 1, 0);
    if (argc >= 4 && strcmp(argv[1], "--supervise-v2-deadline") == 0) {
        char *end = NULL;
        errno = 0;
        unsigned long deadline = strtoul(argv[2], &end, 10);
        if (errno || !end || *end || argv[2][0] < '0' || argv[2][0] > '9' || deadline > INT_MAX) return 2;
        return supervise_guarded(3, &argv[3], 0, (uint64_t)deadline);
    }
    if (argc == 2 && strcmp(argv[1], "--capabilities") == 0) {
        ProcessRow self;
        if (!read_process(getpid(), &self) || !self.created) return 4;
        puts("{\"protocolVersion\":2,\"guardian\":true,\"supervise\":true,\"privateFd\":true,\"identityCleanup\":true,\"deadline\":true,\"escapeCoverage\":\"observed-only\"}");
        return 0;
    }
    if (argc >= 3 && strcmp(argv[1], "--supervise-v1") == 0) return supervise(3, &argv[2], 0, NULL, 0);
    if (argc >= 4 && strcmp(argv[1], "--supervise-v1-with-fds") == 0 && strcmp(argv[2], "1") == 0) return supervise(3, &argv[3], 1, NULL, 0);
    if (argc >= 3 && strcmp(argv[1], "--supervise") == 0) return supervise(3, &argv[2], 0, NULL, 0);
    if (argc >= 4 && strcmp(argv[1], "--supervise-with-fds") == 0 && strcmp(argv[2], "1") == 0) return supervise(3, &argv[3], 1, NULL, 0);
    puts("RUYI-PROCESS-V1");
    if (argc == 2 && strcmp(argv[1], "--snapshot") == 0) {
        size_t length = 0;
        ProcessRow *rows = snapshot(&length);
        if (!rows) return 4;
        for (size_t i = 0; i < length && !interrupted; i++) {
            printf("%d,%d,%" PRIu64 ",%s\n", rows[i].pid, rows[i].ppid, rows[i].created,
                rows[i].zombie ? "zombie" : "");
        }
        free(rows);
        return interrupted ? 4 : 0;
    }
    if (argc == 3 && strcmp(argv[1], "--terminate-child-tree") == 0) {
        char *end = NULL;
        errno = 0;
        long pid = strtol(argv[2], &end, 10);
        if (errno || !end || *end || argv[2][0] < '0' || argv[2][0] > '9' || pid <= 1 || pid > INT_MAX) return 2;
        return terminate_child_tree((pid_t)pid);
    }
    fputs("usage: ruyi-process-helper --snapshot | --terminate-child-tree PID\n", stderr);
    return 2;
}
