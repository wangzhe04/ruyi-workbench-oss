// P5-02 window identities and clipboard operations. All window coordinates are global logical points.
#import "macos-automation.h"
#import <ImageIO/ImageIO.h>
#include <libproc.h>
#include <sys/proc_info.h>
#include <sys/stat.h>
#include <signal.h>
#include <errno.h>

@interface RuyiWindowBinding : NSObject {
    AXUIElementRef _element;
}
@property(nonatomic, strong) NSDictionary *row;
@property(nonatomic) NSTimeInterval touched;
- (AXUIElementRef)element;
- (void)bindElement:(AXUIElementRef)element;
@end
@implementation RuyiWindowBinding
- (AXUIElementRef)element { return _element; }
- (void)bindElement:(AXUIElementRef)element {
    if (element) CFRetain(element);
    if (_element) CFRelease(_element);
    _element = element;
}
- (void)dealloc { if (_element) CFRelease(_element); }
@end

static NSMutableDictionary<NSString *, RuyiWindowBinding *> *bindings;

void RuyiAutomationResetInputBindings(void) { [bindings removeAllObjects]; }

void RuyiAutomationRefreshInputBindings(void) {
    if (RuyiAutomationLocked() || !AXIsProcessTrusted()) { RuyiAutomationResetInputBindings(); return; }
    NSTimeInterval now = NSProcessInfo.processInfo.systemUptime;
    for (NSString *ref in bindings.allKeys) {
        if (now - bindings[ref].touched > 300) [bindings removeObjectForKey:ref];
    }
}

static NSDictionary *ObserveWindow(NSDictionary *row) {
    if (!row) return nil;
    if (!bindings) bindings = [NSMutableDictionary dictionary];
    RuyiAutomationRefreshInputBindings();
    NSString *ref = nil;
    for (NSString *candidate in bindings) {
        NSDictionary *previous = bindings[candidate].row;
        if ([previous[@"handle"] isEqual:row[@"handle"]] && [previous[@"pid"] isEqual:row[@"pid"]]
            && [previous[@"process_start"] isEqual:row[@"process_start"]]) { ref = candidate; break; }
    }
    if (!ref) {
        if (bindings.count >= 128) {
            NSString *oldest = nil;
            for (NSString *candidate in bindings) {
                if (!oldest || bindings[candidate].touched < bindings[oldest].touched) oldest = candidate;
            }
            [bindings removeObjectForKey:oldest];
        }
        ref = NSUUID.UUID.UUIDString;
        bindings[ref] = [RuyiWindowBinding new];
    }
    NSMutableDictionary *target = [row[@"target"] mutableCopy]; target[@"ref"] = ref;
    NSMutableDictionary *out = [row mutableCopy]; out[@"target"] = target;
    bindings[ref].row = out;
    bindings[ref].touched = NSProcessInfo.processInfo.systemUptime;
    return out;
}

static NSString *ProcessIdentity(pid_t pid) {
    struct proc_bsdinfo info = {0};
    if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info)) != sizeof(info)) return nil;
    return [NSString stringWithFormat:@"%llu:%llu", (unsigned long long)info.pbi_start_tvsec,
        (unsigned long long)info.pbi_start_tvusec];
}

static CFTypeRef CopyAttribute(AXUIElementRef element, CFStringRef attribute) {
    CFTypeRef value = NULL;
    if (AXUIElementCopyAttributeValue(element, attribute, &value) != kAXErrorSuccess) return NULL;
    return value;
}

static CGRect AXBounds(AXUIElementRef window) {
    CFTypeRef position = CopyAttribute(window, kAXPositionAttribute);
    CFTypeRef size = CopyAttribute(window, kAXSizeAttribute);
    CGPoint point; CGSize dimensions;
    BOOL valid = position && size && CFGetTypeID(position) == AXValueGetTypeID()
        && CFGetTypeID(size) == AXValueGetTypeID()
        && AXValueGetValue((AXValueRef)position, kAXValueCGPointType, &point)
        && AXValueGetValue((AXValueRef)size, kAXValueCGSizeType, &dimensions);
    if (position) CFRelease(position);
    if (size) CFRelease(size);
    return valid ? (CGRect){point, dimensions} : CGRectNull;
}

