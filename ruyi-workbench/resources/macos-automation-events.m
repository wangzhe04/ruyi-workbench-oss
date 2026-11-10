// Atomic, target-bound input sequences. No held key or button survives a request.
#import "macos-automation.h"
#include <pthread.h>

static pthread_mutex_t eventLock = PTHREAD_MUTEX_INITIALIZER;
static CGEventSourceRef source;
static NSMutableSet<NSNumber *> *heldKeys;
static NSMutableSet<NSNumber *> *heldButtons;
static CGPoint lastPoint;
static BOOL stopping;
static pid_t keyboardPID;
static NSArray *pendingClipboard;
static NSInteger pendingClipboardVersion;
static NSString *clipboardRestoreState = @"none";
static BOOL clipboardWriteActive;
static CGPoint Pointer(void);

BOOL RuyiAutomationEventsStopping(void) {
    pthread_mutex_lock(&eventLock);
    BOOL value = stopping;
    pthread_mutex_unlock(&eventLock);
    return value;
}

BOOL RuyiAutomationTrackClipboard(NSArray *previous, NSInteger expected) {
    pthread_mutex_lock(&eventLock);
    if (stopping) {
        pthread_mutex_unlock(&eventLock);
        return NO;
    }
    pendingClipboard = previous;
    pendingClipboardVersion = expected;
    clipboardRestoreState = @"pending";
    clipboardWriteActive = YES;
    pthread_mutex_unlock(&eventLock);
    return YES;
}

void RuyiAutomationUpdateClipboardVersion(NSInteger expected) {
    pthread_mutex_lock(&eventLock);
    pendingClipboardVersion = expected;
    pthread_mutex_unlock(&eventLock);
}

void RuyiAutomationFinishClipboardWrite(void) {
    pthread_mutex_lock(&eventLock);
    clipboardWriteActive = NO;
    pthread_mutex_unlock(&eventLock);
}

NSString *RuyiAutomationRestorePendingClipboard(void) {
    pthread_mutex_lock(&eventLock);
    if (clipboardWriteActive) {
        pthread_mutex_unlock(&eventLock);
        return @"pending";
    }
    NSArray *saved = pendingClipboard;
    NSInteger version = pendingClipboardVersion;
    pendingClipboard = nil;
    NSString *state = clipboardRestoreState;
    pthread_mutex_unlock(&eventLock);
    if (saved) {
        state = RuyiAutomationRestoreClipboard(NSPasteboard.generalPasteboard, saved, version);
        pthread_mutex_lock(&eventLock);
        clipboardRestoreState = state;
        pthread_mutex_unlock(&eventLock);
    }
    return state;
}

static CGEventType ButtonEvent(CGMouseButton button, BOOL down) {
    if (button == kCGMouseButtonLeft)
        return down ? kCGEventLeftMouseDown : kCGEventLeftMouseUp;
    if (button == kCGMouseButtonRight)
        return down ? kCGEventRightMouseDown : kCGEventRightMouseUp;
    return down ? kCGEventOtherMouseDown : kCGEventOtherMouseUp;
}

void RuyiAutomationReleaseEvents(void) {
    @autoreleasepool {
        pthread_mutex_lock(&eventLock);
        for (NSNumber *key in heldKeys) {
            CGEventRef event = CGEventCreateKeyboardEvent(source, key.unsignedShortValue, false);
            if (event) {
                CGEventSetFlags(event, 0);
                CGEventPostToPid(keyboardPID, event);
                CFRelease(event);
            }
        }
        CGPoint current = Pointer();
        CGPoint releasePoint = isfinite(current.x) && isfinite(current.y) ? current : lastPoint;
        for (NSNumber *button in heldButtons) {
            CGEventRef event = CGEventCreateMouseEvent(
                source, ButtonEvent(button.unsignedIntValue, NO), releasePoint, button.unsignedIntValue);
            if (event) {
                CGEventPost(kCGHIDEventTap, event);
                CFRelease(event);
            }
        }
        [heldKeys removeAllObjects];
        [heldButtons removeAllObjects];
        pthread_mutex_unlock(&eventLock);
    }
}

