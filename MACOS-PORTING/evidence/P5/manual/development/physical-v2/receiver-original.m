// Controlled event receiver. All reported text belongs to this self-owned fixture.
#import "macos-clipboard-fixture.h"
#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#if defined(RUYI_RECORD_FIXTURE) || defined(RUYI_MANUAL_FIXTURE)
#import <Carbon/Carbon.h>
#endif

static NSMutableDictionary *counts;
static NSWindow *primary;
static NSWindow *cover;
static NSPanel *floating;
static NSTextView *editor;
static NSView *pad;
static NSData *marker;
static NSData *image;
static BOOL changeOnPaste;
static BOOL reportPaste;
static BOOL reportDrag;
static NSString *trackedClipboardText;
static void Report(NSString *event);
#ifdef RUYI_MANUAL_FIXTURE
static TISInputSourceRef originalSource;
static NSString *selectedSource;
static NSString *SourceID(void) {
    TISInputSourceRef source = TISCopyCurrentKeyboardInputSource();
    NSString *identifier = source ? [(__bridge NSString *)TISGetInputSourceProperty(source, kTISPropertyInputSourceID) copy] : @"";
    if (source) CFRelease(source);
    return identifier;
}
static void RestoreSource(void) {
    if (!originalSource) return;
    NSString *original = (__bridge NSString *)TISGetInputSourceProperty(originalSource, kTISPropertyInputSourceID);
    BOOL owned = [SourceID() isEqual:selectedSource];
    BOOL restored = owned && TISSelectInputSource(originalSource) == noErr && [SourceID() isEqual:original];
    printf("{\"event\":\"input-source-restore\",\"restored\":%s,\"skipped_external_change\":%s}\n", restored ? "true" : "false", owned ? "false" : "true"); fflush(stdout);
    CFRelease(originalSource); originalSource = NULL;
}
#endif
static void ChangeClipboard(void) {
    [NSPasteboard.generalPasteboard clearContents];
    [NSPasteboard.generalPasteboard setString:@"P5 controlled concurrent clipboard change"
                                      forType:NSPasteboardTypeString];
    expectedClipboardVersion = NSPasteboard.generalPasteboard.changeCount;
}

@interface InputApp : NSApplication
@end
@implementation InputApp
- (void)sendEvent:(NSEvent *)event {
    NSString *key = nil;
    switch (event.type) {
    case NSEventTypeKeyDown:
        key = @"key_down";
        break;
    case NSEventTypeKeyUp:
        key = @"key_up";
        break;
    case NSEventTypeLeftMouseDown:
        key = @"left_down";
        break;
    case NSEventTypeLeftMouseUp:
        key = @"left_up";
        break;
    case NSEventTypeRightMouseDown:
        key = @"right_down";
        break;
    case NSEventTypeRightMouseUp:
        key = @"right_up";
        break;
    case NSEventTypeOtherMouseDown:
        key = @"middle_down";
        break;
    case NSEventTypeOtherMouseUp:
        key = @"middle_up";
        break;
    case NSEventTypeLeftMouseDragged:
        key = @"dragged";
        break;
    case NSEventTypeScrollWheel:
        key = fabs(event.scrollingDeltaX) > fabs(event.scrollingDeltaY) ? @"horizontal_scroll" : @"vertical_scroll";
        break;
    default:
        break;
    }
    if (key)
        counts[key] = @([counts[key] integerValue] + 1);
    [super sendEvent:event];
    if (event.type == NSEventTypeKeyDown && (event.modifierFlags & NSEventModifierFlagCommand) &&
        [[event charactersIgnoringModifiers] isEqual:@"v"]) {
        if (changeOnPaste) {
            changeOnPaste = NO;
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 50 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
              ChangeClipboard();
            });
        }
        if (reportPaste) {
            reportPaste = NO;
            Report(@"paste-observed");
        }
    }
    if (reportDrag && event.type == NSEventTypeLeftMouseDragged) {
        reportDrag = NO;
        Report(@"drag-observed");
    }
}
@end

@interface HiddenInputPanel : NSPanel
@end
@implementation HiddenInputPanel
- (BOOL)isAccessibilityElement {
    return NO;
}
- (NSArray *)accessibilityChildren {
    return @[];
}
- (id)accessibilityHitTest:(NSPoint)point {
    (void)point;
    return nil;
}
@end

