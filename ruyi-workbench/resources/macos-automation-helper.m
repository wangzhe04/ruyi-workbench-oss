// P5 native desktop backend. One bounded JSON request on stdin, one JSON result on stdout.
// Coordinates use Quartz global logical points, with the primary display's top-left at (0,0).
#import "macos-automation.h"
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <ImageIO/ImageIO.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>
#include <poll.h>
#include <unistd.h>

NSDictionary *RuyiAutomationFailure(NSString *code, NSString *message) {
    return @{@"ok":@NO, @"code":code, @"error":message};
}

NSDictionary *RuyiAutomationRectFields(CGRect rect) {
    return @{@"x":@(rect.origin.x), @"y":@(rect.origin.y),
        @"width":@(rect.size.width), @"height":@(rect.size.height)};
}

BOOL RuyiAutomationLocked(void) {
    NSDictionary *session = CFBridgingRelease(CGSessionCopyCurrentDictionary());
    return !session || [session[@"CGSSessionScreenIsLocked"] boolValue];
}

NSArray *RuyiAutomationDisplays(void) {
    CGDirectDisplayID ids[64]; uint32_t count = 0;
    if (CGGetActiveDisplayList(64, ids, &count) != kCGErrorSuccess) return @[];
    NSMutableArray *out = [NSMutableArray array];
    for (uint32_t i = 0; i < count; i++) {
        CGFloat scale = 1;
        for (NSScreen *screen in NSScreen.screens) {
            if ([screen.deviceDescription[@"NSScreenNumber"] unsignedIntValue] == ids[i]) {
                scale = screen.backingScaleFactor; break;
            }
        }
        NSMutableDictionary *display = [RuyiAutomationRectFields(CGDisplayBounds(ids[i])) mutableCopy];
        [display addEntriesFromDictionary:@{@"index":@(i), @"id":@(ids[i]), @"scale":@(scale),
            @"is_primary":@(ids[i] == CGMainDisplayID())}];
        [out addObject:display];
    }
    return out;
}

static CGRect DisplayUnion(NSArray *displays) {
    CGRect bounds = CGRectNull;
    for (NSDictionary *display in displays) {
        bounds = CGRectUnion(bounds, CGRectMake([display[@"x"] doubleValue], [display[@"y"] doubleValue],
            [display[@"width"] doubleValue], [display[@"height"] doubleValue]));
    }
    return bounds;
}

static NSDictionary *Status(void) {
    NSArray *displays = RuyiAutomationDisplays();
    BOOL granted = CGPreflightScreenCaptureAccess();
    BOOL locked = RuyiAutomationLocked();
    NSMutableDictionary *out = [@{@"ok":@YES, @"protocolVersion":@1, @"coordinate_space":@"macos_global_points",
        @"authorization":granted ? @"granted" : @"denied", @"locked":@(locked),
        @"ready":@(granted && !locked && displays.count > 0), @"monitors":displays,
        @"virtual":displays.count ? RuyiAutomationRectFields(DisplayUnion(displays)) : @{},
        @"permissionRequestsMade":@NO, @"backend":@"ScreenCaptureKit"} mutableCopy];
    [out addEntriesFromDictionary:RuyiAutomationInputStatus()];
    [out addEntriesFromDictionary:RuyiAutomationOCRStatus()];
    return out;
}

static void Content(void (^completion)(SCShareableContent *, NSError *)) {
    [SCShareableContent getShareableContentExcludingDesktopWindows:NO onScreenWindowsOnly:NO completionHandler:completion];
}

static void Image(SCContentFilter *filter, CGRect source, CGFloat scale,
                  void (^completion)(CGImageRef, NSError *)) {
    SCStreamConfiguration *config = [SCStreamConfiguration new];
    config.width = (size_t)llround(source.size.width * scale);
    config.height = (size_t)llround(source.size.height * scale);
    config.sourceRect = source;
    config.showsCursor = NO;
    config.ignoreShadowsSingleWindow = YES;
    config.captureResolution = SCCaptureResolutionBest;
    [SCScreenshotManager captureImageWithFilter:filter configuration:config completionHandler:completion];
}