void RuyiAutomationStopEvents(void) {
    pthread_mutex_lock(&eventLock);
    stopping = YES;
    pthread_mutex_unlock(&eventLock);
    RuyiAutomationReleaseEvents();
}

static BOOL PostKey(CGKeyCode key, BOOL down, CGEventFlags flags, NSString *text) {
    pthread_mutex_lock(&eventLock);
    if (!source)
        source = CGEventSourceCreate(kCGEventSourceStatePrivate);
    CGEventRef event = source && !stopping ? CGEventCreateKeyboardEvent(source, key, down) : NULL;
    if (event) {
        CGEventSetFlags(event, flags);
        if (text) {
            UniChar units[20];
            [text getCharacters:units range:NSMakeRange(0, text.length)];
            CGEventKeyboardSetUnicodeString(event, text.length, units);
        }
        if (!heldKeys)
            heldKeys = [NSMutableSet set];
        if (down)
            [heldKeys addObject:@(key)];
        else
            [heldKeys removeObject:@(key)];
        CGEventPostToPid(keyboardPID, event);
        CFRelease(event);
    }
    pthread_mutex_unlock(&eventLock);
    return event != NULL;
}

static BOOL PostMouse(CGEventType type, CGPoint point, CGMouseButton button, NSInteger click) {
    pthread_mutex_lock(&eventLock);
    if (!source)
        source = CGEventSourceCreate(kCGEventSourceStatePrivate);
    CGEventRef event = source && !stopping ? CGEventCreateMouseEvent(source, type, point, button) : NULL;
    if (event) {
        CGEventSetFlags(event, 0);
        CGEventSetIntegerValueField(event, kCGMouseEventClickState, click);
        if (!heldButtons)
            heldButtons = [NSMutableSet set];
        if (type == ButtonEvent(button, YES))
            [heldButtons addObject:@(button)];
        if (type == ButtonEvent(button, NO))
            [heldButtons removeObject:@(button)];
        lastPoint = point;
        CGEventPost(kCGHIDEventTap, event);
        CFRelease(event);
    }
    pthread_mutex_unlock(&eventLock);
    return event != NULL;
}

static CGPoint Pointer(void) {
    CGEventRef event = CGEventCreate(NULL);
    CGPoint point = event ? CGEventGetLocation(event) : CGPointMake(NAN, NAN);
    if (event)
        CFRelease(event);
    return point;
}

static BOOL AtPoint(CGPoint actual, CGPoint expected) {
    return isfinite(actual.x) && isfinite(actual.y) && fabs(actual.x - expected.x) <= 2 && fabs(actual.y - expected.y) <= 2;
}

static NSDictionary *InputFailure(NSDictionary *failure, BOOL acted) {
    NSMutableDictionary *out = [failure mutableCopy];
    out[@"acted"] = @(acted);
    out[@"action_sent"] = @(acted);
    if (acted)
        out[@"outcome"] = @"unconfirmed";
    return out;
}

static NSDictionary *FocusGuard(NSDictionary *row, AXUIElementRef window, NSTimeInterval deadline) {
    if (RuyiAutomationEventsStopping())
        return RuyiAutomationFailure(@"input_cancelled", @"Native input session is stopping");
    if (NSProcessInfo.processInfo.systemUptime >= deadline)
        return RuyiAutomationFailure(@"input_timeout", @"Input sequence reached its bounded deadline");
    if (RuyiAutomationLocked())
        return RuyiAutomationFailure(@"session_locked", @"Unlock the desktop before sending input");
    if (!AXIsProcessTrusted() || !CGPreflightPostEventAccess())
        return RuyiAutomationFailure(@"permission_denied",
                                     @"Enable Accessibility and event posting for the responsible application");
    NSDictionary *current = RuyiAutomationCheckTarget(row[@"target"]);
    if (current[@"error"])
        return current;
    NSDictionary *failure = nil;
    AXUIElementRef member = RuyiAutomationCopyTargetWindow(current, &failure);
    BOOL same = member && CFEqual(member, window);
    if (member)
        CFRelease(member);
    if (!same)
        return failure ?: RuyiAutomationFailure(@"target_stale", @"The retained window is no longer current");
    if (!RuyiAutomationForegroundMatches(current, window))
        return RuyiAutomationFailure(@"focus_changed", @"Focus the observed target window before sending input");
    return nil;
}