@interface InputPad : NSView
@end
@implementation InputPad
- (BOOL)acceptsFirstResponder {
    return YES;
}
- (BOOL)isAccessibilityElement {
    return YES;
}
- (NSString *)accessibilityRole {
    return NSAccessibilityGroupRole;
}
- (NSString *)accessibilityLabel {
    return @"P5 input pad";
}
- (void)drawRect:(NSRect)rect {
    (void)rect;
    [NSColor.systemBlueColor setFill];
    NSRectFill(self.bounds);
}
- (void)mouseDown:(NSEvent *)event {
    (void)event;
    [self.window makeFirstResponder:self];
}
- (void)mouseUp:(NSEvent *)event {
    (void)event;
}
- (void)rightMouseDown:(NSEvent *)event {
    (void)event;
}
- (void)rightMouseUp:(NSEvent *)event {
    (void)event;
}
- (void)otherMouseDown:(NSEvent *)event {
    (void)event;
}
- (void)otherMouseUp:(NSEvent *)event {
    (void)event;
}
- (void)mouseDragged:(NSEvent *)event {
    (void)event;
}
- (void)scrollWheel:(NSEvent *)event {
    (void)event;
}
@end

@interface InputDelegate : NSObject <NSApplicationDelegate>
@end
@implementation InputDelegate
- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)sender {
    (void)sender;
    return YES;
}
@end

static NSDictionary *Bounds(NSView *view) {
    NSRect frame = [view.window convertRectToScreen:[view convertRect:view.bounds toView:nil]];
    CGFloat top = CGDisplayBounds(CGMainDisplayID()).size.height;
    return @{
        @"x" : @(frame.origin.x),
        @"y" : @(top - NSMaxY(frame)),
        @"width" : @(frame.size.width),
        @"height" : @(frame.size.height)
    };
}

static BOOL ClipboardPreserved(void) {
    NSPasteboard *board = NSPasteboard.generalPasteboard;
    BOOL same = marker && image && [[board dataForType:@"org.ruyi.p5.fixture"] isEqual:marker] &&
                [[board dataForType:NSPasteboardTypePNG] isEqual:image];
    if (same)
        expectedClipboardVersion = board.changeCount;
    return same;
}

