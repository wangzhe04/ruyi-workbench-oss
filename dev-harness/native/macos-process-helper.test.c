// Exercise private stop/restore primitives against real owned processes without a production test hook.
#define main helper_cli_main
#include "../../ruyi-workbench/resources/macos-process-helper.c"
#undef main
#include <sys/wait.h>

static bool wait_stopped(pid_t pid, bool expected) {
    for (int i = 0; i < 200; i++) {
        ProcessRow row;
        if (read_process(pid, &row) && row.is_stopped == expected) return true;
        usleep(1000);
    }
    return false;
}

int main(void) {
    pid_t child = fork();
    if (child < 0) return 2;
    if (child == 0) { for (;;) pause(); }
    ProcessRow row;
    int failures = 0;
    if (!read_process(child, &row)) { kill(child, SIGKILL); waitpid(child, NULL, 0); return 2; }

    if (signal_verified(&row, SIGSTOP) != 1 || !wait_stopped(child, true)) failures++;
    if (!read_process(child, &row)) failures++;
    // A user/debugger already stopped this target. Interrupted cleanup must preserve that state.
    row.resume_after_stop = signal_verified(&row, SIGSTOP) == 1;
    resume_stopped(&row, 1);
    if (row.resume_after_stop || !wait_stopped(child, true)) failures++;
    puts("CHECK pre-stopped target stays stopped");

    if (signal_verified(&row, SIGCONT) != 1 || !wait_stopped(child, false)) failures++;
    if (!read_process(child, &row)) failures++;
    row.resume_after_stop = signal_verified(&row, SIGSTOP) == 1;
    if (!row.resume_after_stop || !await_quiescent(&row, monotonic_milliseconds() + 100) || !wait_stopped(child, true)) failures++;
    resume_stopped(&row, 1);
    if (!wait_stopped(child, false)) failures++;
    puts("CHECK helper-stopped target resumes on interrupted cleanup");

    ProcessRow stale = row;
    stale.created++;
    if (!contains_identity(&row, 1, &row) || contains_identity(&row, 1, &stale)) failures++;
    puts("CHECK reused PID remains a distinct observed identity");
    if (signal_verified(&stale, SIGKILL) != 0 || !read_process(child, &row)) failures++;
    puts("CHECK changed creation identity rejects signal");
    if (identity_exited(&row) || !identity_exited(&stale)) failures++;
    puts("CHECK live identity remains unconfirmed and replaced identity has exited");
    (void)signal_verified(&row, SIGKILL);
    row.termination_requested = true;
    if (confirm_exits(&row, 1) != 0) failures++;
    puts("CHECK termination is confirmed before reporting completion");
    waitpid(child, NULL, 0);
    return failures ? 1 : 0;
}
