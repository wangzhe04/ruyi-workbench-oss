// Controlled P5 window. It never opens user files or consumes injected keyboard input.
#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>

static NSArray *savedClipboard;
static NSInteger expectedClipboardVersion;
static BOOL clipboardSnapshot;
static BOOL rejectClose;

@interface CaptureWindowDelegate : NSObject <NSWindowDelegate>
@end
@implementation CaptureWindowDelegate
- (BOOL)windowShouldClose:(NSWindow *)sender { (void)sender; return !rejectClose; }
@end

static void SaveClipboard(void) {
    if (![NSProcessInfo.processInfo.environment[@"RUYI_P5_CLIPBOARD_FIXTURE"] isEqual:@"1"]) return;
    NSPasteboard *board = NSPasteboard.generalPasteboard;
    NSInteger version = board.changeCount;
    NSMutableArray *items = [NSMutableArray array];
    NSUInteger bytes = 0;
    for (NSPasteboardItem *item in board.pasteboardItems) {
        NSPasteboardItem *copy = [NSPasteboardItem new];
        for (NSPasteboardType type in item.types) {
            NSData *data = [item dataForType:type];
            if (!data || data.length > 32 * 1024 * 1024 - bytes) return;
            bytes += data.length;
            [copy setData:data forType:type];
        }
        [items addObject:copy];
    }
    if (board.changeCount != version) return;
    savedClipboard = items; expectedClipboardVersion = version; clipboardSnapshot = YES;
}

static void RestoreClipboard(void) {
    if (!clipboardSnapshot) return;
    NSPasteboard *board = NSPasteboard.generalPasteboard;
    BOOL restored = NO;
    if (board.changeCount == expectedClipboardVersion) {
        [board clearContents];
        restored = savedClipboard.count == 0 || [board writeObjects:savedClipboard];
    }
    printf("{\"event\":\"clipboard-restore\",\"restored\":%s}\n", restored ? "true" : "false"); fflush(stdout);
}

@interface CapturePattern : NSView
@end
@implementation CapturePattern
- (BOOL)isFlipped { return YES; }
- (void)drawRect:(NSRect)dirty {
    (void)dirty;
    NSArray *colors = @[NSColor.redColor, NSColor.greenColor, NSColor.blueColor, NSColor.yellowColor];
    CGFloat w = self.bounds.size.width / 2, h = self.bounds.size.height / 2;
    for (NSUInteger i = 0; i < 4; i++) {
        [colors[i] setFill]; NSRectFill(NSMakeRect((i % 2) * w, (i / 2) * h, w, h));
    }
    [@"Ruyi P5 中文截图" drawAtPoint:NSMakePoint(90, 100) withAttributes:@{
        NSFontAttributeName:[NSFont systemFontOfSize:26], NSForegroundColorAttributeName:NSColor.blackColor}];
}
@end

static NSWindow *Window(NSString *title, NSRect frame, BOOL pattern) {
    NSWindow *window = [[NSWindow alloc] initWithContentRect:frame
        styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable
        backing:NSBackingStoreBuffered defer:NO];
    window.releasedWhenClosed = NO; window.title = title;
    if (pattern) window.contentView = [[CapturePattern alloc] initWithFrame:NSMakeRect(0,0,frame.size.width,frame.size.height)];
    else window.backgroundColor = NSColor.magentaColor;
    [window makeKeyAndOrderFront:nil]; return window;
}

static void Report(NSWindow *window, NSString *event) {
    CGRect content = [window convertRectToScreen:window.contentView.bounds];
    CGFloat top = CGDisplayBounds(CGMainDisplayID()).size.height;
    NSDictionary *report = @{@"event":event, @"title":window.title, @"id":@(window.windowNumber),
        @"pid":@(NSProcessInfo.processInfo.processIdentifier), @"miniaturized":@(window.isMiniaturized),
        @"clipboardSnapshot":@(clipboardSnapshot),
        @"content":@{@"x":@(content.origin.x), @"y":@(top - CGRectGetMaxY(content)),
            @"width":@(content.size.width), @"height":@(content.size.height)}};
    NSData *data = [NSJSONSerialization dataWithJSONObject:report options:0 error:nil];
    puts([[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding].UTF8String); fflush(stdout);
}

int main(void) {
    @autoreleasepool {
        [NSApplication sharedApplication]; [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
        SaveClipboard();
        [NSNotificationCenter.defaultCenter addObserverForName:NSApplicationWillTerminateNotification object:nil queue:NSOperationQueue.mainQueue
            usingBlock:^(NSNotification *note) { (void)note; RestoreClipboard(); }];
        NSString *title = [NSString stringWithFormat:@"Ruyi P5 Capture %d", NSProcessInfo.processInfo.processIdentifier];
        NSWindow *window = Window(title, NSMakeRect(160,240,640,420), YES);
        __attribute__((objc_precise_lifetime)) CaptureWindowDelegate *delegate = [CaptureWindowDelegate new];
        window.delegate = delegate;
        NSMutableArray *others = [NSMutableArray array];
        [NSNotificationCenter.defaultCenter addObserverForName:NSWindowDidMiniaturizeNotification object:window queue:NSOperationQueue.mainQueue
            usingBlock:^(NSNotification *note) { (void)note; Report(window,@"minimize"); }];
        [NSNotificationCenter.defaultCenter addObserverForName:NSWindowDidDeminiaturizeNotification object:window queue:NSOperationQueue.mainQueue
            usingBlock:^(NSNotification *note) { (void)note; Report(window,@"restore"); }];
        [NSApp activateIgnoringOtherApps:YES];
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 300 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{ Report(window,@"ready"); });
        dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED,0), ^{
            char *line = NULL; size_t capacity = 0;
            while (getline(&line, &capacity, stdin) > 0) {
                NSString *command = [@(line) stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
                dispatch_async(dispatch_get_main_queue(), ^{
                    if ([command isEqual:@"cover"]) [others addObject:Window(@"P5 Cover", [window contentRectForFrameRect:window.frame], NO)];
                    if ([command isEqual:@"duplicate"]) [others addObject:Window(title, NSMakeRect(850,300,300,180), NO)];
                    if ([command isEqual:@"overlap"]) {
                        [others addObject:Window(@"P5 Distinct Overlap", [window contentRectForFrameRect:window.frame], NO)];
                        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 300 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{ Report(window,command); });
                        return;
                    }
                    if ([command isEqual:@"minimize"]) { [window miniaturize:nil]; return; }
                    if ([command isEqual:@"restore"]) { [window deminiaturize:nil]; return; }
                    if ([command isEqual:@"close"]) [window orderOut:nil];
                    if ([command isEqual:@"reject-close"]) rejectClose = YES;
                    if ([command isEqual:@"allow-close"]) rejectClose = NO;
                    if ([command hasPrefix:@"clipboard-expect "])
                        expectedClipboardVersion = [[command substringFromIndex:17] integerValue];
                    if ([command isEqual:@"quit"]) [NSApp terminate:nil];
                    Report(window,command);
                });
            }
            free(line); dispatch_async(dispatch_get_main_queue(), ^{ [NSApp terminate:nil]; });
        });
        [NSApp run];
    }
    return 0;
}