NSDictionary *RuyiAutomationPointGuard(NSDictionary *row, AXUIElementRef window, CGPoint point) {
    if (!isfinite(point.x) || !isfinite(point.y) ||
        !CGRectContainsPoint(RuyiAutomationFieldsRect(row[@"target"][@"bounds"]), point))
        return RuyiAutomationFailure(@"point_outside_target", @"Mouse coordinates must lie inside the bound window");
    BOOL displayed = NO;
    for (NSDictionary *display in RuyiAutomationDisplays())
        if (CGRectContainsPoint(RuyiAutomationFieldsRect(display), point))
            displayed = YES;
    if (!displayed)
        return RuyiAutomationFailure(@"point_outside_desktop", @"Mouse coordinates must lie on an active display");
    // AppKit asks WindowServer which window would actually receive mouseDown,
    // including floating panels and noninteractive transparent system overlays.
    NSPoint screenPoint = NSMakePoint(point.x, CGDisplayBounds(CGMainDisplayID()).size.height - point.y);
    NSInteger hitWindow = [NSWindow windowNumberAtPoint:screenPoint belowWindowWithWindowNumber:0];
    if (hitWindow != [row[@"handle"] integerValue])
        return RuyiAutomationFailure(@"target_occluded",
                                     [NSString stringWithFormat:@"Mouse point would hit window %ld, expected %@",
                                                                (long)hitWindow,
                                                                row[@"handle"]]);
    AXUIElementRef system = AXUIElementCreateSystemWide();
    AXUIElementSetMessagingTimeout(system, 0.15);
    AXUIElementRef hit = NULL;
    AXError status = AXUIElementCopyElementAtPosition(system, point.x, point.y, &hit);
    CFRelease(system);
    pid_t pid = 0;
    if (hit) {
        AXUIElementSetMessagingTimeout(hit, 0.15);
        AXUIElementGetPid(hit, &pid);
    }
    CFTypeRef owner = hit ? RuyiAutomationCopyAttribute(hit, kAXWindowAttribute) : NULL;
    BOOL matches =
        status == kAXErrorSuccess && hit && pid == [row[@"pid"] intValue] &&
        (CFEqual(hit, window) || (owner && CFGetTypeID(owner) == AXUIElementGetTypeID() && CFEqual(owner, window)));
    if (owner)
        CFRelease(owner);
    if (hit)
        CFRelease(hit);
    return matches ? nil
                   : RuyiAutomationFailure(@"target_hit_unconfirmed",
                                           @"Accessibility hit testing did not confirm the bound window");
}

static NSDictionary *KeyMap(void) {
    return @{
        @"a" : @0,
        @"s" : @1,
        @"d" : @2,
        @"f" : @3,
        @"h" : @4,
        @"g" : @5,
        @"z" : @6,
        @"x" : @7,
        @"c" : @8,
        @"v" : @9,
        @"b" : @11,
        @"q" : @12,
        @"w" : @13,
        @"e" : @14,
        @"r" : @15,
        @"y" : @16,
        @"t" : @17,
        @"1" : @18,
        @"2" : @19,
        @"3" : @20,
        @"4" : @21,
        @"6" : @22,
        @"5" : @23,
        @"=" : @24,
        @"9" : @25,
        @"7" : @26,
        @"-" : @27,
        @"8" : @28,
        @"0" : @29,
        @"]" : @30,
        @"o" : @31,
        @"u" : @32,
        @"[" : @33,
        @"i" : @34,
        @"p" : @35,
        @"enter" : @36,
        @"return" : @36,
        @"l" : @37,
        @"j" : @38,
        @"'" : @39,
        @"k" : @40,
        @";" : @41,
        @"\\" : @42,
        @"," : @43,
        @"/" : @44,
        @"n" : @45,
        @"m" : @46,
        @"." : @47,
        @"tab" : @48,
        @"space" : @49,
        @"`" : @50,
        @"backspace" : @51,
        @"escape" : @53,
        @"esc" : @53,
        @"cmd" : @55,
        @"command" : @55,
        @"shift" : @56,
        @"capslock" : @57,
        @"alt" : @58,
        @"option" : @58,
        @"ctrl" : @59,
        @"control" : @59,
        @"f1" : @122,
        @"f2" : @120,
        @"f3" : @99,
        @"f4" : @118,
        @"f5" : @96,
        @"f6" : @97,
        @"f7" : @98,
        @"f8" : @100,
        @"f9" : @101,
        @"f10" : @109,
        @"f11" : @103,
        @"f12" : @111,
        @"home" : @115,
        @"pageup" : @116,
        @"delete" : @117,
        @"end" : @119,
        @"pagedown" : @121,
        @"left" : @123,
        @"right" : @124,
        @"down" : @125,
        @"up" : @126
    };
}