NSDictionary *RuyiAutomationEncodeImage(CGImageRef image, BOOL rejectBlank) {
    if (!image) return RuyiAutomationFailure(@"capture_failed", @"Missing image bitmap");
    size_t width = CGImageGetWidth(image), height = CGImageGetHeight(image);
    CGColorSpaceRef colors = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    CGContextRef bitmap = CGBitmapContextCreate(NULL, width, height, 8, width * 4, colors,
        kCGBitmapByteOrder32Big | kCGImageAlphaPremultipliedLast);
    CGColorSpaceRelease(colors);
    if (!bitmap) return RuyiAutomationFailure(@"capture_capacity", @"Cannot verify capture bitmap");
    CGContextDrawImage(bitmap, CGRectMake(0, 0, width, height), image);
    const uint8_t *pixels = CGBitmapContextGetData(bitmap);
    BOOL black = YES;
    for (size_t offset = 0; offset < width * height * 4; offset += 4) {
        if (pixels[offset] || pixels[offset + 1] || pixels[offset + 2]) { black = NO; break; }
    }
    CGImageRef normalized = CGBitmapContextCreateImage(bitmap);
    CGContextRelease(bitmap);
    if ((rejectBlank && black) || !normalized) {
        if (normalized) CGImageRelease(normalized);
        return RuyiAutomationFailure(@"capture_blank", @"Capture is completely black. Check the desktop session and screen permission");
    }
    NSMutableData *png = [NSMutableData data];
    CGImageDestinationRef destination = CGImageDestinationCreateWithData((__bridge CFMutableDataRef)png,
        (__bridge CFStringRef)UTTypePNG.identifier, 1, NULL);
    if (!destination) { CGImageRelease(normalized); return RuyiAutomationFailure(@"capture_failed", @"Cannot create image encoder"); }
    CGImageDestinationAddImage(destination, normalized, NULL); CGImageRelease(normalized);
    BOOL encoded = CGImageDestinationFinalize(destination); CFRelease(destination);
    if (!encoded || png.length > 48 * 1024 * 1024) return RuyiAutomationFailure(@"capture_capacity", @"Encoded image exceeds capture capacity");
    return @{@"ok":@YES, @"protocolVersion":@1, @"png":[png base64EncodedStringWithOptions:0],
        @"width":@(width), @"height":@(height)};
}

static NSDictionary *Encoded(CGImageRef image, CGRect bounds, NSDictionary *extra) {
    if (!image || RuyiAutomationLocked() || !CGPreflightScreenCaptureAccess())
        return RuyiAutomationFailure(@"capture_unavailable", @"Capture authorization or desktop session changed during capture");
    NSDictionary *encoded = RuyiAutomationEncodeImage(image, YES);
    if (![encoded[@"ok"] boolValue]) return encoded;
    NSMutableDictionary *out = [encoded mutableCopy];
    [out addEntriesFromDictionary:@{@"logical_bounds":RuyiAutomationRectFields(bounds),
        @"coordinate_space":@"macos_global_points", @"method":@"ScreenCaptureKit"}];
    [out addEntriesFromDictionary:extra];
    return out;
}

static BOOL WithinCapacity(CGRect rect, CGFloat scale) {
    double width = round(rect.size.width * scale), height = round(rect.size.height * scale);
    return isfinite(width) && isfinite(height) && width >= 1 && height >= 1
        && width <= 16384 && height <= 16384 && width * height <= 32000000;
}

