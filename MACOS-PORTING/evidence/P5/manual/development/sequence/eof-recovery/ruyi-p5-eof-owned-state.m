#import <ApplicationServices/ApplicationServices.h>
#include <stdio.h>
int main(void) {
 printf("flags=%llu left=%d right=%d middle=%d held_keys=", CGEventSourceFlagsState(kCGEventSourceStateHIDSystemState),CGEventSourceButtonState(kCGEventSourceStateHIDSystemState,0),CGEventSourceButtonState(kCGEventSourceStateHIDSystemState,1),CGEventSourceButtonState(kCGEventSourceStateHIDSystemState,2));
 for(CGKeyCode key=0;key<128;key++) if(CGEventSourceKeyState(kCGEventSourceStateHIDSystemState,key)) printf("%u,",key);
 puts("");
}