static CGEventFlags Modifier(CGKeyCode key) {
    switch (key) {
    case 55:
        return kCGEventFlagMaskCommand;
    case 56:
        return kCGEventFlagMaskShift;
    case 58:
        return kCGEventFlagMaskAlternate;
    case 59:
        return kCGEventFlagMaskControl;
    default:
        return 0;
    }
}

static BOOL Chord(NSArray<NSNumber *> *keys) {
    CGEventFlags flags = 0;
    for (NSNumber *key in keys) {
        flags |= Modifier(key.unsignedShortValue);
        if (!PostKey(key.unsignedShortValue, YES, flags, nil)) {
            RuyiAutomationReleaseEvents();
            return NO;
        }
    }
    for (NSNumber *key in keys.reverseObjectEnumerator) {
        flags &= ~Modifier(key.unsignedShortValue);
        if (!PostKey(key.unsignedShortValue, NO, flags, nil)) {
            RuyiAutomationReleaseEvents();
            return NO;
        }
    }
    return YES;
}

static void Wait(NSTimeInterval seconds) {
    [NSRunLoop.currentRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:seconds]];
}

static NSDictionary *Keyboard(NSDictionary *request, NSDictionary *row, AXUIElementRef window) {
    pthread_mutex_lock(&eventLock);
    keyboardPID = [row[@"pid"] intValue];
    pthread_mutex_unlock(&eventLock);
    NSTimeInterval deadline = NSProcessInfo.processInfo.systemUptime + 8;
    NSString *op = request[@"op"];
    if ([op isEqual:@"keyboard.chord"]) {
        NSArray *parts = request[@"keys"];
        if (![parts isKindOfClass:NSArray.class] || parts.count < 1 || parts.count > 8)
            return RuyiAutomationFailure(@"invalid_args", @"Pass one to eight Mac key names");
        NSMutableArray *keys = [NSMutableArray array];
        for (id part in parts) {
            NSNumber *key = [part isKindOfClass:NSString.class] ? KeyMap()[[part lowercaseString]] : nil;
            if (!key || [keys containsObject:key])
                return RuyiAutomationFailure(@"invalid_args", @"Unknown or repeated Mac key name");
            if (keys.count && !Modifier([keys.lastObject unsignedShortValue]))
                return RuyiAutomationFailure(@"invalid_args",
                                             @"A chord may contain modifiers followed by one ordinary key");
            [keys addObject:key];
        }
        NSDictionary *failure = FocusGuard(row, window, deadline);
        if (failure)
            return failure;
        BOOL sent = Chord(keys);
        return sent ? @{
            @"ok" : @YES,
            @"protocolVersion" : @1,
            @"acted" : @YES,
            @"action_sent" : @YES,
            @"verification" : @"events_posted"
        }
                    : InputFailure(RuyiAutomationFailure(@"input_failed", @"Cannot create the keyboard event sequence"),
                                   YES);
    }
    if (![op isEqual:@"keyboard.text"])
        return RuyiAutomationFailure(@"invalid_args", @"Unsupported keyboard operation");
    NSString *text = request[@"text"];
    NSNumber *paste = request[@"paste"], *interval = request[@"interval"], *enters = request[@"enters"];
    if (![text isKindOfClass:NSString.class] || [text lengthOfBytesUsingEncoding:NSUTF8StringEncoding] > 48000 ||
        ![paste isKindOfClass:NSNumber.class] || CFGetTypeID((__bridge CFTypeRef)paste) != CFBooleanGetTypeID() ||
        !RuyiAutomationFiniteNumber(interval) || interval.doubleValue < 0 || interval.doubleValue > 0.2 ||
        !RuyiAutomationFiniteNumber(enters) || enters.doubleValue != trunc(enters.doubleValue) || enters.intValue < 0 ||
        enters.intValue > 20 || (!paste.boolValue && text.length * MAX(interval.doubleValue, 0.001) > 5))
        return RuyiAutomationFailure(@"invalid_args",
                                     @"Text, interval or trailing Enter count exceeds the input limits");
    BOOL acted = NO;
    NSDictionary *failure = FocusGuard(row, window, deadline);
    if (failure)
        return failure;
    NSArray *saved = nil;
    NSString *restore = @"none";
    @try {
        if (paste.boolValue) {
            NSDictionary *written = RuyiAutomationWriteClipboard(NSPasteboard.generalPasteboard, @[ text ], &saved);
            if (![written[@"ok"] boolValue])
                return written;
            acted = YES;
            failure = FocusGuard(row, window, deadline);
            if (!failure && !Chord(@[ @55, @9 ]))
                failure = RuyiAutomationFailure(@"input_failed", @"Cannot create Cmd+V events");
            if (!failure)
                Wait(MIN(2, 0.4 + text.length / 20000.0));
        } else {
            for (NSUInteger i = 0; i < text.length;) {
                failure = FocusGuard(row, window, deadline);
                if (failure)
                    break;
                NSRange range = [text rangeOfComposedCharacterSequenceAtIndex:i];
                if (range.length > 20) {
                    failure = RuyiAutomationFailure(@"invalid_args",
                                                    @"A composed character exceeds the Unicode event capacity");
                    break;
                }
                NSString *unit = [text substringWithRange:range];
                BOOL sent;
                if ([unit isEqual:@"\n"] || [unit isEqual:@"\r"] || [unit isEqual:@"\r\n"])
                    sent = Chord(@[ @36 ]);
                else if ([unit isEqual:@"\t"])
                    sent = Chord(@[ @48 ]);
                else
                    sent = PostKey(0, YES, 0, unit) && PostKey(0, NO, 0, unit);
                acted = YES;
                if (!sent) {
                    failure = RuyiAutomationFailure(@"input_failed", @"Cannot create Unicode keyboard events");
                    break;
                }
                i = NSMaxRange(range);
                Wait(interval.doubleValue);
            }
        }
        for (int i = 0; !failure && i < enters.intValue; i++) {
            failure = FocusGuard(row, window, deadline);
            if (!failure) {
                acted = YES;
                if (!Chord(@[ @36 ]))
                    failure = RuyiAutomationFailure(@"input_failed", @"Cannot create Enter events");
            }
        }
        if (!failure)
            failure = FocusGuard(row, window, deadline);
    } @finally {
        RuyiAutomationReleaseEvents();
        if (paste.boolValue)
            restore = RuyiAutomationRestorePendingClipboard();
    }
    if ([restore isEqual:@"pending"] || [restore isEqual:@"failed"]) {
        failure = failure
                      ?: RuyiAutomationFailure(@"clipboard_restore_unconfirmed",
                                               @"Input was sent but clipboard restoration is unconfirmed");
        if ([restore isEqual:@"pending"])
            restore = @"unconfirmed";
    }
    NSMutableDictionary *out = [failure ? InputFailure(failure, acted) : @{
        @"ok" : @YES,
        @"protocolVersion" : @1,
        @"acted" : @(acted),
        @"action_sent" : @(acted),
        @"verification" : @"events_posted"
    } mutableCopy];
    out[@"restore"] = restore;
    out[@"change_count"] = @(NSPasteboard.generalPasteboard.changeCount);
    return out;
}