static BOOL NearRect(CGRect first, CGRect second) {
    return !CGRectIsNull(first) && !CGRectIsNull(second)
        && fabs(first.origin.x - second.origin.x) <= 1 && fabs(first.origin.y - second.origin.y) <= 1
        && fabs(first.size.width - second.size.width) <= 1 && fabs(first.size.height - second.size.height) <= 1;
}

static NSDictionary *WindowRow(NSDictionary *info) {
    pid_t pid = [info[(__bridge NSString *)kCGWindowOwnerPID] intValue];
    NSString *identity = ProcessIdentity(pid);
    CGRect bounds = CGRectNull;
    NSDictionary *raw = info[(__bridge NSString *)kCGWindowBounds];
    if (!identity || !raw || !CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)raw, &bounds)
        || CGRectIsEmpty(bounds)) return nil;
    NSNumber *handle = info[(__bridge NSString *)kCGWindowNumber];
    NSDictionary *target = @{@"handle":handle, @"pid":@(pid), @"process_start":identity,
        @"bounds":RuyiAutomationRectFields(bounds)};
    NSMutableDictionary *row = [RuyiAutomationRectFields(bounds) mutableCopy];
    [row addEntriesFromDictionary:@{@"handle":handle, @"pid":@(pid), @"process_start":identity, @"target":target,
        @"title":info[(__bridge NSString *)kCGWindowName] ?: @"",
        @"application":info[(__bridge NSString *)kCGWindowOwnerName] ?: @"",
        @"visible":info[(__bridge NSString *)kCGWindowIsOnscreen] ?: @NO}];
    return row;
}

static NSDictionary *ReadWindow(CGWindowID handle) {
    NSArray *rows = CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionIncludingWindow, handle));
    return rows.count == 1 ? WindowRow(rows.firstObject) : nil;
}

static NSDictionary *ListWindows(void) {
    NSArray *rows = CFBridgingRelease(CGWindowListCopyWindowInfo(
        kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID));
    NSMutableArray *windows = [NSMutableArray array];
    NSTimeInterval deadline = NSProcessInfo.processInfo.systemUptime + 2;
    for (NSDictionary *raw in rows) {
        if (windows.count >= 128 || NSProcessInfo.processInfo.systemUptime >= deadline) break;
        if ([raw[(__bridge NSString *)kCGWindowLayer] intValue] != 0) continue;
        NSDictionary *row = WindowRow(raw);
        if (row) [windows addObject:ObserveWindow(row)];
    }
    return @{@"ok":@YES, @"protocolVersion":@1, @"windows":windows, @"count":@(windows.count),
        @"coordinate_space":@"macos_global_points", @"partial":@(windows.count >= 128 || NSProcessInfo.processInfo.systemUptime >= deadline)};
}

static BOOL ValidTarget(NSDictionary *target) {
    if (![target isKindOfClass:NSDictionary.class] || ![target[@"handle"] isKindOfClass:NSNumber.class]
        || ![target[@"pid"] isKindOfClass:NSNumber.class] || ![target[@"process_start"] isKindOfClass:NSString.class]
        || ![target[@"ref"] isKindOfClass:NSString.class]
        || ![target[@"bounds"] isKindOfClass:NSDictionary.class]) return NO;
    for (NSString *key in @[@"x", @"y", @"width", @"height"]) {
        id value = target[@"bounds"][key];
        if (![value isKindOfClass:NSNumber.class] || CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID()
            || !isfinite([value doubleValue])) return NO;
    }
    for (NSString *key in @[@"handle", @"pid"]) {
        id value = target[key];
        if (CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID()
            || !isfinite([value doubleValue]) || [value doubleValue] != trunc([value doubleValue])) return NO;
    }
    return [target[@"handle"] unsignedLongLongValue] > 0 && [target[@"handle"] unsignedLongLongValue] <= UINT32_MAX
        && [target[@"pid"] longLongValue] > 1 && [target[@"pid"] longLongValue] <= INT_MAX
        && [target[@"bounds"][@"width"] doubleValue] > 0
        && [target[@"bounds"][@"height"] doubleValue] > 0;
}

