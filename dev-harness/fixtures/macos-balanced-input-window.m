// Passive owned receiver for one bounded middle-button pair. Never posts input.
// Nonces identify observer intervals only; CGEvents carry no test nonce.
#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <Carbon/Carbon.h>
#import <libproc.h>
#import <sys/stat.h>
#import <fcntl.h>
#import <unistd.h>
#import <signal.h>

static NSWindow *window;
static int journal = -1;
static BOOL journalOK = YES, armed;
static NSUInteger serial, downs, ups, noise;
static NSString *instanceNonce, *caseNonce = @"", *expectedBirth = @"";
static pid_t expectedPID;
static NSMutableArray *receipts;
static NSMutableSet *usedNonces;
static NSDictionary *armState;
static NSTimeInterval armStart, armDeadline;
static NSUInteger journalBytes;
static BOOL stdoutOK = YES;

static NSString *Birth(pid_t pid) {
    struct proc_bsdinfo info;
    if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info)) != sizeof(info)) return @"";
    return [NSString stringWithFormat:@"%llu:%llu", info.pbi_start_tvsec, info.pbi_start_tvusec];
}

static NSDictionary *Source(void) {
    TISInputSourceRef source = TISCopyCurrentKeyboardInputSource();
    if (!source) return @{};
    NSString *identifier = (__bridge NSString *)TISGetInputSourceProperty(source, kTISPropertyInputSourceID);
    NSString *type = (__bridge NSString *)TISGetInputSourceProperty(source, kTISPropertyInputSourceType);
    NSDictionary *out = identifier && type ? @{@"id":identifier, @"type":type} : @{};
    CFRelease(source);
    return out;
}

static NSDictionary *State(void) {
    // Include generic and device-dependent modifier bits, except caps/numeric/help.
    CGEventFlags mask = kCGEventFlagMaskCommand | kCGEventFlagMaskControl | kCGEventFlagMaskShift
        | kCGEventFlagMaskAlternate | kCGEventFlagMaskSecondaryFn | 0xff;
    NSMutableArray *hid = [NSMutableArray array], *combined = [NSMutableArray array];
    for (int button = 0; button < 3; button++) {
        [hid addObject:@(CGEventSourceButtonState(kCGEventSourceStateHIDSystemState, button))];
        [combined addObject:@(CGEventSourceButtonState(kCGEventSourceStateCombinedSessionState, button))];
    }
    BOOL keyHeld = NO;
    for (int code = 0; code < 128; code++)
        keyHeld |= CGEventSourceKeyState(kCGEventSourceStateHIDSystemState, code)
            || CGEventSourceKeyState(kCGEventSourceStateCombinedSessionState, code);
    NSArray *rows = CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionIncludingWindow, (CGWindowID)window.windowNumber));
    NSDictionary *own = rows.firstObject;
    CGRect frame = CGRectZero;
    BOOL valid = [own[(__bridge NSString *)kCGWindowOwnerPID] intValue] == getpid()
        && CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)own[(__bridge NSString *)kCGWindowBounds], &frame);
    NSRect content = [window convertRectToScreen:window.contentView.bounds];
    CGPoint point = CGPointMake(round(NSMidX(content)), round(CGDisplayBounds(CGMainDisplayID()).size.height - NSMidY(content)));
    NSPoint screenPoint = NSMakePoint(point.x, CGDisplayBounds(CGMainDisplayID()).size.height - point.y);
    BOOL hit = valid && [NSWindow windowNumberAtPoint:screenPoint belowWindowWithWindowNumber:0] == window.windowNumber;
    return @{@"pid":@(getpid()), @"ppid":@(getppid()), @"pgid":@(getpgrp()), @"sid":@(getsid(0)),
        @"birth":Birth(getpid()), @"id":@(window.windowNumber), @"title":window.title,
        @"hidButtons":hid, @"combinedButtons":combined, @"keyHeld":@(keyHeld),
        @"hidModifiers":@(CGEventSourceFlagsState(kCGEventSourceStateHIDSystemState) & mask),
        @"combinedModifiers":@(CGEventSourceFlagsState(kCGEventSourceStateCombinedSessionState) & mask),
        @"input_source":Source(), @"frontmost":NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier == getpid() ? @YES : @NO,
        @"geometryOK":@(valid), @"hit":@(hit),
        @"frame":@{@"x":@(frame.origin.x), @"y":@(frame.origin.y), @"width":@(frame.size.width), @"height":@(frame.size.height)},
        @"point":@{@"x":@(point.x), @"y":@(point.y)}};
}

static BOOL Neutral(NSDictionary *state) {
    return ![state[@"keyHeld"] boolValue] && ![state[@"hidModifiers"] unsignedLongLongValue]
        && ![state[@"combinedModifiers"] unsignedLongLongValue]
        && ![state[@"hidButtons"] containsObject:@YES] && ![state[@"combinedButtons"] containsObject:@YES];
}