static void CaptureWindow(NSDictionary *request, SCShareableContent *content, void (^done)(NSDictionary *)) {
    NSString *title = request[@"window_title"];
    NSMutableArray<SCWindow *> *matches = [NSMutableArray array];
    NSMutableArray<SCWindow *> *exact = [NSMutableArray array];
    for (SCWindow *window in content.windows) {
        if (window.windowLayer != 0 || !window.title.length) continue;
        if ([window.title rangeOfString:title options:NSCaseInsensitiveSearch].location != NSNotFound)
            [matches addObject:window];
        if ([window.title caseInsensitiveCompare:title] == NSOrderedSame) [exact addObject:window];
    }
    if (exact.count) matches = exact;
    if (!matches.count) { done(RuyiAutomationFailure(@"window_not_found", @"No matching capturable window")); return; }
    if (matches.count != 1) {
        NSMutableArray *candidates = [NSMutableArray array];
        for (SCWindow *window in matches) {
            if (candidates.count == 20) break;
            [candidates addObject:@{@"title":window.title, @"id":@(window.windowID),
                @"pid":@(window.owningApplication.processID)}];
        }
        done(@{@"ok":@NO, @"code":@"window_ambiguous", @"error":@"Multiple windows match the title",
            @"candidates":candidates}); return;
    }
    SCWindow *window = matches.firstObject;
    if (!window.isOnScreen) { done(RuyiAutomationFailure(@"window_not_visible", @"Window is minimized or outside the active desktop")); return; }
    CGRect bounds = window.frame;
    SCContentFilter *filter = [[SCContentFilter alloc] initWithDesktopIndependentWindow:window];
    CGFloat scale = filter.pointPixelScale;
    if (!WithinCapacity(bounds, scale)) { done(RuyiAutomationFailure(@"capture_capacity", @"Window size exceeds capture capacity")); return; }
    // A desktop-independent filter captures the selected window even when covered.
    // No focus or restore operation is performed as a side effect of observation.
    Image(filter, CGRectMake(0, 0, bounds.size.width, bounds.size.height), scale, ^(CGImageRef image, NSError *error) {
        if (error || !image) { done(RuyiAutomationFailure(@"capture_failed", @"Window capture failed or the window disappeared")); return; }
        NSArray *current = CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionIncludingWindow, window.windowID));
        NSDictionary *identity = current.firstObject;
        CGRect frame = CGRectNull;
        if (identity) CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)identity[(__bridge NSString *)kCGWindowBounds], &frame);
        if (!identity || [identity[(__bridge NSString *)kCGWindowOwnerPID] intValue] != window.owningApplication.processID
            || ![identity[(__bridge NSString *)kCGWindowIsOnscreen] boolValue] || !CGRectEqualToRect(frame, bounds)) {
            done(RuyiAutomationFailure(@"window_changed", @"Window identity, visibility or geometry changed during capture")); return;
        }
        done(Encoded(image, bounds, @{@"matched_title":window.title, @"window_id":@(window.windowID),
            @"pid":@(window.owningApplication.processID), @"occluded_possible":@NO}));
    });
}