static NSDictionary *CheckTarget(NSDictionary *target) {
    if (!ValidTarget(target)) return RuyiAutomationFailure(@"target_invalid", @"Pass the target returned by list_windows or get_active_window");
    RuyiAutomationRefreshInputBindings();
    RuyiWindowBinding *binding = bindings[target[@"ref"]];
    if (!binding) return RuyiAutomationFailure(@"target_stale", @"Window reference expired or belongs to another native session");
    NSDictionary *stored = binding.row[@"target"];
    if (![stored[@"handle"] isEqual:target[@"handle"]] || ![stored[@"pid"] isEqual:target[@"pid"]]
        || ![stored[@"process_start"] isEqual:target[@"process_start"]])
        return RuyiAutomationFailure(@"target_stale", @"Window target does not match its retained reference");
    if (![stored[@"process_start"] isEqual:ProcessIdentity([stored[@"pid"] intValue])]) {
        [bindings removeObjectForKey:target[@"ref"]];
        return RuyiAutomationFailure(@"target_stale", @"Process or window identity no longer matches its observation");
    }
    if (![stored[@"bounds"] isEqual:target[@"bounds"]])
        return RuyiAutomationFailure(@"window_changed", @"Window reference has newer observed geometry");
    NSDictionary *current = ReadWindow([target[@"handle"] unsignedIntValue]);
    if ((!current || [binding.row[@"minimized"] boolValue]) && binding.element) {
        CFTypeRef minimized = CopyAttribute(binding.element, kAXMinimizedAttribute);
        // Minimized AX windows may report Dock geometry. CopyTargetWindow below still
        // requires the retained element to belong to this exact process's window list.
        BOOL valid = minimized && CFGetTypeID(minimized) == CFBooleanGetTypeID() && CFBooleanGetValue(minimized);
        if (minimized) CFRelease(minimized);
        if (valid) { binding.touched = NSProcessInfo.processInfo.systemUptime; return binding.row; }
    }
    if (!current || ![current[@"pid"] isEqual:target[@"pid"]]
        || ![current[@"process_start"] isEqual:target[@"process_start"]])
        return RuyiAutomationFailure(@"target_stale", @"Window or process identity has changed. Observe the target again");
    if (!CGRectEqualToRect(RuyiAutomationFieldsRect(current[@"target"][@"bounds"]), RuyiAutomationFieldsRect(target[@"bounds"])))
        return RuyiAutomationFailure(@"window_changed", @"Window geometry changed after observation");
    binding.touched = NSProcessInfo.processInfo.systemUptime;
    NSMutableDictionary *out = [current mutableCopy]; out[@"target"] = stored;
    return out;
}

static AXUIElementRef CopyTargetWindow(NSDictionary *row, NSDictionary **failure) {
    AXUIElementRef app = AXUIElementCreateApplication([row[@"pid"] intValue]);
    AXUIElementSetMessagingTimeout(app, 0.15);
    CFTypeRef raw = CopyAttribute(app, kAXWindowsAttribute); CFRelease(app);
    if (!raw || CFGetTypeID(raw) != CFArrayGetTypeID()) {
        if (raw) CFRelease(raw);
        *failure = RuyiAutomationFailure(@"window_unsupported", @"Application does not expose accessible windows"); return NULL;
    }
    AXUIElementRef matched = NULL;
    CGRect expected = RuyiAutomationFieldsRect(row[@"target"][@"bounds"]);
    NSTimeInterval deadline = NSProcessInfo.processInfo.systemUptime + 2;
    CFIndex count = CFArrayGetCount(raw);
    if (count > 64) { CFRelease(raw); *failure = RuyiAutomationFailure(@"accessibility_capacity", @"Cannot establish a unique window within the enumeration limit"); return NULL; }
    AXUIElementRef cached = bindings[row[@"target"][@"ref"]].element;
    for (CFIndex i = 0; i < count; i++) {
        if (NSProcessInfo.processInfo.systemUptime >= deadline) {
            if (matched) CFRelease(matched); CFRelease(raw);
            *failure = RuyiAutomationFailure(@"accessibility_timeout", @"Cannot establish a unique window before the enumeration deadline"); return NULL;
        }
        AXUIElementRef window = (AXUIElementRef)CFArrayGetValueAtIndex(raw, i);
        if (CFGetTypeID(window) != AXUIElementGetTypeID()) continue;
        AXUIElementSetMessagingTimeout(window, 0.15);
        if (cached) {
            if (!matched && CFEqual(cached, window)) matched = (AXUIElementRef)CFRetain(window);
            continue;
        }
        if (!NearRect(AXBounds(window), expected)) continue;
        NSString *title = CFBridgingRelease(CopyAttribute(window, kAXTitleAttribute));
        if ([row[@"title"] length] && ![row[@"title"] isEqual:title]) continue;
        if (matched) {
            CFRelease(matched); CFRelease(raw);
            *failure = RuyiAutomationFailure(@"window_ambiguous", @"Multiple accessibility windows match the observed target"); return NULL;
        }
        matched = (AXUIElementRef)CFRetain(window);
    }
    CFRelease(raw);
    if (matched) [bindings[row[@"target"][@"ref"]] bindElement:matched];
    if (!matched) *failure = RuyiAutomationFailure(@"window_unsupported", @"Cannot bind this window to a unique accessibility element");
    return matched;
}