static NSDictionary *Mouse(NSDictionary *request, NSDictionary *row, AXUIElementRef window) {
    NSString *op = request[@"op"], *buttonName = request[@"button"] ?: @"left";
    NSDictionary *buttons =
        @{@"left" : @(kCGMouseButtonLeft),
          @"right" : @(kCGMouseButtonRight),
          @"middle" : @(kCGMouseButtonCenter)};
    if (![buttonName isKindOfClass:NSString.class] || !buttons[buttonName])
        return RuyiAutomationFailure(@"invalid_args", @"Unknown mouse button");
    CGMouseButton button = [buttons[buttonName] unsignedIntValue];
    CGPoint start = Pointer();
    if (!RuyiAutomationFiniteNumber(request[@"x"]) || !RuyiAutomationFiniteNumber(request[@"y"]))
        return RuyiAutomationFailure(@"invalid_args", @"Mouse coordinates must be finite logical points");
    CGPoint point = CGPointMake([request[@"x"] doubleValue], [request[@"y"] doubleValue]);
    BOOL drag = [op isEqual:@"mouse.drag"], move = [op isEqual:@"mouse.move"];
    if (move && (!isfinite(start.x) || !isfinite(start.y)))
        return RuyiAutomationFailure(@"pointer_unavailable", @"Cannot observe the start position for pointer movement");
    if (drag) {
        if (!RuyiAutomationFiniteNumber(request[@"start_x"]) || !RuyiAutomationFiniteNumber(request[@"start_y"]))
            return RuyiAutomationFailure(@"invalid_args", @"Drag start must be finite logical points");
        start = CGPointMake([request[@"start_x"] doubleValue], [request[@"start_y"] doubleValue]);
    }
    NSTimeInterval duration = 0;
    if (drag || move) {
        if (!RuyiAutomationFiniteNumber(request[@"duration"]) || [request[@"duration"] doubleValue] < 0 ||
            [request[@"duration"] doubleValue] > 2)
            return RuyiAutomationFailure(@"invalid_args", @"Mouse duration must be between zero and two seconds");
        duration = [request[@"duration"] doubleValue];
    }
    NSInteger clicks = 1;
    NSTimeInterval interval = 0;
    if ([op isEqual:@"mouse.click"]) {
        if (!RuyiAutomationFiniteNumber(request[@"clicks"]) ||
            [request[@"clicks"] doubleValue] != trunc([request[@"clicks"] doubleValue]) ||
            [request[@"clicks"] intValue] < 1 || [request[@"clicks"] intValue] > 5 ||
            !RuyiAutomationFiniteNumber(request[@"interval"]) || [request[@"interval"] doubleValue] < 0 ||
            [request[@"interval"] doubleValue] > 0.5)
            return RuyiAutomationFailure(@"invalid_args", @"Click count or interval exceeds the input limits");
        clicks = [request[@"clicks"] integerValue];
        interval = [request[@"interval"] doubleValue];
    } else if ([op isEqual:@"mouse.scroll"]) {
        if (!RuyiAutomationFiniteNumber(request[@"amount"]) ||
            [request[@"amount"] doubleValue] != trunc([request[@"amount"] doubleValue]) ||
            fabs([request[@"amount"] doubleValue]) > 100 ||
            ![@[ @"vertical", @"horizontal" ] containsObject:request[@"direction"]])
            return RuyiAutomationFailure(@"invalid_args", @"Pass at most 100 vertical or horizontal wheel notches");
    } else if (!drag && !move)
        return RuyiAutomationFailure(@"invalid_args", @"Unsupported mouse operation");
    NSTimeInterval deadline = NSProcessInfo.processInfo.systemUptime + 8;
    NSDictionary *failure = FocusGuard(row, window, deadline);
    if (!failure)
        failure = RuyiAutomationPointGuard(row, window, point);
    if (!failure && drag)
        failure = RuyiAutomationPointGuard(row, window, start);
    if (failure)
        return failure;
    BOOL acted = NO;
    @try {
        CGPoint initial = drag || move ? start : point;
        if (!PostMouse(kCGEventMouseMoved, initial, button, 0))
            return RuyiAutomationFailure(@"input_failed", @"Cannot create pointer events");
        acted = YES;
        Wait(0.02);
        CGPoint actual = Pointer();
        if (!AtPoint(actual, initial))
            failure = RuyiAutomationFailure(@"pointer_unconfirmed", @"Cursor did not reach the requested start point");
        if (!failure)
            failure = FocusGuard(row, window, deadline);
        if (!failure && !move)
            failure = RuyiAutomationPointGuard(row, window, initial);
        if (!failure && (drag || move)) {
            if (drag && !PostMouse(ButtonEvent(button, YES), start, button, 1))
                failure = RuyiAutomationFailure(@"input_failed", @"Cannot create drag button event");
            NSInteger steps = MAX(1, (NSInteger)ceil(duration / 0.02));
            for (NSInteger i = 1; !failure && i <= steps; i++) {
                CGPoint next = CGPointMake(initial.x + (point.x - initial.x) * i / steps,
                                           initial.y + (point.y - initial.y) * i / steps);
                failure = FocusGuard(row, window, deadline);
                if (!failure && drag)
                    failure = RuyiAutomationPointGuard(row, window, next);
                CGEventType type = drag ? (button == 0   ? kCGEventLeftMouseDragged
                                           : button == 1 ? kCGEventRightMouseDragged
                                                         : kCGEventOtherMouseDragged)
                                        : kCGEventMouseMoved;
                if (!failure && !PostMouse(type, next, button, 0))
                    failure = RuyiAutomationFailure(@"input_failed", @"Cannot create pointer movement events");
                if (!failure)
                    Wait(duration / steps);
            }
        } else if (!failure && [op isEqual:@"mouse.click"]) {
            for (NSInteger i = 1; !failure && i <= clicks; i++) {
                failure = FocusGuard(row, window, deadline);
                if (!failure)
                    failure = RuyiAutomationPointGuard(row, window, point);
                if (!failure && (!PostMouse(ButtonEvent(button, YES), point, button, i) ||
                                 !PostMouse(ButtonEvent(button, NO), point, button, i)))
                    failure = RuyiAutomationFailure(@"input_failed", @"Cannot create mouse click events");
                if (!failure && i < clicks)
                    Wait(interval);
            }
        } else if (!failure) {
            int amount = [request[@"amount"] intValue];
            BOOL horizontal = [request[@"direction"] isEqual:@"horizontal"];
            CGEventRef scroll = CGEventCreateScrollWheelEvent(
                NULL, kCGScrollEventUnitLine, 2, horizontal ? 0 : amount, horizontal ? -amount : 0);
            if (scroll) {
                CGEventSetLocation(scroll, point);
                CGEventSetFlags(scroll, 0);
                CGEventPost(kCGHIDEventTap, scroll);
                CFRelease(scroll);
            } else
                failure = RuyiAutomationFailure(@"input_failed", @"Cannot create wheel event");
        }
    } @finally {
        RuyiAutomationReleaseEvents();
    }
    Wait(0.02);
    CGPoint actual = Pointer();
    if (!failure && !AtPoint(actual, point))
        failure = RuyiAutomationFailure(@"pointer_unconfirmed", @"Cursor did not reach the requested end point");
    if (!failure)
        failure = FocusGuard(row, window, deadline);
    NSMutableDictionary *out = [failure ? InputFailure(failure, acted) : @{
        @"ok" : @YES,
        @"protocolVersion" : @1,
        @"acted" : @YES,
        @"action_sent" : @YES,
        @"verification" : @"events_posted"
    } mutableCopy];
    if (isfinite(actual.x) && isfinite(actual.y)) {
        out[@"actual_x"] = @(actual.x);
        out[@"actual_y"] = @(actual.y);
    }
    out[@"reached"] = @(AtPoint(actual, point));
    return out;
}

