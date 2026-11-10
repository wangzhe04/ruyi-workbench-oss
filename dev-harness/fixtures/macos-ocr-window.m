// Synthetic image and self-owned clickable OCR controls. Never reads or writes the clipboard.
#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>

static NSWindow *primary, *other;
static NSMutableArray<NSButton *> *buttons;
static NSMutableArray<NSNumber *> *counts;

static NSDictionary *Bounds(NSView *view) {
    NSRect frame = [view.window convertRectToScreen:[view convertRect:view.bounds toView:nil]];
    return @{@"x":@(frame.origin.x), @"y":@(CGDisplayBounds(CGMainDisplayID()).size.height - NSMaxY(frame)),
        @"width":@(frame.size.width), @"height":@(frame.size.height)};
}

static void Report(NSString *event) {
    NSMutableArray *controls = [NSMutableArray array];
    for (NSButton *button in buttons)
        [controls addObject:@{@"text":button.title, @"bounds":Bounds(button)}];
    NSDictionary *out = @{@"event":event, @"pid":@(NSProcessInfo.processInfo.processIdentifier),
        @"id":@(primary.windowNumber), @"title":primary.title, @"content":Bounds(primary.contentView),
        @"buttons":controls, @"counts":counts,
        @"leftHeld":@(CGEventSourceButtonState(kCGEventSourceStateCombinedSessionState, kCGMouseButtonLeft)),
        @"modifiers":@(CGEventSourceFlagsState(kCGEventSourceStateCombinedSessionState) &
            (kCGEventFlagMaskCommand | kCGEventFlagMaskControl | kCGEventFlagMaskShift | kCGEventFlagMaskAlternate))};
    NSData *data = [NSJSONSerialization dataWithJSONObject:out options:0 error:nil];
    puts([[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding].UTF8String);
    fflush(stdout);
}

@interface Receiver : NSObject
- (void)pressed:(NSButton *)sender;
@end
@implementation Receiver
- (void)pressed:(NSButton *)sender {
    counts[sender.tag] = @([counts[sender.tag] integerValue] + 1);
    Report(@"pressed");
}
@end

static BOOL SyntheticImage(NSString *path) {
    NSBitmapImageRep *bitmap = [[NSBitmapImageRep alloc] initWithBitmapDataPlanes:NULL pixelsWide:1000 pixelsHigh:300
        bitsPerSample:8 samplesPerPixel:4 hasAlpha:YES isPlanar:NO colorSpaceName:NSDeviceRGBColorSpace bytesPerRow:0 bitsPerPixel:0];
    [NSGraphicsContext saveGraphicsState];
    NSGraphicsContext.currentContext = [NSGraphicsContext graphicsContextWithBitmapImageRep:bitmap];
    [NSColor.whiteColor setFill]; NSRectFill(NSMakeRect(0,0,1000,300));
    NSDictionary *attributes = @{NSFontAttributeName:[NSFont systemFontOfSize:52], NSForegroundColorAttributeName:NSColor.blackColor};
    [@"INVOICE 42" drawAtPoint:NSMakePoint(40,210) withAttributes:attributes];
    [@"中文测试" drawAtPoint:NSMakePoint(40,120) withAttributes:attributes];
    [@"Total $42.50" drawAtPoint:NSMakePoint(40,30) withAttributes:attributes];
    [NSGraphicsContext restoreGraphicsState];
    return [[bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}] writeToFile:path atomically:YES];
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        [NSApplication sharedApplication];
        if (argc == 3 && strcmp(argv[1], "--image") == 0) {
            [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
            return SyntheticImage(@(argv[2])) ? 0 : 1;
        }
        [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
        NSApp.appearance = [NSAppearance appearanceNamed:NSAppearanceNameAqua];
        primary = [[NSWindow alloc] initWithContentRect:NSMakeRect(160,80,820,420)
            styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable backing:NSBackingStoreBuffered defer:NO];
        primary.releasedWhenClosed = NO;
        primary.title = [NSString stringWithFormat:@"Ruyi P5 OCR %d", NSProcessInfo.processInfo.processIdentifier];
        primary.backgroundColor = NSColor.whiteColor;
        NSArray *labels = @[@"INVOICE 42", @"中文测试"];
        for (NSUInteger index = 0; index < labels.count; index++) {
            NSTextField *label = [NSTextField labelWithString:labels[index]];
            label.font = [NSFont systemFontOfSize:32];
            label.textColor = NSColor.blackColor;
            label.frame = NSMakeRect(30, 325 - 70 * index, 760, 55);
            [primary.contentView addSubview:label];
        }
        __attribute__((objc_precise_lifetime)) Receiver *receiver = [Receiver new];
        buttons = [NSMutableArray array]; counts = [NSMutableArray array];
        NSArray *titles = @[@"Save Draft", @"Save Draft", @"中文保存"];
        NSRect frames[] = {NSMakeRect(30,125,320,65), NSMakeRect(430,125,320,65), NSMakeRect(30,30,320,65)};
        for (NSUInteger index = 0; index < titles.count; index++) {
            NSButton *button = [NSButton buttonWithTitle:titles[index] target:receiver action:@selector(pressed:)];
            button.bezelStyle = NSBezelStyleRounded;
            button.frame = frames[index]; button.font = [NSFont systemFontOfSize:24]; button.tag = index;
            [primary.contentView addSubview:button];
            [buttons addObject:button]; [counts addObject:@0];
        }
        [primary makeKeyAndOrderFront:nil]; [NSApp activateIgnoringOtherApps:YES];
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 300 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{ Report(@"ready"); });
        dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED,0), ^{
            char *line = NULL; size_t capacity = 0;
            while (getline(&line, &capacity, stdin) > 0) {
                NSString *command = [@(line) stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
                dispatch_async(dispatch_get_main_queue(), ^{
                    if ([command isEqual:@"change"]) buttons[2].title = @"CHANGED";
                    if ([command isEqual:@"other"]) {
                        if (!other) {
                            other = [[NSWindow alloc] initWithContentRect:NSMakeRect(160,80,820,420)
                                styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable backing:NSBackingStoreBuffered defer:NO];
                            other.releasedWhenClosed = NO; other.title = @"P5 OCR Other";
                        }
                        [other makeKeyAndOrderFront:nil];
                    }
                    if ([command isEqual:@"front"]) { [other orderOut:nil]; [primary makeKeyAndOrderFront:nil]; }
                    if ([command isEqual:@"quit"]) { [NSApp terminate:nil]; return; }
                    Report(command);
                });
            }
            free(line);
            dispatch_async(dispatch_get_main_queue(), ^{ [NSApp terminate:nil]; });
        });
        [NSApp run];
    }
    return 0;
}
