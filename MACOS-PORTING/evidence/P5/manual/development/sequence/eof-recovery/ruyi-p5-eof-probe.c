#include <poll.h>
#include <stdio.h>
#include <sys/event.h>
#include <unistd.h>
#include <string.h>
int main(int argc,char **argv) {
 if(argc>1 && strcmp(argv[1],"kqueue")==0) {
  int queue=kqueue();struct kevent change,event;EV_SET(&change,STDIN_FILENO,EVFILT_READ,EV_ADD|EV_CLEAR,0,0,NULL);
  struct timespec timeout={1,0};int result=kevent(queue,&change,1,&event,1,&timeout);
  printf("kqueue result=%d flags=%u eof=%d data=%ld\n",result,result>0?event.flags:0,result>0 && (event.flags&EV_EOF),(long)(result>0?event.data:0));close(queue);
 } else {
  struct pollfd input={.fd=STDIN_FILENO,.events=(argc>1?POLLIN:0),.revents=0};int result=poll(&input,1,1000);
  printf("poll result=%d revents=%d hup=%d\n",result,input.revents,(input.revents&POLLHUP)!=0);
 }
 return 0;
}
