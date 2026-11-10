// Bounded semantic recording of this worker's guarded input requests.
#import "macos-automation.h"
#import <Carbon/Carbon.h>

static NSMutableArray *recordedActions;
static NSDictionary *recordedTarget;
static NSDictionary *recordedApplication;
static NSTimeInterval recordDeadline;
static NSTimeInterval recordStarted;
static NSUInteger recordBytes;
static NSString *recordEnd;

NSDictionary *RuyiAutomationRecordStatus(void) {
    return @{@"recordSupported":@YES, @"recordReady":@(AXIsProcessTrusted() && CGPreflightPostEventAccess()
        && !RuyiAutomationLocked() && !IsSecureEventInputEnabled()), @"recordSource":@"controlled_native_requests"};
}

void RuyiAutomationEndRecording(NSString *reason) {
    if (recordedActions && !recordEnd) recordEnd = reason;
}

static NSDictionary *RecordingTarget(NSDictionary *target) {
    if (RuyiAutomationEventsStopping()) return RuyiAutomationFailure(@"input_cancelled", @"Input worker is stopping");
    if (RuyiAutomationLocked()) return RuyiAutomationFailure(@"session_locked", @"Recording requires an unlocked desktop");
    if (!AXIsProcessTrusted() || !CGPreflightPostEventAccess())
        return RuyiAutomationFailure(@"permission_denied", @"Recording requires Accessibility and event posting access");
    if (IsSecureEventInputEnabled()) return RuyiAutomationFailure(@"secure_input", @"Recording is unavailable during secure input");
    NSDictionary *row = RuyiAutomationCheckTarget(target);
    if (row[@"ok"] && ![row[@"ok"] boolValue]) return row;
    NSDictionary *failure = nil;
    AXUIElementRef window = RuyiAutomationCopyTargetWindow(row, &failure);
    if (!window) return failure;
    BOOL foreground = RuyiAutomationForegroundMatches(row, window);
    CFRelease(window);
    if (!foreground) return RuyiAutomationFailure(@"focus_changed", @"Recording target must be the current focused window");
    NSRunningApplication *app = [NSRunningApplication runningApplicationWithProcessIdentifier:[row[@"pid"] intValue]];
    NSString *executable = app.executableURL.URLByResolvingSymlinksInPath.path;
    if (!executable.length) return RuyiAutomationFailure(@"application_identity_unknown", @"Cannot identify the recording application");
    return @{@"ok":@YES, @"protocolVersion":@1, @"target":row[@"target"],
        @"recording_pending":recordedActions ? @YES : @NO,
        @"application":@{@"bundle_id":app.bundleIdentifier ?: @"", @"executable":executable}};
}

void RuyiAutomationRefreshRecording(void) {
    if (!recordedActions || recordEnd) return;
    if (NSProcessInfo.processInfo.systemUptime >= recordDeadline) {
        RuyiAutomationEndRecording(@"deadline"); return;
    }
    NSDictionary *current = RecordingTarget(recordedTarget);
    if (![current[@"ok"] boolValue]) RuyiAutomationEndRecording(current[@"code"] ?: @"target_changed");
    else if (![current[@"application"] isEqual:recordedApplication]) RuyiAutomationEndRecording(@"application_changed");
}