static NSDictionary *PlanDisplays(NSDictionary *request, NSArray *displays) {
    if (!displays.count) return RuyiAutomationFailure(@"display_unavailable", @"No active displays");
    CGRect requested = CGRectNull;
    id region = request[@"region"];
    id monitor = request[@"monitor"];
    if (region) {
        if (![region isKindOfClass:NSArray.class] || [region count] != 4) {
            return RuyiAutomationFailure(@"invalid_args", @"region must contain x, y, width, height");
        }
        for (id value in region) {
            if (![value isKindOfClass:NSNumber.class] || CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID()
                || !isfinite([value doubleValue]) || [value doubleValue] != trunc([value doubleValue])) {
                return RuyiAutomationFailure(@"invalid_args", @"region coordinates must be finite integers");
            }
        }
        requested = CGRectMake([region[0] doubleValue], [region[1] doubleValue],
            [region[2] doubleValue], [region[3] doubleValue]);
        if (requested.size.width <= 0 || requested.size.height <= 0) {
            return RuyiAutomationFailure(@"invalid_args", @"region size must be positive");
        }
    } else if ([monitor isEqual:@"all"] || [monitor isEqual:@"virtual"]) {
        requested = DisplayUnion(displays);
    } else {
        NSDictionary *selected = nil;
        for (NSDictionary *display in displays) {
            if ((!monitor && [display[@"is_primary"] boolValue]) || [monitor isEqual:display[@"index"]]) selected = display;
        }
        if (!selected) return RuyiAutomationFailure(@"monitor_not_found", @"Monitor index not found");
        requested = CGRectMake([selected[@"x"] doubleValue], [selected[@"y"] doubleValue],
            [selected[@"width"] doubleValue], [selected[@"height"] doubleValue]);
    }
    CGRect clipped = CGRectIntersection(requested, DisplayUnion(displays));
    NSMutableArray *parts = [NSMutableArray array];
    CGFloat scale = 1;
    for (NSDictionary *display in displays) {
        CGRect bounds = CGRectMake([display[@"x"] doubleValue], [display[@"y"] doubleValue],
            [display[@"width"] doubleValue], [display[@"height"] doubleValue]);
        CGRect intersection = CGRectIntersection(clipped, bounds);
        if (CGRectIsNull(intersection) || CGRectIsEmpty(intersection)) continue;
        scale = MAX(scale, [display[@"scale"] doubleValue]);
        [parts addObject:@{@"display_id":display[@"id"], @"rect":RuyiAutomationRectFields(intersection), @"bounds":RuyiAutomationRectFields(bounds),
            @"source":RuyiAutomationRectFields(CGRectOffset(intersection, -bounds.origin.x, -bounds.origin.y))}];
    }
    if (!parts.count) return RuyiAutomationFailure(@"region_outside_desktop", @"Region does not intersect an active display");
    if (!WithinCapacity(clipped, scale)) return RuyiAutomationFailure(@"capture_capacity", @"Region exceeds capture capacity");
    NSMutableDictionary *plan = [@{@"ok":@YES, @"protocolVersion":@1, @"parts":parts, @"bounds":RuyiAutomationRectFields(clipped),
        @"scale":@(scale), @"clipped":@(!CGRectEqualToRect(requested, clipped))} mutableCopy];
    if (region && !CGRectEqualToRect(requested, clipped)) plan[@"requested_region"] = RuyiAutomationRectFields(requested);
    if (monitor) plan[@"monitor"] = monitor;
    return plan;
}

CGRect RuyiAutomationFieldsRect(NSDictionary *value) {
    return CGRectMake([value[@"x"] doubleValue], [value[@"y"] doubleValue],
        [value[@"width"] doubleValue], [value[@"height"] doubleValue]);
}