static void Emit(NSString *event, NSDictionary *extra) {
    NSMutableDictionary *row = [@{@"event":event, @"sequence":@(++serial),
        @"wall_ms":@(NSDate.date.timeIntervalSince1970 * 1000), @"instanceNonce":instanceNonce,
        @"caseNonce":caseNonce, @"armed":@(armed), @"expectedPID":@(expectedPID), @"expectedBirth":expectedBirth,
        @"armStart":@(armStart), @"armDeadline":@(armDeadline), @"armState":armState ?: @{},
        @"downs":@(downs), @"ups":@(ups), @"noise":@(noise), @"receipts":[receipts copy], @"state":State()} mutableCopy];
    [row addEntriesFromDictionary:extra ?: @{}];
    if (serial > 256) journalOK = NO;
    row[@"journalOK"] = @(journalOK);
    NSData *json = [NSJSONSerialization dataWithJSONObject:row options:0 error:nil];
    NSMutableData *line = [json mutableCopy]; [line appendBytes:"\n" length:1];
    if (line.length > 96 * 1024 || journalBytes + line.length > 4 * 1024 * 1024) journalOK = NO;
    if (journalOK) {
        const char *bytes = line.bytes; NSUInteger offset = 0;
        while (offset < line.length) {
            ssize_t wrote = write(journal, bytes + offset, line.length - offset);
            if (wrote < 0 && errno == EINTR) continue;
            if (wrote <= 0) { journalOK = NO; break; }
            offset += (NSUInteger)wrote;
        }
        if (journalOK && fsync(journal) != 0) journalOK = NO;
        if (journalOK) journalBytes += line.length;
    }
    if (!journalOK) { armed = NO; row[@"journalOK"] = @NO; json = [NSJSONSerialization dataWithJSONObject:row options:0 error:nil]; }
    // A broken control pipe must not terminate the independent durable witness.
    if (stdoutOK && (puts([[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding].UTF8String) < 0 || fflush(stdout) != 0)) stdoutOK = NO;
}

@interface BalancedApp : NSApplication
@end
@implementation BalancedApp
- (void)sendEvent:(NSEvent *)event {
    if (event.window == window) {
        BOOL down = event.type == NSEventTypeOtherMouseDown, up = event.type == NSEventTypeOtherMouseUp;
        BOOL input = down || up || event.type == NSEventTypeLeftMouseDown || event.type == NSEventTypeLeftMouseUp
            || event.type == NSEventTypeRightMouseDown || event.type == NSEventTypeRightMouseUp
            || event.type == NSEventTypeLeftMouseDragged || event.type == NSEventTypeRightMouseDragged || event.type == NSEventTypeOtherMouseDragged
            || event.type == NSEventTypeKeyDown || event.type == NSEventTypeKeyUp || event.type == NSEventTypeFlagsChanged
            || event.type == NSEventTypeScrollWheel || event.type == NSEventTypePressure || event.type == NSEventTypeMagnify
            || event.type == NSEventTypeRotate || event.type == NSEventTypeSwipe;
        if (input) {
            CGEventRef raw = event.CGEvent;
            pid_t pid = raw ? (pid_t)CGEventGetIntegerValueField(raw, kCGEventSourceUnixProcessID) : 0;
            CGPoint point = raw ? CGEventGetLocation(raw) : CGPointZero;
            BOOL match = armed && journalOK && event.buttonNumber == 2 && (down || up)
                && pid == expectedPID && [Birth(pid) isEqual:expectedBirth]
                && event.timestamp >= armStart && event.timestamp <= armDeadline
                && NSProcessInfo.processInfo.systemUptime <= armDeadline
                && raw && CGEventGetFlags(raw) == 0
                && point.x == [armState[@"point"][@"x"] doubleValue] && point.y == [armState[@"point"][@"y"] doubleValue]
                && ((down && downs == 0 && ups == 0) || (up && downs == 1 && ups == 0));
            if (match) { if (down) downs++; else ups++; } else noise++;
            NSDictionary *receipt = @{@"type":@(event.type), @"button":@(event.buttonNumber), @"down":@(down), @"up":@(up),
                @"timestamp":@(event.timestamp), @"cgTimestamp":@(raw ? CGEventGetTimestamp(raw) : 0),
                @"flags":@(raw ? CGEventGetFlags(raw) : event.modifierFlags), @"sourcePID":@(pid),
                @"sourceBirth":Birth(pid), @"matched":@(match), @"x":@(point.x), @"y":@(point.y)};
            if (receipts.count < 128) [receipts addObject:receipt]; else journalOK = NO;
            Emit(@"input", @{@"received":receipt});
            return; // Swallow every own-window input; no menus, editing or pressure action.
        }
    }
    [super sendEvent:event];
}
@end

@interface BalancedPad : NSView
@end
@implementation BalancedPad
- (BOOL)acceptsFirstResponder { return YES; }
- (void)drawRect:(NSRect)rect { (void)rect; [NSColor.systemBlueColor setFill]; NSRectFill(self.bounds); }
@end

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        if (argc == 3 && !strcmp(argv[1], "--identity")) {
            char *end = NULL; long pid = strtol(argv[2], &end, 10);
            if (!end || *end || pid <= 1 || pid > INT_MAX || !Birth((pid_t)pid).length) return 2;
            NSDictionary *row = @{@"pid":@(pid), @"birth":Birth((pid_t)pid), @"pgid":@(getpgid((pid_t)pid)), @"sid":@(getsid((pid_t)pid))};
            NSData *json = [NSJSONSerialization dataWithJSONObject:row options:0 error:nil];
            puts([[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding].UTF8String); return 0;
        }
        if (argc != 4 || strcmp(argv[1], "--balanced-middle") || strlen(argv[3]) != 32) return 2;
        signal(SIGPIPE, SIG_IGN);
        instanceNonce = @(argv[3]);
        // The harness supplies a fresh private directory; refuse existing or symlink files.
        NSString *destination = @(argv[2]); struct stat parent;
        if (lstat(destination.stringByDeletingLastPathComponent.fileSystemRepresentation, &parent)
            || !S_ISDIR(parent.st_mode) || parent.st_uid != getuid() || (parent.st_mode & 0077)) return 3;
        journal = open(argv[2], O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_APPEND | O_CLOEXEC, 0600);
        if (journal < 0) return 3;
        int parentFD = open(destination.stringByDeletingLastPathComponent.fileSystemRepresentation, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
        if (parentFD < 0 || fsync(parentFD) != 0) { if (parentFD >= 0) close(parentFD); close(journal); return 3; }
        close(parentFD);
        [BalancedApp sharedApplication]; [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
        receipts = [NSMutableArray array];
        usedNonces = [NSMutableSet set];
        window = [[NSWindow alloc] initWithContentRect:NSMakeRect(220,180,480,300)
            styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
        window.title = [NSString stringWithFormat:@"Ruyi P5 Balanced %d %@", getpid(), instanceNonce];
        window.contentView = [[BalancedPad alloc] initWithFrame:NSMakeRect(0,0,480,300)];
        [window makeKeyAndOrderFront:nil]; [NSApp activateIgnoringOtherApps:YES];
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 300 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{ Emit(@"ready", nil); });
        dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED,0), ^{
            char line[4098];
            while (fgets(line, sizeof(line), stdin)) {
                BOOL complete = strchr(line, '\n') != NULL;
                if (!complete) { int value; while ((value = fgetc(stdin)) != EOF && value != '\n') {} }
                NSData *bytes = complete ? [@(line) dataUsingEncoding:NSUTF8StringEncoding] : nil;
                NSDictionary *command = bytes ? [NSJSONSerialization JSONObjectWithData:bytes options:0 error:nil] : nil;
                // Backpressure: at most one bounded command is queued on the main runloop.
                dispatch_sync(dispatch_get_main_queue(), ^{
                    if (![command isKindOfClass:NSDictionary.class]) { Emit(@"rejected", nil); return; }
                    NSString *op = command[@"op"];
                    if (![op isKindOfClass:NSString.class] || op.length > 16
                        || ![command[@"request"] isKindOfClass:NSString.class] || [command[@"request"] length] > 64) { Emit(@"rejected", nil); return; }
                    NSDictionary *state = State();
                    NSString *liveBirth = [command[@"pid"] isKindOfClass:NSNumber.class] ? Birth([command[@"pid"] intValue]) : @"";
                    if ([op isEqual:@"state"]) Emit(op, @{@"request":command[@"request"] ?: @""});
                    else if ([op isEqual:@"arm"] && !armed && journalOK && Neutral(state)
                        && [state[@"frontmost"] boolValue] && [state[@"hit"] boolValue] && [state[@"geometryOK"] boolValue]
                        && [command[@"nonce"] isKindOfClass:NSString.class] && [command[@"nonce"] length] == 32
                        && usedNonces.count < 3 && ![usedNonces containsObject:command[@"nonce"]]
                        && [command[@"pid"] isKindOfClass:NSNumber.class] && CFGetTypeID((__bridge CFTypeRef)command[@"pid"]) != CFBooleanGetTypeID()
                        && [command[@"pid"] doubleValue] == [command[@"pid"] intValue] && [command[@"pid"] intValue] > 1
                        && [command[@"birth"] isKindOfClass:NSString.class] && [command[@"birth"] length] > 0 && [command[@"birth"] length] <= 48
                        && liveBirth.length > 0 && [liveBirth isEqual:command[@"birth"]]) {
                        caseNonce = command[@"nonce"]; expectedPID = [command[@"pid"] intValue]; expectedBirth = command[@"birth"];
                        [usedNonces addObject:caseNonce]; armState = state;
                        armStart = NSProcessInfo.processInfo.systemUptime; armDeadline = armStart + 5;
                        downs = ups = 0; [receipts removeAllObjects]; armed = YES; Emit(@"armed", nil);
                    } else if ([op isEqual:@"disarm"] && Neutral(state)) { armed = NO; Emit(@"disarmed", nil); }
                    else if ([op isEqual:@"quit"] && Neutral(state) && !armed) { Emit(@"quit", nil); close(journal); [NSApp terminate:nil]; }
                    else Emit(@"rejected", nil);
                });
            }
            // EOF does not terminate a potentially non-neutral receiver.
        });
        [NSApp run];
    }
    return 0;
}