static BOOL ForegroundMatches(NSDictionary *row, AXUIElementRef expected) {
    pid_t pid = [row[@"pid"] intValue];
    if (NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier != pid) return NO;
    AXUIElementRef app = AXUIElementCreateApplication(pid); AXUIElementSetMessagingTimeout(app, 0.15);
    CFTypeRef focused = CopyAttribute(app, kAXFocusedWindowAttribute); CFRelease(app);
    if (!focused || CFGetTypeID(focused) != AXUIElementGetTypeID()) { if (focused) CFRelease(focused); return NO; }
    AXUIElementSetMessagingTimeout((AXUIElementRef)focused, 0.15);
    CGRect bounds = AXBounds((AXUIElementRef)focused);
    NSString *title = CFBridgingRelease(CopyAttribute((AXUIElementRef)focused, kAXTitleAttribute));
    BOOL identity = expected ? CFEqual(expected, focused) : ![row[@"title"] length] || [row[@"title"] isEqual:title];
    CFRelease(focused);
    return identity && NearRect(bounds, RuyiAutomationFieldsRect(row[@"target"][@"bounds"]));
}

static NSDictionary *ActiveWindow(void) {
    pid_t pid = NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier;
    NSArray *windows = ListWindows()[@"windows"];
    NSDictionary *matched = nil;
    for (NSDictionary *row in windows) {
        if ([row[@"pid"] intValue] == pid && ForegroundMatches(row, NULL)) {
            if (matched) return RuyiAutomationFailure(@"window_ambiguous", @"Focused window matches multiple screen windows");
            matched = row;
        }
    }
    if (!matched) return RuyiAutomationFailure(@"window_not_found", @"Cannot identify the focused accessible window");
    return @{@"ok":@YES, @"protocolVersion":@1, @"window":matched, @"foreground_verified":@YES};
}

static void RunBriefly(void) {
    [NSRunLoop.currentRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.02]];
}

static BOOL FiniteNumber(id value) {
    return [value isKindOfClass:NSNumber.class] && CFGetTypeID((__bridge CFTypeRef)value) != CFBooleanGetTypeID()
        && isfinite([value doubleValue]);
}