NSDictionary *RuyiAutomationRecordRequest(NSDictionary *request) {
    NSString *op = request[@"op"];
    NSSet *allowed = [NSSet setWithArray:[op isEqual:@"record.start"]
        ? @[@"op", @"version", @"target", @"max_seconds"] : [op isEqual:@"record.target"]
        ? @[@"op", @"version", @"target", @"actions"] : @[@"op", @"version"]];
    for (NSString *key in request)
        if (![allowed containsObject:key]) return RuyiAutomationFailure(@"invalid_args", @"Unexpected recording field");
    if ([op isEqual:@"record.target"]) {
        NSArray *actions = request[@"actions"] ?: @[];
        if (![actions isKindOfClass:NSArray.class] || actions.count > 100)
            return RuyiAutomationFailure(@"invalid_args", @"Pass at most 100 recorded actions");
        for (NSDictionary *action in actions) {
            if (![action isKindOfClass:NSDictionary.class]) return RuyiAutomationFailure(@"invalid_args", @"Invalid recorded action");
            NSDictionary *failure = nil;
            if ([action[@"op"] isEqual:@"keyboard.chord"] && !RuyiAutomationChordKeys(action[@"keys"], &failure)) return failure;
            if ([action[@"op"] isEqual:@"keyboard.text"]) {
                failure = RuyiAutomationValidateText(action);
                if (failure) return failure;
            }
        }
        return RecordingTarget(request[@"target"]);
    }
    if ([op isEqual:@"record.start"]) {
        if (recordedActions) return RuyiAutomationFailure(@"recording_exists", @"Stop and collect the previous recording first");
        id seconds = request[@"max_seconds"];
        if (!RuyiAutomationFiniteNumber(seconds) || [seconds doubleValue] < 1 || [seconds doubleValue] > 300)
            return RuyiAutomationFailure(@"invalid_args", @"max_seconds must be a finite number from 1 to 300");
        NSDictionary *current = RecordingTarget(request[@"target"]);
        if (![current[@"ok"] boolValue]) return current;
        recordedTarget = [current[@"target"] copy]; recordedApplication = current[@"application"];
        recordedActions = [NSMutableArray array]; recordEnd = nil; recordBytes = 0;
        recordStarted = NSProcessInfo.processInfo.systemUptime;
        recordDeadline = recordStarted + [seconds doubleValue];
        return @{@"ok":@YES, @"protocolVersion":@1, @"recording":@YES,
            @"source":@"controlled_native_requests", @"max_seconds":seconds};
    }
    if ([op isEqual:@"record.stop"]) {
        if (!recordedActions) return RuyiAutomationFailure(@"recording_absent", @"No recording to collect");
        RuyiAutomationRefreshRecording();
        NSDictionary *recording = @{@"schema":@1, @"platform":@"darwin", @"coordinate_space":@"macos_global_points",
            @"source":@"controlled_native_requests", @"application":recordedApplication,
            @"bounds":recordedTarget[@"bounds"], @"complete":recordEnd ? @NO : @YES,
            @"end_reason":recordEnd ?: @"stopped", @"actions":[recordedActions copy]};
        recordedActions = nil; recordedTarget = nil; recordedApplication = nil; recordEnd = nil;
        return @{@"ok":@YES, @"protocolVersion":@1, @"recording":recording};
    }
    return RuyiAutomationFailure(@"invalid_args", @"Unsupported recording operation");
}

static BOOL Recordable(NSString *op) {
    return [@[@"keyboard.text", @"keyboard.chord", @"mouse.click", @"mouse.move", @"mouse.drag", @"mouse.scroll"] containsObject:op];
}

void RuyiAutomationBeforeRecordedRequest(NSDictionary *request) {
    RuyiAutomationRefreshRecording();
    if (recordedActions && !recordEnd && Recordable(request[@"op"]) && ![request[@"target"] isEqual:recordedTarget])
        RuyiAutomationEndRecording(@"target_changed");
}

void RuyiAutomationAfterRecordedRequest(NSDictionary *request, NSDictionary *result, NSTimeInterval began) {
    if (!recordedActions || recordEnd) return;
    RuyiAutomationRefreshRecording();
    if (recordEnd || !Recordable(request[@"op"])) return;
    if (![result[@"ok"] boolValue]) { RuyiAutomationEndRecording(@"input_failed"); return; }
    // Store caller semantics after native dispatch succeeds. Temporary Cmd+V events are never captured.
    NSMutableDictionary *action = [request mutableCopy];
    [action removeObjectForKey:@"version"]; [action removeObjectForKey:@"target"];
    action[@"at"] = @(MAX(0, began - recordStarted));
    action[@"ended"] = @(MAX(0, NSProcessInfo.processInfo.systemUptime - recordStarted));
    NSUInteger bytes = [NSJSONSerialization dataWithJSONObject:action options:0 error:nil].length;
    if (recordedActions.count >= 100 || recordBytes + bytes > 48000) {
        RuyiAutomationEndRecording(@"capacity"); return;
    }
    [recordedActions addObject:action]; recordBytes += bytes;
}
