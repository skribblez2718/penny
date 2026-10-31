/* Disposable security-test executable. UNTRUSTED: execute only inside the media sandbox. */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <sys/syscall.h>
#include <unistd.h>
#include <pthread.h>
#include <stdatomic.h>
#include <linux/perf_event.h>
#include <sched.h>
#include <sys/mount.h>
#include <sys/ptrace.h>
#include <sys/uio.h>
static atomic_int stop_threads;
static void *wait_thread(void *ignored) { (void)ignored; while (!atomic_load(&stop_threads)) usleep(1000); return NULL; }

int main(void) {
  char payload[4096] = {0};
  FILE *input = fopen("/input/media", "rb");
  if (!input) return 70;
  size_t n = fread(payload, 1, sizeof(payload) - 1, input); fclose(input);
  if (!n) return 71;
  if (payload[0] == 'U') {
    errno = 0; int unshared = syscall(SYS_unshare, CLONE_NEWUSER) < 0 && errno == EPERM;
    errno = 0; int joined = syscall(SYS_setns, -1, 0) < 0 && errno == EPERM;
    errno = 0; int mounted = mount("none", "/input", "tmpfs", 0, NULL) < 0 && errno == EPERM;
    errno = 0; int traced = ptrace(PTRACE_TRACEME, 0, NULL, NULL) < 0 && errno == EPERM;
    errno = 0; int init = syscall(SYS_init_module, payload, 1, "") < 0 && errno == EPERM;
    errno = 0; int finit = syscall(SYS_finit_module, -1, "", 0) < 0 && errno == EPERM;
    errno = 0; int deleted = syscall(SYS_delete_module, "penny_nonexistent_probe", 0) < 0 && errno == EPERM;
    printf("{\"unshare_denied\":%s,\"setns_denied\":%s,\"mount_denied\":%s,\"ptrace_denied\":%s,\"init_module_denied\":%s,\"finit_module_denied\":%s,\"delete_module_denied\":%s}",
      unshared ? "true" : "false", joined ? "true" : "false", mounted ? "true" : "false", traced ? "true" : "false",
      init ? "true" : "false", finit ? "true" : "false", deleted ? "true" : "false"); return 0;
  }
  if (payload[0] == 'H') {
    int host_pid = 0, host_fd = 0;
    if (sscanf(payload + 1, "%d %d", &host_pid, &host_fd) != 2 || host_pid < 1 || host_fd < 0) return 73;
    char filename[128];
    snprintf(filename, sizeof(filename), "/proc/%d/stat", host_pid);
    int stat_fd = open(filename, O_RDONLY);
    snprintf(filename, sizeof(filename), "/proc/%d/fd/%d", host_pid, host_fd);
    int borrowed = open(filename, O_RDONLY);
    snprintf(filename, sizeof(filename), "/proc/%d/mem", host_pid);
    int mem = open(filename, O_RDWR);
    struct perf_event_attr attr = {0};
    attr.type = PERF_TYPE_SOFTWARE; attr.size = sizeof(attr); attr.config = PERF_COUNT_SW_TASK_CLOCK;
    errno = 0; int perf = syscall(SYS_perf_event_open, &attr, host_pid, -1, -1, 0);
    int perf_denied = perf < 0 && errno == EPERM;
    errno = 0; int own = syscall(SYS_perf_event_open, &attr, 0, -1, -1, 0);
    int own_denied = own < 0 && errno == EPERM;
    printf("{\"host_stat_denied\":%s,\"host_fd_denied\":%s,\"host_mem_denied\":%s,\"host_perf_denied\":%s,\"self_perf_denied\":%s}",
      stat_fd < 0 ? "true" : "false", borrowed < 0 ? "true" : "false", mem < 0 ? "true" : "false",
      perf_denied ? "true" : "false", own_denied ? "true" : "false");
    if (stat_fd >= 0) close(stat_fd);
    if (borrowed >= 0) close(borrowed);
    if (mem >= 0) close(mem);
    if (perf >= 0) close(perf);
    if (own >= 0) close(own);
    return 0;
  }
  if (payload[0] == 'I') {
    int fd = (int)syscall(SYS_io_uring_setup, 1, NULL);
    int denied = fd < 0 && errno == EPERM;
    if (fd >= 0) close(fd);
    printf("%d", denied); return 0;
  }
  if (payload[0] == 'T') {
    pthread_t threads[128]; int n = 0;
    while (n < 128 && pthread_create(&threads[n], NULL, wait_thread, NULL) == 0) n++;
    atomic_store(&stop_threads, 1);
    for (int i = 0; i < n; i++) pthread_join(threads[i], NULL);
    printf("%d\n", n); return 0;
  }
  if (payload[0] == 'O' || payload[0] == 'E') {
    FILE *out = payload[0] == 'O' ? stdout : stderr;
    for (;;) { fputs("012345678901234567890123456789\n", out); fflush(out); }
  }
  if (payload[0] == 'S') { sleep(10); return 0; }
  if (payload[0] == 'C') { volatile unsigned long v = 0; for (;;) v++; }
  if (payload[0] == 'M') {
    void *p = malloc(1024UL * 1024UL * 1024UL);
    printf("%d", p == NULL); free(p); return 0;
  }
  const char *victim = payload + 1;
  int host = open(victim, O_RDONLY);
  int write_fd = open("/input/escape", O_WRONLY | O_CREAT, 0600);
  int proc = open("/proc/self/environ", O_RDONLY);
  int net = socket(AF_INET, SOCK_STREAM, 0); int net_errno = errno;
  pid_t child = fork(); int fork_errno = errno;
  if (child == 0) _exit(72);
  printf("{\"host_denied\":%s,\"write_denied\":%s,\"proc_denied\":%s,\"network_denied\":%s,\"fork_denied\":%s,\"secret_absent\":%s}",
    host < 0 ? "true" : "false", write_fd < 0 ? "true" : "false", proc < 0 ? "true" : "false",
    net < 0 && net_errno == EPERM ? "true" : "false", child < 0 && fork_errno == EPERM ? "true" : "false",
    getenv("VIDEOGEN_MEDIA_TEST_SECRET") == NULL ? "true" : "false");
  if (host >= 0) close(host);
  if (write_fd >= 0) close(write_fd);
  if (proc >= 0) close(proc);
  if (net >= 0) close(net);
  return 0;
}