NSDictionary *RuyiAutomationEventsRequest(NSDictionary *request) {
    NSSet *keys = [NSSet setWithArray:@[
        @"version",
        @"op",
        @"target",
        @"keys",
        @"text",
        @"paste",
        @"interval",
        @"enters",
        @"x",
        @"y",
        @"start_x",
        @"start_y",
        @"duration",
        @"button",
        @"clicks",
        @"amount",
        @"direction"
    ]];
    for (NSString *key in request)
        if (![keys containsObject:key])
            return RuyiAutomationFailure(@"invalid_args", @"Unexpected input field");
    if (RuyiAutomationLocked())
        return RuyiAutomationFailure(@"session_locked", @"Unlock the desktop before querying or sending input");
    NSString *op = request[@"op"];
    if ([op isEqual:@"mouse.position"]) {
        CGPoint point = Pointer();
        if (!isfinite(point.x) || !isfinite(point.y))
            return RuyiAutomationFailure(@"pointer_unavailable", @"Cannot observe the cursor");
        return @{
            @"ok" : @YES,
            @"protocolVersion" : @1,
            @"x" : @(point.x),
            @"y" : @(point.y),
            @"coordinate_space" : @"macos_global_points"
        };
    }
    if (!AXIsProcessTrusted() || !CGPreflightPostEventAccess())
        return RuyiAutomationFailure(@"permission_denied",
                                     @"Enable Accessibility and event posting for the responsible application");
    CGEventFlags modifiers =
        kCGEventFlagMaskCommand | kCGEventFlagMaskControl | kCGEventFlagMaskAlternate | kCGEventFlagMaskShift;
    if (CGEventSourceFlagsState(kCGEventSourceStateHIDSystemState) & modifiers)
        return RuyiAutomationFailure(@"physical_input_busy", @"Release physical modifier keys before automated input");
    for (CGMouseButton button = 0; button <= 2; button++)
        if (CGEventSourceButtonState(kCGEventSourceStateHIDSystemState, button))
            return RuyiAutomationFailure(@"physical_input_busy",
                                         @"Release physical mouse buttons before automated input");
    NSDictionary *row = RuyiAutomationCheckTarget(request[@"target"]);
    if (row[@"error"])
        return row;
    NSDictionary *failure = nil;
    AXUIElementRef window = RuyiAutomationCopyTargetWindow(row, &failure);
    if (!window)
        return failure;
    NSDictionary *result;
    @try {
        result = [op hasPrefix:@"keyboard."] ? Keyboard(request, row, window) : Mouse(request, row, window);
    } @finally {
        RuyiAutomationReleaseEvents();
        CFRelease(window);
    }
    return result;
}

