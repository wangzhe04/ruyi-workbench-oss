// Per-process listen-only event recording, narrowed to one retained foreground window.
#import "macos-automation.h"
#import <Carbon/Carbon.h>

static CFMachPortRef eventTap;
static CFRunLoopSourceRef tapSource;
static AXUIElementRef recordedWindow;
static NSDictionary *eventTarget;
static NSDictionary *inputSource;
static NSMutableArray *sequence;
static NSTimeInterval sequenceStarted;
static NSTimeInterval sequenceEnded;
static BOOL sequenceBalanced;
static NSString *pointerProfile;

NSDictionary *RuyiAutomationRecordingInputSource(void) {
    TISInputSourceRef source = TISCopyCurrentKeyboardInputSource();
    if (!source) return nil;
    NSString *identifier = (__bridge NSString *)TISGetInputSourceProperty(source, kTISPropertyInputSourceID);
    NSString *type = (__bridge NSString *)TISGetInputSourceProperty(source, kTISPropertyInputSourceType);
    NSDictionary *out = identifier && type ? @{@"id":identifier, @"type":type} : nil;
    CFRelease(source);
    return out;
}

NSDictionary *RuyiAutomationInputSourceGuard(id expected) {
    if (!expected) return nil;
    if (![expected isKindOfClass:NSDictionary.class] || [expected count] != 2
        || ![expected[@"id"] isKindOfClass:NSString.class] || ![expected[@"type"] isKindOfClass:NSString.class]
        || [expected[@"id"] length] == 0 || [expected[@"id"] length] > 512 || [expected[@"type"] length] > 128)
        return RuyiAutomationFailure(@"invalid_args", @"Pass the recorded keyboard input source id and type");
    return [expected isEqual:RuyiAutomationRecordingInputSource()] ? nil
        : RuyiAutomationFailure(@"input_source_changed", @"Keyboard input source differs from the recorded source");
}

NSDictionary *RuyiAutomationKeyboardEventFlags(id value, CGEventFlags *flags) {
    *flags = 0;
    if (!value) return nil;
    CGEventFlags allowed = kCGEventFlagMaskAlphaShift | kCGEventFlagMaskSecondaryFn | kCGEventFlagMaskNumericPad | kCGEventFlagMaskHelp;
    if (!RuyiAutomationFiniteNumber(value) || [value doubleValue] != trunc([value doubleValue])
        || [value doubleValue] < 0 || [value doubleValue] > UINT32_MAX || ([value unsignedLongLongValue] & ~allowed))
        return RuyiAutomationFailure(@"invalid_args", @"Unsupported recorded keyboard event flags");
    *flags = [value unsignedLongLongValue];
    return nil;
}

void RuyiAutomationStopManualRecording(void) {
    if (eventTap) CGEventTapEnable(eventTap, false);
    if (tapSource) {
        CFRunLoopRemoveSource(CFRunLoopGetMain(), tapSource, kCFRunLoopCommonModes);
        CFRelease(tapSource); tapSource = NULL;
    }
    if (eventTap) { CFMachPortInvalidate(eventTap); CFRelease(eventTap); eventTap = NULL; }
    if (recordedWindow) { CFRelease(recordedWindow); recordedWindow = NULL; }
    eventTarget = nil; inputSource = nil; pointerProfile = nil; sequence = nil; sequenceStarted = 0; sequenceEnded = 0; sequenceBalanced = YES;
}

static NSDictionary *WindowRow(void) {
    return @{@"pid":eventTarget[@"pid"], @"handle":eventTarget[@"handle"], @"target":eventTarget};
}

static void FlushSequence(void) {
    if (!sequence.count) return;
    NSDictionary *failure = RuyiAutomationValidateSequenceProfile(sequence, eventTarget[@"bounds"], YES, pointerProfile);
    if (failure) { RuyiAutomationEndRecording(@"incomplete_input_sequence"); return; }
    RuyiAutomationAppendRecordedAction(@{@"op":@"input.sequence", @"events":[sequence copy]}, sequenceStarted, sequenceEnded);
    if (!RuyiAutomationManualRecordingActive()) return;
    sequence = [NSMutableArray array]; sequenceStarted = 0; sequenceEnded = 0; sequenceBalanced = YES;
}