static CGRect RequestedBounds(NSDictionary *request, NSDictionary *row) {
    CGRect bounds = RuyiAutomationFieldsRect(row[@"target"][@"bounds"]);
    NSString *op = request[@"op"];
    if ([op isEqual:@"window.move"] && FiniteNumber(request[@"x"]) && FiniteNumber(request[@"y"])) {
        bounds.origin = CGPointMake([request[@"x"] doubleValue], [request[@"y"] doubleValue]);
    } else if ([op isEqual:@"window.resize"] && FiniteNumber(request[@"width"]) && FiniteNumber(request[@"height"])) {
        bounds.size = CGSizeMake([request[@"width"] doubleValue], [request[@"height"] doubleValue]);
    } else if ([op isEqual:@"window.maximize"]) {
        NSScreen *selected = nil; CGFloat area = 0;
        for (NSScreen *screen in NSScreen.screens) {
            CGRect display = CGDisplayBounds([screen.deviceDescription[@"NSScreenNumber"] unsignedIntValue]);
            CGRect intersection = CGRectIntersection(display, bounds);
            CGFloat candidate = CGRectIsNull(intersection) ? 0 : intersection.size.width * intersection.size.height;
            if (candidate > area) { area = candidate; selected = screen; }
        }
        if (!selected) return CGRectNull;
        NSRect visible = selected.visibleFrame;
        bounds = CGRectMake(visible.origin.x, CGDisplayBounds(CGMainDisplayID()).size.height - NSMaxY(visible),
            visible.size.width, visible.size.height);
    } else return CGRectNull;
    if (bounds.size.width < 32 || bounds.size.height < 32 || bounds.size.width > 16384 || bounds.size.height > 16384)
        return CGRectNull;
    for (NSDictionary *display in RuyiAutomationDisplays()) {
        CGRect intersection = CGRectIntersection(bounds, RuyiAutomationFieldsRect(display));
        if (!CGRectIsNull(intersection) && intersection.size.width >= 32 && intersection.size.height >= 32) return bounds;
    }
    return CGRectNull;
}

static NSDictionary *WindowFailure(NSDictionary *row, AXUIElementRef window, NSString *code, NSString *message) {
    NSMutableDictionary *out = [RuyiAutomationFailure(code, message) mutableCopy];
    out[@"acted"] = @YES;
    out[@"action_sent"] = @YES;
    out[@"outcome"] = @"unconfirmed";
    CGRect actual = AXBounds(window);
    if (!CGRectIsNull(actual)) out[@"actual_bounds"] = RuyiAutomationRectFields(actual);
    NSDictionary *current = ReadWindow([row[@"handle"] unsignedIntValue]);
    if (current && [current[@"pid"] isEqual:row[@"pid"]] && [current[@"process_start"] isEqual:row[@"process_start"]])
        out[@"window"] = ObserveWindow(current);
    return out;
}

static BOOL WindowClosed(NSDictionary *row, AXUIElementRef expected) {
    pid_t pid = [row[@"pid"] intValue];
    NSString *identity = ProcessIdentity(pid);
    if (identity && ![row[@"process_start"] isEqual:identity]) return YES;
    if (!identity) return kill(pid, 0) != 0 && errno == ESRCH;
    AXUIElementRef app = AXUIElementCreateApplication(pid);
    AXUIElementSetMessagingTimeout(app, 0.15);
    CFTypeRef windows = CopyAttribute(app, kAXWindowsAttribute); CFRelease(app);
    if (!windows || CFGetTypeID(windows) != CFArrayGetTypeID() || CFArrayGetCount(windows) > 64) {
        if (windows) CFRelease(windows);
        return NO;
    }
    BOOL absent = YES;
    for (CFIndex i = 0; i < CFArrayGetCount(windows); i++) {
        CFTypeRef candidate = CFArrayGetValueAtIndex(windows, i);
        if (CFGetTypeID(candidate) != AXUIElementGetTypeID() || CFEqual(candidate, expected)) {
            absent = NO; break;
        }
    }
    CFRelease(windows);
    return absent;
}