#ifdef RUYI_AUTOMATION_TESTING
NSDictionary *RuyiAutomationTestBlockedClipboard(NSDictionary *request) {
    if (RuyiAutomationLocked()) return RuyiAutomationFailure(@"session_locked", @"Unlock the controlled clipboard fixture");
    NSString *text = request[@"text"];
    if (![text isKindOfClass:NSString.class] || [text lengthOfBytesUsingEncoding:NSUTF8StringEncoding] > 48000)
        return RuyiAutomationFailure(@"invalid_args", @"Pass bounded fixture text");
    NSArray *previous = nil;
    NSDictionary *written = RuyiAutomationWriteClipboard(NSPasteboard.generalPasteboard, @[text], &previous);
    if (![written[@"ok"] boolValue]) return written;
    // Deliberately prevent the main run loop from handling stop callbacks. The
    // production reader watchdog must restore this owned snapshot before exit.
    [NSThread sleepForTimeInterval:30];
    return RuyiAutomationFailure(@"test_deadline_missed", @"Native watchdog did not terminate the blocked fixture");
}

NSDictionary *RuyiAutomationTestInputState(void) {
    BOOL admitted = RuyiAutomationTrackClipboard(@[], 123);
    BOOL active = [RuyiAutomationRestorePendingClipboard() isEqual:@"pending"];
    RuyiAutomationStopEvents();
    BOOL refused = !RuyiAutomationTrackClipboard(@[ @"replacement" ], 456);
    BOOL preserved = pendingClipboard.count == 0 && pendingClipboardVersion == 123 && clipboardWriteActive;
    BOOL invalidPointerRefused = !AtPoint(CGPointMake(NAN, 0), CGPointZero) && !AtPoint(CGPointMake(0, NAN), CGPointZero);
    // This fixture never calls NSPasteboard. Drop the synthetic memory-only transaction.
    pendingClipboard = nil;
    clipboardWriteActive = NO;
    clipboardRestoreState = @"none";
    return @{
        @"ok" : @YES,
        @"protocolVersion" : @1,
        @"admitted" : @(admitted),
        @"active_write_retained" : @(active),
        @"stopped_write_refused" : @(refused),
        @"prior_snapshot_retained" : @(preserved),
        @"invalid_pointer_refused" : @(invalidPointerRefused)
    };
}
#endif