NSString *RuyiAutomationManualRecordingPending(void) {
    if (sequence.count && !sequenceBalanced) return @"incomplete_input_sequence";
    FlushSequence();
    return nil;
}

NSString *RuyiAutomationManualRecordingState(void) {
    if (!eventTap || !CGEventTapIsEnabled(eventTap)) return @"event_tap_disabled";
    if (!CGPreflightListenEventAccess()) return @"listen_permission_denied";
    if (![inputSource isEqual:RuyiAutomationRecordingInputSource()]) return @"input_source_changed";
    if (sequence.count && NSProcessInfo.processInfo.systemUptime - sequenceStarted > 5) {
        if (!sequenceBalanced) return @"input_sequence_capacity";
        FlushSequence();
    }
    return nil;
}

static void Capture(CGEventRef event) {
    if ([pointerProfile isEqual:@"standard_mouse"] && CGEventGetType(event) == kCGEventMouseMoved
        && !CGRectContainsPoint(RuyiAutomationFieldsRect(eventTarget[@"bounds"]), CGEventGetLocation(event))) {
        BOOL held = NO;
        NSMutableSet *buttons = [NSMutableSet set];
        for (NSDictionary *row in sequence) {
            if ([row[@"type"] isEqual:@"mouse_down"]) [buttons addObject:row[@"button"]];
            if ([row[@"type"] isEqual:@"mouse_up"]) [buttons removeObject:row[@"button"]];
        }
        for (CGMouseButton button = 0; button <= 2; button++) held |= CGEventSourceButtonState(kCGEventSourceStateCombinedSessionState, button);
        if (!held && !buttons.count) return; // Unpressed external hover is outside this window's demonstration.
    }
    // Preserve source-event timing. AX checks and callback scheduling must not stretch a gesture.
    NSTimeInterval time = CGEventGetTimestamp(event) / 1000000000.0;
    NSTimeInterval now = NSProcessInfo.processInfo.systemUptime;
    if (time <= 0 || time > now + .1 || now - time > 2 || (sequence.count && time < sequenceEnded)) {
        RuyiAutomationEndRecording(@"event_timestamp_unsupported"); return;
    }
    if (sequence.count && sequenceBalanced && (time - sequenceEnded > .3 || time - sequenceStarted > 4.5)) FlushSequence();
    if (!RuyiAutomationManualRecordingActive()) return;
    if (!sequence.count) sequenceStarted = time;
    if (time - sequenceStarted > 5 || sequence.count >= 512) {
        RuyiAutomationEndRecording(@"input_sequence_capacity"); return;
    }
    NSDictionary *failure = nil;
    NSDictionary *row = RuyiAutomationSequenceEventProfile(event, (uint64_t)llround((time - sequenceStarted) * 1000000), &failure, pointerProfile);
    if (!row) { RuyiAutomationEndRecording(failure[@"code"] ?: @"event_unsupported"); return; }
    if (row[@"x"]) {
        failure = RuyiAutomationPointGuard(WindowRow(), recordedWindow, CGPointMake([row[@"x"] doubleValue], [row[@"y"] doubleValue]));
        if (failure) { RuyiAutomationEndRecording(failure[@"code"] ?: @"target_hit_unconfirmed"); return; }
    }
    [sequence addObject:row]; sequenceEnded = time;
    failure = RuyiAutomationValidateSequenceProfile(sequence, eventTarget[@"bounds"], NO, pointerProfile);
    if (failure) { RuyiAutomationEndRecording(@"event_sequence_unsupported"); return; }
    sequenceBalanced = !RuyiAutomationValidateSequenceProfile(sequence, eventTarget[@"bounds"], YES, pointerProfile);
}

static CGEventRef Observe(CGEventTapProxy proxy, CGEventType type, CGEventRef event, void *context) {
    (void)proxy; (void)context;
    @autoreleasepool {
        if (type == kCGEventTapDisabledByTimeout || type == kCGEventTapDisabledByUserInput || !event) {
            RuyiAutomationEndRecording(@"event_tap_disabled"); return event;
        }
        if (!RuyiAutomationManualRecordingActive()) return event;
        RuyiAutomationRefreshRecording();
        if (!RuyiAutomationManualRecordingActive()) return event;
        if (CGEventGetIntegerValueField(event, kCGEventTargetUnixProcessID) != [eventTarget[@"pid"] intValue]) {
            RuyiAutomationEndRecording(@"event_target_changed"); return event;
        }
        if (!RuyiAutomationForegroundMatches(WindowRow(), recordedWindow)) {
            RuyiAutomationEndRecording(@"focus_changed"); return event;
        }
        Capture(event);
    }
    return event;
}

