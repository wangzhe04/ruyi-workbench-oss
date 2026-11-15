// Owned capture-only window. No keyboard/mouse injection, user documents, clipboard or AX actions.
#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>

@interface MotionPattern : NSView
@end
@implementation MotionPattern
- (BOOL)isFlipped { return YES; }
- (void)drawRect:(NSRect)dirty {
    (void)dirty;
    NSArray *colors = @[NSColor.redColor, NSColor.greenColor, NSColor.blueColor, NSColor.yellowColor];
    CGFloat width = self.bounds.size.width / 2, height = self.bounds.size.height / 2;
    for (NSUInteger i = 0; i < 4; i++) {
        [colors[i] setFill]; NSRectFill(NSMakeRect((i % 2) * width, (i / 2) * height, width, height));
    }
}
@end
static void Report(NSWindow *window, NSString *event, NSUInteger ticks, BOOL moving) {
    CFArrayRef copied = CGWindowListCopyWindowInfo(kCGWindowListOptionIncludingWindow, (CGWindowID)window.windowNumber);
    NSArray *rows = copied ? CFBridgingRelease(copied) : @[];
    NSDictionary *own = rows.firstObject;
    BOOL identity = [own[(__bridge NSString *)kCGWindowNumber] integerValue] == window.windowNumber
        && [own[(__bridge NSString *)kCGWindowOwnerPID] intValue] == NSProcessInfo.processInfo.processIdentifier;
    NSDictionary *frame = own[(__bridge NSString *)kCGWindowBounds];
    NSRect content = [window convertRectToScreen:window.contentView.bounds];
    CGFloat top = CGRectGetMaxY(CGDisplayBounds(CGMainDisplayID()));
    NSDictionary *out = @{@"event":event, @"ok":identity && frame != nil ? @YES : @NO, @"pid":@(NSProcessInfo.processInfo.processIdentifier),
        @"id":@(window.windowNumber), @"title":window.title, @"wall_ms":@(NSDate.date.timeIntervalSince1970 * 1000),
        @"ticks":@(ticks), @"moving":@(moving), @"backingScale":@(window.backingScaleFactor), @"onScreen":own[(__bridge NSString *)kCGWindowIsOnscreen] ?: @NO,
        @"frame":frame ? @{@"x":frame[@"X"], @"y":frame[@"Y"], @"width":frame[@"Width"], @"height":frame[@"Height"]} : @{},
        @"content":@{@"x":@(content.origin.x), @"y":@(top - NSMaxY(content)), @"width":@(content.size.width), @"height":@(content.size.height)}};
    NSData *data = [NSJSONSerialization dataWithJSONObject:out options:0 error:nil];
    puts([[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding].UTF8String); fflush(stdout);
}
int main(void) {
    @autoreleasepool {
        [NSApplication sharedApplication]; [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
        NSRect visible = NSScreen.mainScreen.visibleFrame;
        CGFloat width = MIN(640, MAX(320, visible.size.width - 80));
        CGFloat maxX = NSMaxX(visible) - width - 20, startX = MIN(NSMinX(visible) + 100, maxX - 20);
        CGFloat span = MIN(360, maxX - startX);
        NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(startX, NSMinY(visible) + 80, width, 420)
            styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskResizable backing:NSBackingStoreBuffered defer:NO];
        window.releasedWhenClosed = NO; window.title = [NSString stringWithFormat:@"Ruyi P5 Motion %d", NSProcessInfo.processInfo.processIdentifier];
        window.contentView = [[MotionPattern alloc] initWithFrame:NSMakeRect(0, 0, width, 420)];
        [window makeKeyAndOrderFront:nil]; [NSApp activateIgnoringOtherApps:YES];
        __block NSTimer *timer = nil; __block NSUInteger ticks = 0; __block BOOL moving = NO;
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 300 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{ Report(window, @"ready", ticks, moving); });
        dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
            char *line = NULL; size_t capacity = 0;
            while (getline(&line, &capacity, stdin) > 0) {
                NSString *command = [@(line) stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
                dispatch_async(dispatch_get_main_queue(), ^{
                    if ([command isEqual:@"motion-start"]) {
                        if (timer || span < 16) { Report(window, @"motion-unavailable", ticks, moving); return; }
                        ticks = 0; moving = YES;
                        Report(window, command, ticks, moving);
                        timer = [NSTimer scheduledTimerWithTimeInterval:.004 repeats:YES block:^(NSTimer *active) {
                            ticks++;
                            [window setFrameOrigin:NSMakePoint(startX + span * MIN(ticks, 1000ul) / 1000., window.frame.origin.y)];
                            Report(window, @"motion-frame", ticks, moving);
                            if (ticks >= 1000) { [active invalidate]; timer = nil; moving = NO; Report(window, @"motion-ended", ticks, moving); }
                        }];
                        return;
                    }
                    if ([command isEqual:@"motion-stop"]) { [timer invalidate]; timer = nil; moving = NO; [window.contentView displayIfNeeded]; }
                    if ([command isEqual:@"quit"]) { [timer invalidate]; timer = nil; moving = NO; [NSApp terminate:nil]; return; }
                    Report(window, command, ticks, moving);
                });
            }
            free(line);
            dispatch_async(dispatch_get_main_queue(), ^{ [timer invalidate]; timer = nil; [NSApp terminate:nil]; });
        });
        [NSApp run];
    }
    return 0;
}
