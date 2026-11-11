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
static NSString *recordSource;
static NSDictionary *recordInputSource;

BOOL RuyiAutomationManualRecordingActive(void) {
    return recordedActions && !recordEnd && [recordSource isEqual:@"native_window_events"];
}

NSDictionary *RuyiAutomationRecordStatus(void) {
    BOOL ready = AXIsProcessTrusted() && CGPreflightPostEventAccess() && !RuyiAutomationLocked() && !IsSecureEventInputEnabled();
    return @{@"inputSequenceSupported":@YES, @"inputSequenceReady":@(ready), @"recordSupported":@YES, @"recordReady":@(ready), @"recordSource":@"controlled_native_requests",
        @"recordSources":@[@"controlled_native_requests", @"native_window_events"], @"manualRecordSupported":@YES,
        @"manualRecordReady":ready && CGPreflightListenEventAccess() ? @YES : @NO,
        @"listenAuthorization":CGPreflightListenEventAccess() ? @"granted" : @"denied",
        @"recordInputSource":RuyiAutomationRecordingInputSource() ?: @{}};
}

void RuyiAutomationEndRecording(NSString *reason) {
    if (recordedActions && !recordEnd) {
        recordEnd = reason;
        RuyiAutomationStopManualRecording();
    }
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
    if (RuyiAutomationManualRecordingActive()) {
        NSString *reason = RuyiAutomationManualRecordingState();
        if (reason) { RuyiAutomationEndRecording(reason); return; }
    }
    if (NSProcessInfo.processInfo.systemUptime >= recordDeadline) {
        RuyiAutomationEndRecording(@"deadline"); return;
    }
    NSDictionary *current = RecordingTarget(recordedTarget);
    if (![current[@"ok"] boolValue]) RuyiAutomationEndRecording(current[@"code"] ?: @"target_changed");
    else if (![current[@"application"] isEqual:recordedApplication]) RuyiAutomationEndRecording(@"application_changed");
}

static NSDictionary *PreflightRecording(NSDictionary *request) {
    NSDictionary *sourceFailure = RuyiAutomationInputSourceGuard(request[@"input_source"]);
    if (sourceFailure) return sourceFailure;
    NSArray *actions = request[@"actions"] ?: @[];
    if (![actions isKindOfClass:NSArray.class] || actions.count > 100)
        return RuyiAutomationFailure(@"invalid_args", @"Pass at most 100 recorded actions");
    for (NSDictionary *action in actions) {
        if (![action isKindOfClass:NSDictionary.class]) return RuyiAutomationFailure(@"invalid_args", @"Invalid recorded action");
        NSDictionary *failure = nil;
        failure = RuyiAutomationInputSourceGuard(action[@"input_source"]);
        if (failure) return failure;
        if ([action[@"op"] isEqual:@"keyboard.chord"] && !RuyiAutomationChordKeys(action[@"keys"], &failure)) return failure;
        if ([action[@"op"] isEqual:@"keyboard.chord"]) {
            CGEventFlags flags;
            failure = RuyiAutomationKeyboardEventFlags(action[@"event_flags"], &flags);
            if (failure) return failure;
        }
        if ([action[@"op"] isEqual:@"input.sequence"]) {
            failure = RuyiAutomationValidateSequence(action[@"events"], nil, YES);
            if (failure) return failure;
        }
        if ([action[@"op"] isEqual:@"keyboard.text"]) {
            failure = RuyiAutomationValidateText(action);
            if (failure) return failure;
        }
    }
    NSDictionary *current = RecordingTarget(request[@"target"]);
    if (![current[@"ok"] boolValue]) return current;
    NSDictionary *oldBounds = request[@"sequence_bounds"] ?: current[@"target"][@"bounds"];
    if (![oldBounds isKindOfClass:NSDictionary.class] || ![[NSSet setWithArray:oldBounds.allKeys]
            isEqual:[NSSet setWithArray:@[@"x", @"y", @"width", @"height"]]])
        return RuyiAutomationFailure(@"invalid_args", @"Pass the original sequence bounds");
    for (NSString *key in oldBounds) if (!RuyiAutomationFiniteNumber(oldBounds[key]))
        return RuyiAutomationFailure(@"invalid_args", @"Sequence bounds must be finite");
    NSDictionary *newBounds = current[@"target"][@"bounds"];
    if (![oldBounds[@"width"] isEqual:newBounds[@"width"]] || ![oldBounds[@"height"] isEqual:newBounds[@"height"]])
        return RuyiAutomationFailure(@"window_changed", @"Replay requires the recorded window size");
    NSDictionary *row = RuyiAutomationCheckTarget(current[@"target"]), *failure = nil;
    if (row[@"error"]) return row;
    AXUIElementRef window = RuyiAutomationCopyTargetWindow(row, &failure);
    if (!window) return failure;
    NSTimeInterval deadline = NSProcessInfo.processInfo.systemUptime + 5;
    @try {
        for (NSDictionary *action in actions) {
            if (![action[@"op"] isEqual:@"input.sequence"]) continue;
            failure = RuyiAutomationValidateSequence(action[@"events"], oldBounds, YES);
            if (failure) return failure;
            if (!action[@"input_source"] && !request[@"input_source"])
                return RuyiAutomationFailure(@"invalid_args", @"Bind all input sequences to their keyboard source");
            for (NSDictionary *event in action[@"events"]) {
                if (NSProcessInfo.processInfo.systemUptime >= deadline)
                    return RuyiAutomationFailure(@"input_timeout", @"Recording preflight reached its bounded deadline");
                if (!event[@"x"]) continue;
                CGPoint point = CGPointMake([event[@"x"] doubleValue] + [newBounds[@"x"] doubleValue] - [oldBounds[@"x"] doubleValue],
                    [event[@"y"] doubleValue] + [newBounds[@"y"] doubleValue] - [oldBounds[@"y"] doubleValue]);
                failure = RuyiAutomationPointGuard(row, window, point);
                if (failure) return failure;
            }
        }
    } @finally { CFRelease(window); }
    sourceFailure = RuyiAutomationInputSourceGuard(request[@"input_source"]);
    return sourceFailure ?: RecordingTarget(request[@"target"]);
}