static void CaptureDisplays(NSDictionary *request, SCShareableContent *content, void (^done)(NSDictionary *)) {
    NSArray *baseline = RuyiAutomationDisplays();
    NSMutableArray *displays = [NSMutableArray array];
    NSMutableDictionary *filters = [NSMutableDictionary dictionary];
    for (SCDisplay *display in content.displays) {
        SCContentFilter *filter = [[SCContentFilter alloc] initWithDisplay:display excludingWindows:@[]];
        filters[@(display.displayID)] = filter;
    }
    for (NSDictionary *display in baseline) {
        NSMutableDictionary *details = [display mutableCopy];
        SCContentFilter *filter = filters[display[@"id"]];
        if (!filter) { done(RuyiAutomationFailure(@"display_changed", @"Active display is missing from the capturable layout")); return; }
        details[@"scale"] = @(filter.pointPixelScale); [displays addObject:details];
    }
    NSDictionary *plan = PlanDisplays(request, displays);
    if (![plan[@"ok"] boolValue]) { done(plan); return; }
    NSArray *parts = plan[@"parts"];
    CGFloat scale = [plan[@"scale"] doubleValue];
    CGRect clipped = RuyiAutomationFieldsRect(plan[@"bounds"]);
    size_t width = (size_t)llround(clipped.size.width * scale), height = (size_t)llround(clipped.size.height * scale);
    CGColorSpaceRef colors = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    CGContextRef canvas = CGBitmapContextCreate(NULL, width, height, 8, width * 4, colors, kCGImageAlphaPremultipliedLast);
    CGColorSpaceRelease(colors);
    if (!canvas) { done(RuyiAutomationFailure(@"capture_capacity", @"Cannot allocate capture bitmap")); return; }
    // Serialize callbacks to avoid concurrent writes into the shared canvas.
    __block NSUInteger index = 0;
    __block void (^next)(void);
    next = ^{
        if (index == parts.count) {
            if (![baseline isEqual:RuyiAutomationDisplays()]) {
                CGContextRelease(canvas); done(RuyiAutomationFailure(@"display_changed", @"Display identity, layout or scale changed during capture")); next = nil; return;
            }
            CGImageRef image = CGBitmapContextCreateImage(canvas); CGContextRelease(canvas);
            NSMutableDictionary *extra = [plan mutableCopy];
            [extra removeObjectsForKeys:@[@"parts", @"bounds", @"scale", @"ok", @"protocolVersion"]];
            done(Encoded(image, clipped, extra)); if (image) CGImageRelease(image);
            next = nil; return;
        }
        NSDictionary *part = parts[index++];
        CGRect rect = RuyiAutomationFieldsRect(part[@"rect"]);
        CGRect source = RuyiAutomationFieldsRect(part[@"source"]);
        Image(filters[part[@"display_id"]], source, scale, ^(CGImageRef image, NSError *error) {
            if (image) CGImageRetain(image);
            dispatch_async(dispatch_get_main_queue(), ^{
                if (error || !image) {
                    if (image) CGImageRelease(image);
                    CGContextRelease(canvas); done(RuyiAutomationFailure(@"capture_failed", @"Display capture failed")); next = nil; return;
                }
                CGRect target = CGRectMake(round((rect.origin.x - clipped.origin.x) * scale),
                    round((clipped.origin.y + clipped.size.height - CGRectGetMaxY(rect)) * scale),
                    CGImageGetWidth(image), CGImageGetHeight(image));
                CGContextDrawImage(canvas, target, image); CGImageRelease(image); next();
            });
        });
    };
    next();
}

static void HandleRequest(NSDictionary *request, void (^done)(NSDictionary *)) {
    if (![request[@"version"] isKindOfClass:NSNumber.class]
        || CFGetTypeID((__bridge CFTypeRef)request[@"version"]) == CFBooleanGetTypeID()
        || ![request[@"version"] isEqual:@1] || ![request[@"op"] isKindOfClass:NSString.class]) {
        done(RuyiAutomationFailure(@"invalid_args", @"Expected protocol version 1 and an operation")); return;
    }
    NSString *op = request[@"op"];
    if ([op hasPrefix:@"ocr."]) {
        dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{ done(RuyiAutomationOCRRequest(request)); });
        return;
    }
#ifdef RUYI_AUTOMATION_TESTING
    if ([op isEqual:@"test_pointer_subtypes"]) { done(RuyiAutomationTestPointerSubtypes()); return; }
    if ([op isEqual:@"test_stopped_mutations"]) { done(RuyiAutomationTestStoppedMutations()); return; }
    if ([op isEqual:@"test_validate_sequence"]) {
        done(RuyiAutomationValidateSequence(request[@"events"], request[@"bounds"], YES) ?: @{@"ok":@YES, @"protocolVersion":@1}); return;
    }
    if ([op isEqual:@"test_release_allocation"]) { done(RuyiAutomationTestReleaseAllocation()); return; }
    if ([op isEqual:@"test_input_state"]) { done(RuyiAutomationTestInputState()); return; }
    if ([op isEqual:@"test_ax_state"]) { done(RuyiAutomationTestAXState(request)); return; }
    // This operation exists only in a separately named test binary. It exercises the production planner.
    if ([op isEqual:@"test_plan"] && [request[@"displays"] isKindOfClass:NSArray.class]) {
        done(PlanDisplays(request, request[@"displays"])); return;
    }