static NSDictionary *WindowAction(NSDictionary *request) {
    NSDictionary *row = CheckTarget(request[@"target"]);
    if (row[@"error"]) return row;
    NSDictionary *failure = nil;
    AXUIElementRef window = CopyTargetWindow(row, &failure);
    if (!window) return failure;
    NSString *op = request[@"op"];
    AXError result = kAXErrorActionUnsupported;
    CGRect requested = CGRectNull;
    if ([op isEqual:@"window.focus"]) {
        result = AXUIElementSetAttributeValue(window, kAXMinimizedAttribute, kCFBooleanFalse);
        (void)result;
        NSRunningApplication *app = [NSRunningApplication runningApplicationWithProcessIdentifier:[row[@"pid"] intValue]];
        [app activateWithOptions:0];
        AXUIElementRef appElement = AXUIElementCreateApplication([row[@"pid"] intValue]);
        AXUIElementSetMessagingTimeout(appElement, 0.15);
        AXUIElementSetAttributeValue(appElement, kAXFrontmostAttribute, kCFBooleanTrue);
        AXUIElementSetAttributeValue(appElement, kAXFocusedWindowAttribute, window);
        CFRelease(appElement);
        result = AXUIElementPerformAction(window, kAXRaiseAction);
    } else if ([op isEqual:@"window.minimize"]) {
        result = AXUIElementSetAttributeValue(window, kAXMinimizedAttribute, kCFBooleanTrue);
    } else if ([op isEqual:@"window.close"]) {
        CFTypeRef button = CopyAttribute(window, kAXCloseButtonAttribute);
        if (button && CFGetTypeID(button) == AXUIElementGetTypeID())
            result = AXUIElementPerformAction((AXUIElementRef)button, kAXPressAction);
        if (button) CFRelease(button);
    } else {
        requested = RequestedBounds(request, row);
        if (CGRectIsNull(requested)) { CFRelease(window); return RuyiAutomationFailure(@"invalid_args", @"Requested window bounds must intersect an active display and have a valid size"); }
        if (![op isEqual:@"window.resize"]) {
            CGPoint position = requested.origin;
            AXValueRef value = AXValueCreate(kAXValueCGPointType, &position);
            result = AXUIElementSetAttributeValue(window, kAXPositionAttribute, value); CFRelease(value);
        }
        if (![op isEqual:@"window.move"]) {
            CGSize size = requested.size;
            AXValueRef value = AXValueCreate(kAXValueCGSizeType, &size);
            AXError resized = AXUIElementSetAttributeValue(window, kAXSizeAttribute, value); CFRelease(value);
            if ([op isEqual:@"window.resize"]) result = resized;
            else if (resized != kAXErrorSuccess) result = resized;
        }
    }
    if (result != kAXErrorSuccess && ![op isEqual:@"window.focus"]) {
        NSDictionary *out = WindowFailure(row, window, @"window_action_failed", @"Application refused part of the window action");
        CFRelease(window); return out;
    }
    NSTimeInterval deadline = NSProcessInfo.processInfo.systemUptime + 1;
    BOOL matched = NO;
    NSDictionary *current = nil;
    do {
        current = ReadWindow([row[@"handle"] unsignedIntValue]);
        if (current && (![current[@"pid"] isEqual:row[@"pid"]]
            || ![current[@"process_start"] isEqual:row[@"process_start"]])) {
            NSDictionary *out = WindowFailure(row, window, @"target_stale", @"Window identity changed while verifying the action");
            [bindings removeObjectForKey:row[@"target"][@"ref"]];
            CFRelease(window);
            return out;
        }
        if ([op isEqual:@"window.focus"]) matched = current && ForegroundMatches(current, window);
        else if ([op isEqual:@"window.close"]) {
            matched = WindowClosed(row, window);
        } else if ([op isEqual:@"window.minimize"]) {
            CFTypeRef minimized = CopyAttribute(window, kAXMinimizedAttribute);
            matched = minimized && CFGetTypeID(minimized) == CFBooleanGetTypeID() && CFBooleanGetValue(minimized);
            if (minimized) CFRelease(minimized);
        } else matched = current && NearRect(AXBounds(window), requested)
            && NearRect(RuyiAutomationFieldsRect(current[@"target"][@"bounds"]), requested);
        if (!matched) RunBriefly();
    } while (!matched && NSProcessInfo.processInfo.systemUptime < deadline);
    if (!matched) {
        NSDictionary *out = WindowFailure(row, window, @"window_action_unconfirmed", @"Window action was sent but the requested result is unconfirmed");
        CFRelease(window); return out;
    }
    CFRelease(window);
    if ([op isEqual:@"window.minimize"]) {
        NSMutableDictionary *minimized = [row mutableCopy];
        minimized[@"visible"] = @NO; minimized[@"minimized"] = @YES;
        current = minimized;
    }
    if ([op isEqual:@"window.close"]) [bindings removeObjectForKey:row[@"target"][@"ref"]];
    else if (current) current = ObserveWindow(current);
    return @{@"ok":@YES, @"protocolVersion":@1, @"acted":@YES, @"matched":@YES,
        @"window":current ?: @{}, @"foreground_verified":@([op isEqual:@"window.focus"])};
}