static void Report(NSString *event) {
    NSPasteboard *board = NSPasteboard.generalPasteboard;
    BOOL temporaryOwned = trackedClipboardText && [[board stringForType:NSPasteboardTypeString] isEqual:trackedClipboardText];
    if (temporaryOwned) expectedClipboardVersion = board.changeCount;
    NSDictionary *value = @{
        @"event" : event,
        @"pid" : @(NSProcessInfo.processInfo.processIdentifier),
        @"id" : @(primary.windowNumber),
        @"title" : primary.title,
        @"text" : editor.string ?: @"",
        @"counts" : counts,
#ifdef RUYI_MANUAL_FIXTURE
        @"inputSource":SourceID(), @"marked":@(editor.hasMarkedText),
        @"cursorX":@(NSEvent.mouseLocation.x),
        @"cursorY":@(CGDisplayBounds(CGMainDisplayID()).size.height - NSEvent.mouseLocation.y),
        @"hidFlags":@(CGEventSourceFlagsState(kCGEventSourceStateHIDSystemState)),
        @"combinedFlags":@(CGEventSourceFlagsState(kCGEventSourceStateCombinedSessionState)),
        @"hidShift":@(CGEventSourceKeyState(kCGEventSourceStateHIDSystemState, 56)),
        @"hidLeft":@(CGEventSourceButtonState(kCGEventSourceStateHIDSystemState, 0)),
#endif
        @"editor" : Bounds(editor),
        @"pad" : Bounds(pad),
        @"clipboardSnapshot" : @(clipboardSnapshot),
        @"temporaryClipboardOwned" : @(temporaryOwned),
        @"clipboardPreserved" : @(ClipboardPreserved()),
        @"clipboardVersion" : @(NSPasteboard.generalPasteboard.changeCount),
        @"clipboardChanged" : @([[NSPasteboard.generalPasteboard stringForType:NSPasteboardTypeString]
            isEqual:@"P5 controlled concurrent clipboard change"]),
        @"leftHeld" : @(CGEventSourceButtonState(kCGEventSourceStateCombinedSessionState, kCGMouseButtonLeft)),
        @"modifierFlags" :
            @(CGEventSourceFlagsState(kCGEventSourceStateCombinedSessionState) &
              (kCGEventFlagMaskCommand | kCGEventFlagMaskControl | kCGEventFlagMaskShift | kCGEventFlagMaskAlternate))
    };
    NSData *data = [NSJSONSerialization dataWithJSONObject:value options:NSJSONWritingSortedKeys error:nil];
    puts([[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding].UTF8String);
    fflush(stdout);
}

static void ShowCover(void) {
    if (!cover) {
        cover = [[NSWindow alloc] initWithContentRect:[primary contentRectForFrameRect:primary.frame]
                                            styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable
                                              backing:NSBackingStoreBuffered
                                                defer:NO];
        cover.releasedWhenClosed = NO;
        cover.title = @"P5 alternate input target";
        cover.backgroundColor = NSColor.systemOrangeColor;
    }
    [cover makeKeyAndOrderFront:nil];
}

static void Command(NSString *command) {
#ifdef RUYI_MANUAL_FIXTURE
    if ([command isEqual:@"clear-neutral"]) { [editor unmarkText]; [editor setString:@""]; }
    if ([command isEqual:@"source-abc"] || [command isEqual:@"source-pinyin"]) {
        NSString *identifier = [command isEqual:@"source-abc"] ? @"com.apple.keylayout.ABC" : @"com.apple.inputmethod.SCIM.ITABC";
        NSArray *sources = CFBridgingRelease(TISCreateInputSourceList((__bridge CFDictionaryRef)@{(__bridge NSString *)kTISPropertyInputSourceID:identifier}, false));
        if (sources.count) {
            if (!originalSource) originalSource = TISCopyCurrentKeyboardInputSource();
            if (TISSelectInputSource((__bridge TISInputSourceRef)sources[0]) == noErr) selectedSource = identifier;
        }
    }
#endif
#ifdef RUYI_RECORD_FIXTURE
    if ([command isEqual:@"record-move"]) [primary setFrameOrigin:NSMakePoint(primary.frame.origin.x + 40, 80)];
    if ([command isEqual:@"record-resize"]) [primary setContentSize:NSMakeSize(780, 500)];
    if ([command isEqual:@"secure-on"]) EnableSecureEventInput();
    if ([command isEqual:@"secure-off"]) DisableSecureEventInput();
#endif
    if ([command hasPrefix:@"clipboard-track "]) {
        NSData *encoded = [[NSData alloc] initWithBase64EncodedString:[command substringFromIndex:16] options:0];
        trackedClipboardText = encoded ? [[NSString alloc] initWithData:encoded encoding:NSUTF8StringEncoding] : nil;
    }
    if ([command isEqual:@"focus-text"]) {
        [cover orderOut:nil];
        [floating orderOut:nil];
        [primary makeKeyAndOrderFront:nil];
        [primary makeFirstResponder:editor];
    }
    if ([command isEqual:@"focus-pad"]) {
        [cover orderOut:nil];
        [floating orderOut:nil];
        [primary makeKeyAndOrderFront:nil];
        [primary makeFirstResponder:pad];
    }
    if ([command isEqual:@"floating"]) {
        if (!floating) {
            floating = [[HiddenInputPanel alloc]
                initWithContentRect:[primary contentRectForFrameRect:primary.frame]
                          styleMask:NSWindowStyleMaskBorderless | NSWindowStyleMaskNonactivatingPanel
                            backing:NSBackingStoreBuffered
                              defer:NO];
            floating.level = NSFloatingWindowLevel;
            floating.hidesOnDeactivate = NO;
            floating.backgroundColor = NSColor.systemRedColor;
        }
        [floating orderFront:nil];
    }
    if ([command isEqual:@"cover"])
        ShowCover();
    if ([command isEqual:@"steal-focus"])
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 120 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
          ShowCover();
        });
    if ([command isEqual:@"change-on-paste"])
        changeOnPaste = YES;
    if ([command isEqual:@"observe-paste"])
        reportPaste = YES;
    if ([command isEqual:@"observe-drag"])
        reportDrag = YES;
    if ([command isEqual:@"seed-clipboard"]) {
        if (!clipboardSnapshot)
            SaveClipboard();
        if (clipboardSnapshot) {
            marker = [@"P5 controlled private clipboard format" dataUsingEncoding:NSUTF8StringEncoding];
            image = [[NSData alloc] initWithBase64EncodedString:@"iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAE0lEQ"
                                                                @"VR4nGP8//8/AwMDEwMYAAAkBgMBXaJOiAAAAABJRU5ErkJggg=="
                                                        options:0];
            NSPasteboardItem *item = [NSPasteboardItem new];
            [item setData:marker forType:@"org.ruyi.p5.fixture"];
            [item setData:image forType:NSPasteboardTypePNG];
            [NSPasteboard.generalPasteboard clearContents];
            [NSPasteboard.generalPasteboard writeObjects:@[ item ]];
            expectedClipboardVersion = NSPasteboard.generalPasteboard.changeCount;
        }
    }
    if ([command isEqual:@"quit"]) {
        [NSApp terminate:nil];
        return;
    }
    Report(command);
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        BOOL clipboardOnly = argc > 1 && strcmp(argv[1], "--clipboard-only") == 0;
        [InputApp sharedApplication];
        [NSApp setActivationPolicy:clipboardOnly ? NSApplicationActivationPolicyProhibited : NSApplicationActivationPolicyRegular];
        __attribute__((objc_precise_lifetime)) InputDelegate *delegate = [InputDelegate new];
        NSApp.delegate = delegate;
        counts = [NSMutableDictionary dictionary];
        NSMenu *menu = [NSMenu new];
        NSMenuItem *editItem = [NSMenuItem new];
        [menu addItem:editItem];
        NSMenu *edit = [[NSMenu alloc] initWithTitle:@"Edit"];
        editItem.submenu = edit;
        [edit addItemWithTitle:@"Select All" action:@selector(selectAll:) keyEquivalent:@"a"];
        [edit addItemWithTitle:@"Copy" action:@selector(copy:) keyEquivalent:@"c"];
        [edit addItemWithTitle:@"Paste" action:@selector(paste:) keyEquivalent:@"v"];
        NSApp.mainMenu = menu;
        primary = [[NSWindow alloc]
            initWithContentRect:NSMakeRect(180, 260, 760, 500)
                      styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskMiniaturizable
                        backing:NSBackingStoreBuffered
                          defer:NO];
