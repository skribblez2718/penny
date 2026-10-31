#define _GNU_SOURCE
#include <errno.h>
#include <sched.h>
#include <sys/mount.h>
#include <sys/syscall.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#ifndef MODE
#define MODE 0
#endif
/* Test-only static fixed driver. NOT Kdenlive automation or qualification. */
int main(int argc, char **argv) {
  if (argc != 2) return 8;
  if (access("/etc/passwd", F_OK) == 0 || access("/proc/self/environ", F_OK) == 0) return 12;
  if (strcmp(argv[1], "relocate_reopen_readback") == 0 && access("/input/project.kdenlive", F_OK) == 0) return 13;
  if (MODE == 6) {
    errno=0; if(syscall(SYS_unshare,CLONE_NEWUSER|CLONE_NEWNS)!=-1 || errno!=EPERM) return 24;
    errno=0; if(mount("tmpfs","/work/tmp","tmpfs",0,"size=1048576")!=-1 || errno!=EPERM) return 25;
    errno=0; if(syscall(SYS_memfd_create,"uncapped",0)!=-1 || errno!=EPERM) return 26;
    FILE *escape=fopen("/escape","wb"); if(escape) { fclose(escape); return 27; }
    fputs("mount and memfd escapes denied",stdout); return 0;
  }
  if (MODE == 5) {
    char block[4096]; memset(block, 'x', sizeof(block));
    size_t total=0; int full=0;
    for(int i=0;i<32 && !full;i++) {
      char name[64]; snprintf(name,sizeof(name),"%s/aggregate-%d", i%2 ? "/work" : "/tmp",i);
      FILE *out=fopen(name,"wb"); if(!out) return 20;
      for(int j=0;j<4;j++) { size_t n=fwrite(block,1,sizeof(block),out); total+=n;
        if(n!=sizeof(block)) { if(errno!=ENOSPC) return 21; full=1; break; } }
      if(fclose(out)!=0) { if(errno!=ENOSPC) return 22; full=1; }
    }
    if(!full || total>65536) return 23;
    fputs("aggregate ENOSPC",stdout); return 0;
  }
  if (MODE == 1) { sleep(30); return 9; }
  if (MODE == 2) abort();
  if (MODE == 3) { for (int i=0;i<100000;i++) putchar('x'); return 0; }
  if (MODE == 4) { fputs("wrong bytes",stdout); return 0; }
  if (strcmp(argv[1],"render_compare") == 0) { fputs("synthetic render, NOT qualified AV",stdout); return 0; }
  FILE *f=fopen("project.kdenlive","rb"); if(!f) return 10;
  int ch; while((ch=fgetc(f))!=EOF) if(putchar(ch)==EOF) return 11;
  fclose(f); return 0;
}