static NSArray *SnapshotClipboard(NSPasteboard *board, NSInteger *version) {
    *version = board.changeCount;
    NSMutableArray *items = [NSMutableArray array];
    NSUInteger bytes = 0;
    for (NSPasteboardItem *item in board.pasteboardItems) {
        NSPasteboardItem *copy = [NSPasteboardItem new];
        for (NSPasteboardType type in item.types) {
            NSData *data = [item dataForType:type];
            if (!data || data.length > 32 * 1024 * 1024 - bytes) return nil;
            bytes += data.length;
            if (![copy setData:data forType:type]) return nil;
        }
        [items addObject:copy];
    }
    return board.changeCount == *version ? items : nil;
}

static NSDictionary *WriteClipboard(NSPasteboard *board, NSArray *objects) {
    NSInteger before;
    NSArray *saved = SnapshotClipboard(board, &before);
    if (!saved) return RuyiAutomationFailure(@"clipboard_unavailable", @"Cannot preserve the current clipboard within its capacity limit");
    if (board.changeCount != before) return RuyiAutomationFailure(@"clipboard_changed", @"Clipboard changed before the requested write");
    NSInteger mine = [board clearContents];
    if (![board writeObjects:objects]) {
        BOOL restored = NO;
        if (board.changeCount == mine) {
            [board clearContents]; restored = saved.count == 0 || [board writeObjects:saved];
        }
        return @{@"ok":@NO, @"code":@"clipboard_failed", @"error":@"System clipboard rejected the write", @"restored":@(restored)};
    }
    return @{@"ok":@YES, @"protocolVersion":@1, @"change_count":@(board.changeCount)};
}