#ifdef RUYI_MANUAL_FIXTURE
        [primary setFrameOrigin:NSMakePoint(180, 60)];
#endif
        primary.releasedWhenClosed = NO;
        primary.title = [NSString stringWithFormat:@"Ruyi P5 Input %d", NSProcessInfo.processInfo.processIdentifier];
        editor = [[NSTextView alloc] initWithFrame:NSMakeRect(20, 220, 720, 260)];
        editor.richText = NO;
        editor.automaticQuoteSubstitutionEnabled = NO;
        editor.automaticDashSubstitutionEnabled = NO;
        editor.automaticSpellingCorrectionEnabled = NO;
        editor.continuousSpellCheckingEnabled = NO;
        editor.font = [NSFont systemFontOfSize:18];
        pad = [[InputPad alloc] initWithFrame:NSMakeRect(20, 20, 720, 170)];
        [primary.contentView addSubview:editor];
        [primary.contentView addSubview:pad];
        if (!clipboardOnly) {
            [primary makeKeyAndOrderFront:nil];
            [primary makeFirstResponder:editor];
            [NSApp activateIgnoringOtherApps:YES];
        }
        [NSNotificationCenter.defaultCenter addObserverForName:NSApplicationWillTerminateNotification
                                                        object:nil
                                                         queue:NSOperationQueue.mainQueue
                                                    usingBlock:^(NSNotification *note) {
                                                      (void)note;
                                                      RestoreClipboard();
#ifdef RUYI_MANUAL_FIXTURE
                                                      RestoreSource();
#endif
                                                    }];
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 300 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
          Report(@"ready");
        });
        if (argc > 1 && strcmp(argv[1], "--launch-only") == 0) {
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 3 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
              [NSApp terminate:nil];
            });
        } else {
            dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
              char *line = NULL;
              size_t capacity = 0;
              while (getline(&line, &capacity, stdin) > 0) {
                  NSString *command =
                      [@(line) stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
                  dispatch_async(dispatch_get_main_queue(), ^{
                    Command(command);
                  });
              }
              free(line);
              dispatch_async(dispatch_get_main_queue(), ^{
                [NSApp terminate:nil];
              });
            });
        }
        [NSApp run];
    }
    return 0;
}
