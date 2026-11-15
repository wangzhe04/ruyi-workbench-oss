// Release only the failed fixture's known left-button state, at its current cursor position.
#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
int main(void) { @autoreleasepool {
    CGEventFlags flags = CGEventSourceFlagsState(kCGEventSourceStateHIDSystemState);
    BOOL left = CGEventSourceButtonState(kCGEventSourceStateHIDSystemState, kCGMouseButtonLeft);
    BOOL shift = CGEventSourceKeyState(kCGEventSourceStateHIDSystemState, 56);
    if (flags != 537001984 || !left || !shift || CGEventSourceKeyState(kCGEventSourceStateHIDSystemState, 60)
        || CGEventSourceButtonState(kCGEventSourceStateHIDSystemState, 1) || CGEventSourceButtonState(kCGEventSourceStateHIDSystemState, 2)) return 2;
    for (CGKeyCode key = 0; key < 128; key++) if (key != 56 && CGEventSourceKeyState(kCGEventSourceStateHIDSystemState, key)) return 2;
    CGEventRef current = CGEventCreate(NULL);
    if (!current) return 3;
    CGPoint point = CGEventGetLocation(current); CFRelease(current);
    CGEventSourceRef source = CGEventSourceCreate(kCGEventSourceStatePrivate);
    CGEventRef release = CGEventCreateMouseEvent(source, kCGEventLeftMouseUp, point, kCGMouseButtonLeft);
    if (!release) return 4;
    CGEventSetFlags(release, flags & ~(kCGEventFlagMaskShift | 2)); CGEventPost(kCGHIDEventTap, release); CFRelease(release); CFRelease(source);
    [NSThread sleepForTimeInterval:.15];
    printf("before_flags=%llu before_left=%d before_shift=%d after_flags=%llu after_left=%d after_shift=%d x=%g y=%g\n", flags,left,shift, CGEventSourceFlagsState(kCGEventSourceStateHIDSystemState), CGEventSourceButtonState(kCGEventSourceStateHIDSystemState,0), CGEventSourceKeyState(kCGEventSourceStateHIDSystemState,56), point.x,point.y);
    return CGEventSourceButtonState(kCGEventSourceStateHIDSystemState,0) || CGEventSourceKeyState(kCGEventSourceStateHIDSystemState,56);
} }