static NSDictionary *Clipboard(NSDictionary *request) {
    NSPasteboard *board = NSPasteboard.generalPasteboard;
    NSString *op = request[@"op"];
    if ([op isEqual:@"clipboard.get"]) {
        NSString *text = [board stringForType:NSPasteboardTypeString];
        if ([text lengthOfBytesUsingEncoding:NSUTF8StringEncoding] > 1024 * 1024)
            return RuyiAutomationFailure(@"clipboard_capacity", @"Clipboard text exceeds the one MiB read limit");
        BOOL image = [board canReadObjectForClasses:@[NSImage.class] options:@{}];
        return @{@"ok":@YES, @"protocolVersion":@1, @"text":text ?: @"", @"has_image":@(image),
            @"has_files":@([board.types containsObject:NSPasteboardTypeFileURL]), @"empty":@(board.types.count == 0),
            @"change_count":@(board.changeCount)};
    }
    if ([op isEqual:@"clipboard.set"]) {
        NSString *text = request[@"text"];
        if (![text isKindOfClass:NSString.class] || [text lengthOfBytesUsingEncoding:NSUTF8StringEncoding] > 48000)
            return RuyiAutomationFailure(@"invalid_args", @"Clipboard text must fit within 48000 UTF-8 bytes");
        NSMutableDictionary *out = [WriteClipboard(board, @[text]) mutableCopy];
        if ([out[@"ok"] boolValue]) out[@"length"] = @(text.length);
        return out;
    }
    if ([op isEqual:@"clipboard.image.get"]) {
        NSArray *images = [board readObjectsForClasses:@[NSImage.class] options:@{}];
        if (!images.count) return @{@"ok":@YES, @"protocolVersion":@1, @"has_image":@NO};
        NSImage *image = images.firstObject;
        for (NSImageRep *rep in image.representations) {
            if (rep.pixelsWide > 16384 || rep.pixelsHigh > 16384 || (double)rep.pixelsWide * rep.pixelsHigh > 32000000)
                return RuyiAutomationFailure(@"clipboard_capacity", @"Clipboard image exceeds the pixel limit");
        }
        CGImageRef bitmap = [image CGImageForProposedRect:NULL context:nil hints:nil];
        if (!bitmap || (double)CGImageGetWidth(bitmap) * CGImageGetHeight(bitmap) > 32000000)
            return RuyiAutomationFailure(@"clipboard_capacity", @"Cannot decode clipboard image within the pixel limit");
        NSMutableDictionary *out = [RuyiAutomationEncodeImage(bitmap, NO) mutableCopy];
        out[@"has_image"] = @YES; return out;
    }
    if ([op isEqual:@"clipboard.image.set"]) {
        NSString *path = request[@"path"];
        struct stat info;
        if (![path isKindOfClass:NSString.class] || !path.isAbsolutePath || stat(path.fileSystemRepresentation, &info)
            || !S_ISREG(info.st_mode) || info.st_size > 48 * 1024 * 1024)
            return RuyiAutomationFailure(@"invalid_args", @"Pass an existing bounded image file using an absolute path");
        CGImageSourceRef source = CGImageSourceCreateWithURL((__bridge CFURLRef)[NSURL fileURLWithPath:path], NULL);
        if (!source) return RuyiAutomationFailure(@"image_invalid", @"Unsupported image file");
        NSDictionary *properties = CFBridgingRelease(CGImageSourceCopyPropertiesAtIndex(source, 0, NULL));
        double width = [properties[(__bridge NSString *)kCGImagePropertyPixelWidth] doubleValue];
        double height = [properties[(__bridge NSString *)kCGImagePropertyPixelHeight] doubleValue];
        if (width < 1 || height < 1 || width > 16384 || height > 16384 || width * height > 32000000) {
            CFRelease(source); return RuyiAutomationFailure(@"image_invalid", @"Image exceeds the pixel limit");
        }
        CGImageRef bitmap = CGImageSourceCreateImageAtIndex(source, 0, NULL); CFRelease(source);
        if (!bitmap) return RuyiAutomationFailure(@"image_invalid", @"Cannot decode the image file");
        NSImage *image = [[NSImage alloc] initWithCGImage:bitmap size:NSMakeSize(width,height)]; CGImageRelease(bitmap);
        NSMutableDictionary *out = [WriteClipboard(board, @[image]) mutableCopy];
        if ([out[@"ok"] boolValue]) [out addEntriesFromDictionary:@{@"width":@(width), @"height":@(height)}];
        return out;
    }
    return RuyiAutomationFailure(@"invalid_args", @"Unsupported clipboard operation");
}

NSDictionary *RuyiAutomationInputStatus(void) {
    BOOL trusted = AXIsProcessTrusted();
    BOOL locked = RuyiAutomationLocked();
    return @{@"windowAuthorization":trusted ? @"granted" : @"denied", @"windowReady":@(trusted && !locked),
        @"windowListReady":@(!locked), @"clipboardReady":@(!locked)};
}

NSDictionary *RuyiAutomationInputRequest(NSDictionary *request) {
    NSSet *keys = [NSSet setWithArray:@[@"version", @"op", @"target", @"text", @"path", @"x", @"y", @"width", @"height"]];
    for (NSString *key in request) {
        if (![keys containsObject:key]) return RuyiAutomationFailure(@"invalid_args", @"Unexpected desktop operation field");
    }
    if (RuyiAutomationLocked()) {
        RuyiAutomationResetInputBindings();
        return RuyiAutomationFailure(@"session_locked", @"Unlock the desktop before interacting with windows or the clipboard");
    }
    NSString *op = request[@"op"];
    if ([op hasPrefix:@"clipboard."]) return Clipboard(request);
    if ([op isEqual:@"window.list"]) return ListWindows();
    if (!AXIsProcessTrusted()) {
        RuyiAutomationResetInputBindings();
        return RuyiAutomationFailure(@"permission_denied", @"Enable Accessibility for the responsible application in System Settings");
    }
    if ([op isEqual:@"window.active"]) return ActiveWindow();
    if ([@[@"window.focus", @"window.minimize", @"window.close", @"window.move", @"window.resize", @"window.maximize"] containsObject:op])
        return WindowAction(request);
    return RuyiAutomationFailure(@"invalid_args", @"Unsupported desktop operation");
}