#endif
    if ([op hasPrefix:@"window."] || [op hasPrefix:@"clipboard."] || [op isEqual:@"input.sequence"] || [op hasPrefix:@"keyboard."] || [op hasPrefix:@"mouse."]
        || [op hasPrefix:@"application."] || [op hasPrefix:@"ax."]) {
        done(RuyiAutomationInputRequest(request)); return;
    }
    NSSet *keys = [NSSet setWithArray:@[@"version", @"op", @"region", @"monitor", @"window_title"]];
    for (NSString *key in request) {
        if (![keys containsObject:key]) { done(RuyiAutomationFailure(@"invalid_args", @"Unexpected request field")); return; }
    }
    if ([op isEqual:@"status"]) {
        if (request.count != 2) { done(RuyiAutomationFailure(@"invalid_args", @"status does not accept capture arguments")); return; }
        done(Status()); return;
    }
    if (![op isEqual:@"capture"]) { done(RuyiAutomationFailure(@"invalid_args", @"Unsupported operation")); return; }
    id title = request[@"window_title"];
    if (title && (![title isKindOfClass:NSString.class] || ![title length] || [title length] > 1024)) {
        done(RuyiAutomationFailure(@"invalid_args", @"window_title must contain 1 to 1024 characters")); return;
    }
    if (RuyiAutomationLocked()) { done(RuyiAutomationFailure(@"session_locked", @"Unlock the desktop before capturing")); return; }
    if (!CGPreflightScreenCaptureAccess()) {
        done(RuyiAutomationFailure(@"permission_denied", @"Enable Screen Recording for the responsible application in System Settings, then retry")); return;
    }
    Content(^(SCShareableContent *content, NSError *error) {
        if (error || !content) { done(RuyiAutomationFailure(@"capture_unavailable", @"Cannot enumerate capturable content")); return; }
        dispatch_async(dispatch_get_main_queue(), ^{
            if (title) CaptureWindow(request, content, done); else CaptureDisplays(request, content, done);
        });
    });
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        if (argc == 2 && strcmp(argv[1], "--input-session") == 0) return RuyiAutomationRunInputSession();
        if (argc != 1) return 64;
        NSMutableData *input = [NSMutableData data];
        NSTimeInterval inputDeadline = NSProcessInfo.processInfo.systemUptime + 3;
        while (input.length <= 65536) {
            int remaining = (int)ceil((inputDeadline - NSProcessInfo.processInfo.systemUptime) * 1000);
            struct pollfd descriptor = {STDIN_FILENO, POLLIN, 0};
            if (remaining <= 0 || poll(&descriptor, 1, remaining) <= 0) { input = nil; break; }
            uint8_t buffer[8192];
            ssize_t count = read(STDIN_FILENO, buffer, sizeof(buffer));
            if (count == 0) break;
            if (count < 0) { input = nil; break; }
            [input appendBytes:buffer length:(NSUInteger)count];
        }
        id request = input && input.length <= 65536 ? [NSJSONSerialization JSONObjectWithData:input options:0 error:nil] : nil;
        __block BOOL finished = NO;
        NSObject *completionLock = [NSObject new];
        void (^done)(NSDictionary *) = ^(NSDictionary *result) {
            @synchronized (completionLock) {
                if (finished) return; finished = YES;
                NSData *data = [NSJSONSerialization dataWithJSONObject:result options:NSJSONWritingSortedKeys error:nil];
                [NSFileHandle.fileHandleWithStandardOutput writeData:data];
                [NSFileHandle.fileHandleWithStandardOutput writeData:[@"\n" dataUsingEncoding:NSUTF8StringEncoding]];
                exit([result[@"ok"] boolValue] ? 0 : 1);
            }
        };
        if (![request isKindOfClass:NSDictionary.class]) done(RuyiAutomationFailure(@"invalid_args", @"Invalid or oversized JSON request"));
        BOOL ocr = [request[@"op"] isKindOfClass:NSString.class] && [request[@"op"] hasPrefix:@"ocr."];
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (ocr ? 60 : 12) * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
            done(RuyiAutomationFailure(ocr ? @"ocr_timeout" : @"capture_timeout", @"Desktop request exceeded its deadline"));
        });
        HandleRequest(request, done);
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
        [NSApp run];
    }
    return 1;
}
