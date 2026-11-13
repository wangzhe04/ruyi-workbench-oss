// Self-owned neutral-abort receiver. No input posting, clipboard or input-source writes.
#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <Carbon/Carbon.h>
#import <unistd.h>

static NSWindow *window;
static NSUInteger downs, ups, otherInput;
static NSMutableArray *receipts;

static NSDictionary *Source(void) {
    TISInputSourceRef source = TISCopyCurrentKeyboardInputSource();
    if (!source) return @{};
    NSString *identifier = (__bridge NSString *)TISGetInputSourceProperty(source, kTISPropertyInputSourceID);
    NSString *type = (__bridge NSString *)TISGetInputSourceProperty(source, kTISPropertyInputSourceType);
    NSDictionary *out = identifier && type ? @{@"id":identifier, @"type":type} : @{};
    CFRelease(source);
    return out;
}

static void Report(NSString *event) {
    CGEventFlags mask = kCGEventFlagMaskCommand | kCGEventFlagMaskControl | kCGEventFlagMaskShift | kCGEventFlagMaskAlternate;
    NSMutableDictionary *out = [@{@"event":event, @"wall_ms":@(NSDate.date.timeIntervalSince1970 * 1000),
        @"pid":@(getpid()), @"pgid":@(getpgrp()), @"id":@(window.windowNumber), @"title":window.title,
        @"downs":@(downs), @"ups":@(ups), @"otherInput":@(otherInput), @"receipts":[receipts copy],
        @"hidLeft":@(CGEventSourceButtonState(kCGEventSourceStateHIDSystemState, kCGMouseButtonLeft)),
        @"combinedLeft":@(CGEventSourceButtonState(kCGEventSourceStateCombinedSessionState, kCGMouseButtonLeft)),
        @"hidModifiers":@(CGEventSourceFlagsState(kCGEventSourceStateHIDSystemState) & mask),
        @"combinedModifiers":@(CGEventSourceFlagsState(kCGEventSourceStateCombinedSessionState) & mask),
        @"input_source":Source(), @"frontmost":@(NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier == getpid())} mutableCopy];
    CFArrayRef rows = CGWindowListCopyWindowInfo(kCGWindowListOptionIncludingWindow, (CGWindowID)window.windowNumber);
    NSArray *windows = CFBridgingRelease(rows);
    NSDictionary *own = windows.firstObject;
    CGRect frame;
    BOOL valid = [own[(__bridge NSString *)kCGWindowOwnerPID] intValue] == getpid()
        && CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)own[(__bridge NSString *)kCGWindowBounds], &frame);
    out[@"geometryOK"] = @(valid);
    if (valid) out[@"frame"] = @{@"x":@(frame.origin.x), @"y":@(frame.origin.y), @"width":@(frame.size.width), @"height":@(frame.size.height)};
    NSRect content = [window convertRectToScreen:window.contentView.bounds];
    out[@"point"] = @{@"x":@(NSMidX(content)), @"y":@(CGDisplayBounds(CGMainDisplayID()).size.height - NSMidY(content))};
    NSData *data = [NSJSONSerialization dataWithJSONObject:out options:0 error:nil];
    puts([[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding].UTF8String); fflush(stdout);
}

@interface AbortApp : NSApplication
@end
@implementation AbortApp
- (void)sendEvent:(NSEvent *)event {
    if (event.window == window) {
        if (event.type == NSEventTypeLeftMouseDown || event.type == NSEventTypeLeftMouseUp) {
            if (event.type == NSEventTypeLeftMouseDown) downs++; else ups++;
            CGEventRef raw = event.CGEvent;
            CGPoint point = raw ? CGEventGetLocation(raw) : CGPointZero;
            [receipts addObject:@{@"type":event.type == NSEventTypeLeftMouseDown ? @"down" : @"up",
                @"wall_ms":@(NSDate.date.timeIntervalSince1970 * 1000), @"timestamp":@(event.timestamp),
                @"sourcePID":@(raw ? CGEventGetIntegerValueField(raw, kCGEventSourceUnixProcessID) : 0),
                @"x":@(point.x), @"y":@(point.y)}];
        } else if (event.type == NSEventTypeKeyDown || event.type == NSEventTypeKeyUp || event.type == NSEventTypeFlagsChanged
            || event.type == NSEventTypeRightMouseDown || event.type == NSEventTypeOtherMouseDown || event.type == NSEventTypeLeftMouseDragged) otherInput++;
    }
    [super sendEvent:event];
}
@end

@interface AbortPad : NSView
@end
@implementation AbortPad
- (BOOL)acceptsFirstResponder { return YES; }
- (BOOL)isAccessibilityElement { return YES; }
- (NSString *)accessibilityRole { return NSAccessibilityGroupRole; }
- (NSString *)accessibilityLabel { return @"Owned neutral abort test pad"; }
- (void)drawRect:(NSRect)rect { (void)rect; [NSColor.systemBlueColor setFill]; NSRectFill(self.bounds); }
- (void)mouseDown:(NSEvent *)event { (void)event; }
- (void)mouseUp:(NSEvent *)event { (void)event; }
@end

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        if (argc == 3 && strcmp(argv[1], "--identity") == 0) {
            char *end = NULL; long pid = strtol(argv[2], &end, 10);
            if (!end || *end || pid <= 1 || pid > INT_MAX) return 2;
            pid_t pgid = getpgid((pid_t)pid), sid = getsid((pid_t)pid);
            if (pgid < 1 || sid < 1) return 3;
            printf("{\"pgid\":%d,\"sid\":%d}\n", pgid, sid);
            return 0;
        }
        if (argc != 1) return 2;
        [AbortApp sharedApplication]; [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
        receipts = [NSMutableArray array];
        window = [[NSWindow alloc] initWithContentRect:NSMakeRect(220,180,480,300)
            styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
        window.title = [NSString stringWithFormat:@"Ruyi P5 Neutral Abort %d", getpid()];
        window.contentView = [[AbortPad alloc] initWithFrame:NSMakeRect(0,0,480,300)];
        [window makeKeyAndOrderFront:nil]; [NSApp activateIgnoringOtherApps:YES];
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 300 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{ Report(@"ready"); });
        dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED,0), ^{
            char *line = NULL; size_t capacity = 0;
            while (getline(&line, &capacity, stdin) > 0) {
                NSString *command = [@(line) stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
                dispatch_async(dispatch_get_main_queue(), ^{
                    if ([command isEqual:@"quit"]) [NSApp terminate:nil];
                    else if ([command isEqual:@"state"]) Report(command);
                });
            }
            free(line); dispatch_async(dispatch_get_main_queue(), ^{ [NSApp terminate:nil]; });
        });
        [NSApp run];
    }
    return 0;
}