NSDictionary *RuyiAutomationRecordRequest(NSDictionary *request) {
    NSString *op = request[@"op"];
    NSSet *allowed = [NSSet setWithArray:[op isEqual:@"record.start"]
        ? @[@"op", @"version", @"target", @"max_seconds", @"source"] : [op isEqual:@"record.target"]
        ? @[@"op", @"version", @"target", @"actions", @"input_source", @"sequence_bounds"] : @[@"op", @"version"]];
    for (NSString *key in request)
        if (![allowed containsObject:key]) return RuyiAutomationFailure(@"invalid_args", @"Unexpected recording field");
    if ([op isEqual:@"record.target"]) return PreflightRecording(request);
    if ([op isEqual:@"record.start"]) {
        if (recordedActions) return RuyiAutomationFailure(@"recording_exists", @"Stop and collect the previous recording first");
        id seconds = request[@"max_seconds"];
        if (!RuyiAutomationFiniteNumber(seconds) || [seconds doubleValue] < 1 || [seconds doubleValue] > 300)
            return RuyiAutomationFailure(@"invalid_args", @"max_seconds must be a finite number from 1 to 300");
        NSString *source = request[@"source"] ?: @"controlled_native_requests";
        if (![@[@"controlled_native_requests", @"native_window_events"] containsObject:source])
            return RuyiAutomationFailure(@"invalid_args", @"Choose controlled_native_requests or native_window_events");
        NSDictionary *current = RecordingTarget(request[@"target"]);
        if (![current[@"ok"] boolValue]) return current;
        recordedTarget = [current[@"target"] copy]; recordedApplication = current[@"application"];
        recordedActions = [NSMutableArray array]; recordEnd = nil; recordBytes = 0;
        recordSource = source; recordInputSource = nil;
        recordStarted = NSProcessInfo.processInfo.systemUptime;
        recordDeadline = recordStarted + [seconds doubleValue];
        if ([source isEqual:@"native_window_events"]) {
            NSDictionary *installed = RuyiAutomationStartManualRecording(recordedTarget);
            if (![installed[@"ok"] boolValue]) {
                recordedActions = nil; recordedTarget = nil; recordedApplication = nil; recordSource = nil;
                return installed;
            }
            recordInputSource = installed[@"input_source"];
        }
        return @{@"ok":@YES, @"protocolVersion":@1, @"recording":@YES,
            @"source":source, @"max_seconds":seconds};
    }
    if ([op isEqual:@"record.stop"]) {
        if (!recordedActions) return RuyiAutomationFailure(@"recording_absent", @"No recording to collect");
        RuyiAutomationRefreshRecording();
        BOOL manual = [recordSource isEqual:@"native_window_events"];
        if (manual && !recordEnd) {
            NSString *pending = RuyiAutomationManualRecordingPending();
            if (pending) RuyiAutomationEndRecording(pending);
        }
        RuyiAutomationStopManualRecording();
        NSMutableDictionary *recording = [@{@"schema":manual ? @2 : @1, @"platform":@"darwin", @"coordinate_space":@"macos_global_points",
            @"source":recordSource, @"application":recordedApplication,
            @"bounds":recordedTarget[@"bounds"], @"complete":recordEnd ? @NO : @YES,
            @"end_reason":recordEnd ?: @"stopped", @"actions":[recordedActions copy]} mutableCopy];
        if (manual) recording[@"input_source"] = recordInputSource;
        recordedActions = nil; recordedTarget = nil; recordedApplication = nil; recordEnd = nil;
        recordSource = nil; recordInputSource = nil;
        return @{@"ok":@YES, @"protocolVersion":@1, @"recording":recording};
    }
    return RuyiAutomationFailure(@"invalid_args", @"Unsupported recording operation");
}

static BOOL Recordable(NSString *op) {
    return [@[@"input.sequence", @"keyboard.text", @"keyboard.chord", @"mouse.click", @"mouse.move", @"mouse.drag", @"mouse.scroll"] containsObject:op];
}

void RuyiAutomationBeforeRecordedRequest(NSDictionary *request) {
    RuyiAutomationRefreshRecording();
    if (RuyiAutomationManualRecordingActive() && Recordable(request[@"op"])) {
        RuyiAutomationEndRecording(@"mixed_automation"); return;
    }
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
    RuyiAutomationAppendRecordedAction(action, began, NSProcessInfo.processInfo.systemUptime);
}

void RuyiAutomationAppendRecordedAction(NSDictionary *value, NSTimeInterval began, NSTimeInterval ended) {
    if (!recordedActions || recordEnd) return;
    NSMutableDictionary *action = [value mutableCopy];
    action[@"at"] = @(MAX(0, began - recordStarted));
    action[@"ended"] = @(MAX(0, ended - recordStarted));
    NSUInteger bytes = [NSJSONSerialization dataWithJSONObject:action options:0 error:nil].length;
    if (recordedActions.count >= 100 || recordBytes + bytes > 48000) {
        RuyiAutomationEndRecording(@"capacity"); return;
    }
    [recordedActions addObject:action];
    recordBytes += bytes;
}