NSDictionary *RuyiAutomationStartManualRecording(NSDictionary *target) {
    return RuyiAutomationStartManualRecordingProfile(target, @"exact");
}

NSDictionary *RuyiAutomationStartManualRecordingProfile(NSDictionary *target, NSString *profile) {
    if (![@[@"exact", @"standard_mouse"] containsObject:profile]) return RuyiAutomationFailure(@"invalid_args", @"Choose a supported pointer profile");
    if (!CGPreflightListenEventAccess()) return RuyiAutomationFailure(@"listen_permission_denied", @"Enable Input Monitoring for the responsible application");
    NSDictionary *row = RuyiAutomationCheckTarget(target);
    if (row[@"error"]) return row;
    NSDictionary *failure = nil;
    recordedWindow = RuyiAutomationCopyTargetWindow(row, &failure);
    if (!recordedWindow) return failure;
    eventTarget = [target copy]; inputSource = RuyiAutomationRecordingInputSource(); pointerProfile = profile;
    if (!inputSource) { RuyiAutomationStopManualRecording(); return RuyiAutomationFailure(@"input_source_unknown", @"Cannot identify the current keyboard input source"); }
    sequence = [NSMutableArray array]; sequenceBalanced = YES;
    CGEventFlags lastFlags = CGEventSourceFlagsState(kCGEventSourceStateHIDSystemState);
    if (lastFlags & (kCGEventFlagMaskCommand | kCGEventFlagMaskControl | kCGEventFlagMaskAlternate | kCGEventFlagMaskShift | kCGEventFlagMaskSecondaryFn)) {
        RuyiAutomationStopManualRecording(); return RuyiAutomationFailure(@"physical_input_busy", @"Release modifier keys before recording");
    }
    for (CGKeyCode key = 0; key < 128; key++) {
        if (CGEventSourceKeyState(kCGEventSourceStateHIDSystemState, key)) {
            RuyiAutomationStopManualRecording(); return RuyiAutomationFailure(@"physical_input_busy", @"Release keyboard keys before recording");
        }
    }
    for (CGMouseButton button = 0; button <= 2; button++) {
        if (CGEventSourceButtonState(kCGEventSourceStateHIDSystemState, button)) {
            RuyiAutomationStopManualRecording(); return RuyiAutomationFailure(@"physical_input_busy", @"Release pointer buttons before recording");
        }
    }
    CGEventMask mask = CGEventMaskBit(kCGEventTabletPointer) | CGEventMaskBit(kCGEventTabletProximity) | CGEventMaskBit(kCGEventMouseMoved) | CGEventMaskBit(kCGEventKeyDown) | CGEventMaskBit(kCGEventKeyUp) | CGEventMaskBit(kCGEventFlagsChanged)
        | CGEventMaskBit(kCGEventLeftMouseDown) | CGEventMaskBit(kCGEventLeftMouseUp)
        | CGEventMaskBit(kCGEventRightMouseDown) | CGEventMaskBit(kCGEventRightMouseUp)
        | CGEventMaskBit(kCGEventOtherMouseDown) | CGEventMaskBit(kCGEventOtherMouseUp)
        | CGEventMaskBit(kCGEventLeftMouseDragged) | CGEventMaskBit(kCGEventRightMouseDragged)
        | CGEventMaskBit(kCGEventOtherMouseDragged) | CGEventMaskBit(kCGEventScrollWheel);
    eventTap = CGEventTapCreateForPid([target[@"pid"] intValue], kCGTailAppendEventTap, kCGEventTapOptionListenOnly, mask, Observe, NULL);
    tapSource = eventTap ? CFMachPortCreateRunLoopSource(NULL, eventTap, 0) : NULL;
    if (!tapSource) { RuyiAutomationStopManualRecording(); return RuyiAutomationFailure(@"event_tap_unavailable", @"Cannot install the target-process event listener"); }
    CFRunLoopAddSource(CFRunLoopGetMain(), tapSource, kCFRunLoopCommonModes);
    return @{@"ok":@YES, @"input_source":inputSource};
}
