// Portable, inspectable event rows. Never persist an opaque CGEvent or its old target PID.
#import "macos-automation.h"
#import <IOKit/hidsystem/IOLLEvent.h>
#ifdef RUYI_AUTOMATION_TESTING
static BOOL testPressureAssociation;
#endif

CGEventFlags RuyiAutomationSequenceModifier(CGKeyCode code) {
    switch (code) {
        case 54: case 55: return kCGEventFlagMaskCommand;
        case 56: case 60: return kCGEventFlagMaskShift;
        case 58: case 61: return kCGEventFlagMaskAlternate;
        case 59: case 62: return kCGEventFlagMaskControl;
        case 63: return kCGEventFlagMaskSecondaryFn;
        default: return 0;
    }
}

CGEventFlags RuyiAutomationSequenceDeviceModifier(CGKeyCode code) {
    switch (code) {
        case 54: return NX_DEVICERCMDKEYMASK;
        case 55: return NX_DEVICELCMDKEYMASK;
        case 56: return NX_DEVICELSHIFTKEYMASK;
        case 60: return NX_DEVICERSHIFTKEYMASK;
        case 58: return NX_DEVICELALTKEYMASK;
        case 61: return NX_DEVICERALTKEYMASK;
        case 59: return NX_DEVICELCTLKEYMASK;
        case 62: return NX_DEVICERCTLKEYMASK;
        default: return 0;
    }
}

static BOOL Number(id value, double low, double high, BOOL integer) {
    return RuyiAutomationFiniteNumber(value) && [value doubleValue] >= low && [value doubleValue] <= high
        && (!integer || [value doubleValue] == trunc([value doubleValue]));
}

static NSDictionary *Invalid(void) {
    return RuyiAutomationFailure(@"invalid_args", @"Pass a balanced sequence of 1-512 supported events over at most five seconds");
}

static BOOL Key(NSString *type) {
    return [@[@"key_down", @"key_up", @"flags"] containsObject:type];
}

static CGEventType EventType(NSDictionary *row) {
    NSString *type = row[@"type"];
    if ([type isEqual:@"key_down"]) return kCGEventKeyDown;
    if ([type isEqual:@"key_up"]) return kCGEventKeyUp;
    if ([type isEqual:@"flags"]) return kCGEventFlagsChanged;
    if ([type isEqual:@"scroll"]) return kCGEventScrollWheel;
    if ([type isEqual:@"move"]) return kCGEventMouseMoved;
    NSUInteger button = [row[@"button"] unsignedIntegerValue];
    if ([type isEqual:@"mouse_down"]) return button == 0 ? kCGEventLeftMouseDown : button == 1 ? kCGEventRightMouseDown : kCGEventOtherMouseDown;
    if ([type isEqual:@"mouse_up"]) return button == 0 ? kCGEventLeftMouseUp : button == 1 ? kCGEventRightMouseUp : kCGEventOtherMouseUp;
    return button == 0 ? kCGEventLeftMouseDragged : button == 1 ? kCGEventRightMouseDragged : kCGEventOtherMouseDragged;
}

CGEventRef RuyiAutomationCreateSequenceEvent(NSDictionary *row, CGEventSourceRef source) {
    NSString *type = row[@"type"];
    CGEventRef event;
    if (Key(type)) {
        event = CGEventCreateKeyboardEvent(source, [row[@"keycode"] unsignedShortValue], ![type isEqual:@"key_up"]);
        if (!event) return NULL;
        CGEventSetType(event, EventType(row));
        CGEventSetIntegerValueField(event, kCGKeyboardEventKeyboardType, [row[@"keyboard_type"] longLongValue]);
        if (![type isEqual:@"flags"]) {
            CGEventSetIntegerValueField(event, kCGKeyboardEventAutorepeat, [row[@"repeat"] longLongValue]);
            NSString *text = row[@"unicode"];
            if (text) {
                UniChar units[20]; [text getCharacters:units range:NSMakeRange(0, text.length)];
                CGEventKeyboardSetUnicodeString(event, text.length, units);
            }
        }
    } else {
        CGPoint point = CGPointMake([row[@"x"] doubleValue], [row[@"y"] doubleValue]);
        if ([type isEqual:@"scroll"]) {
            event = CGEventCreateScrollWheelEvent(source, [row[@"continuous"] boolValue] ? kCGScrollEventUnitPixel : kCGScrollEventUnitLine, 3, 0, 0, 0);
            if (!event) return NULL;
            CGEventSetLocation(event, point);
            CGEventSetIntegerValueField(event, kCGScrollWheelEventIsContinuous, [row[@"continuous"] boolValue]);
            for (NSUInteger axis = 0; axis < 3; axis++) {
                CGEventSetIntegerValueField(event, (CGEventField)(kCGScrollWheelEventDeltaAxis1 + axis), [row[@"delta"][axis] longLongValue]);
                CGEventSetDoubleValueField(event, (CGEventField)(kCGScrollWheelEventFixedPtDeltaAxis1 + axis), [row[@"fixed"][axis] doubleValue]);
                CGEventSetIntegerValueField(event, (CGEventField)(kCGScrollWheelEventPointDeltaAxis1 + axis), [row[@"point"][axis] longLongValue]);
            }
            CGEventSetIntegerValueField(event, kCGScrollWheelEventScrollPhase, [row[@"phase"] longLongValue]);
            CGEventSetIntegerValueField(event, kCGScrollWheelEventMomentumPhase, [row[@"momentum"] longLongValue]);
            CGEventSetIntegerValueField(event, kCGScrollWheelEventScrollCount, [row[@"scroll_count"] longLongValue]);
        } else {
            event = CGEventCreateMouseEvent(source, EventType(row), point, [row[@"button"] unsignedIntValue]);
            if (!event) return NULL;
            CGEventSetIntegerValueField(event, kCGMouseEventClickState, [row[@"click_state"] longLongValue]);
            CGEventSetDoubleValueField(event, kCGMouseEventPressure, [row[@"pressure"] doubleValue]);
            CGEventSetIntegerValueField(event, kCGMouseEventDeltaX, [row[@"delta_x"] longLongValue]);
            CGEventSetIntegerValueField(event, kCGMouseEventDeltaY, [row[@"delta_y"] longLongValue]);
            CGEventSetIntegerValueField(event, kCGMouseEventSubtype, [row[@"subtype"] longLongValue]);
        }
    }
    CGEventSetFlags(event, [row[@"flags"] unsignedLongLongValue]);
    return event;
}

static BOOL SameCharacters(CGEventRef actual, CGEventRef rebuilt) {
    NSEvent *left = [NSEvent eventWithCGEvent:actual], *right = [NSEvent eventWithCGEvent:rebuilt];
    return left && right && left.modifierFlags == right.modifierFlags && [left.characters isEqual:right.characters]
        && [left.charactersIgnoringModifiers isEqual:right.charactersIgnoringModifiers];
}

#ifdef RUYI_AUTOMATION_TESTING
NSDictionary *RuyiAutomationTestPointerProjection(void) {
    NSMutableArray *cases = [NSMutableArray array];
    for (NSNumber *subtype in @[@0, @3]) {
        for (NSNumber *type in @[@(kCGEventMouseMoved), @(kCGEventLeftMouseDown), @(kCGEventLeftMouseUp), @(kCGEventLeftMouseDragged),
            @(kCGEventRightMouseDown), @(kCGEventRightMouseUp), @(kCGEventRightMouseDragged),
            @(kCGEventOtherMouseDown), @(kCGEventOtherMouseUp), @(kCGEventOtherMouseDragged)]) {
            CGMouseButton button = type.unsignedIntValue >= kCGEventOtherMouseDown ? 2
                : [@[@(kCGEventRightMouseDown), @(kCGEventRightMouseUp), @(kCGEventRightMouseDragged)] containsObject:type] ? 1 : 0;
            CGEventRef event = CGEventCreateMouseEvent(NULL, type.unsignedIntValue, CGPointMake(25, 35), button);
            if (!event) return Invalid();
            CGEventSetIntegerValueField(event, kCGMouseEventSubtype, subtype.longLongValue);
            CGEventSetDoubleValueField(event, kCGMouseEventPressure, .37);
            CGEventSetFlags(event, 0);
            testPressureAssociation = YES;
            NSDictionary *failure = nil;
            NSDictionary *row = RuyiAutomationSequenceEventProfile(event, 0, &failure, @"standard_mouse");
            testPressureAssociation = NO;
            CFRelease(event);
            if (!row) {
                [cases addObject:@{@"subtype":subtype, @"type":type, @"matched":@NO, @"failure":failure ?: @{}}];
                continue;
            }
            NSMutableArray *complete = [NSMutableArray array];
            NSMutableDictionary *down = [row mutableCopy], *up = [row mutableCopy], *middle = [row mutableCopy];
            down[@"type"] = @"mouse_down"; down[@"pressure"] = @1;
            up[@"type"] = @"mouse_up"; up[@"pressure"] = @0;
            if ([row[@"type"] isEqual:@"move"]) [complete addObject:row];
            else {
                [complete addObject:down];
                if ([row[@"type"] isEqual:@"drag"]) { middle[@"at_us"] = @10; [complete addObject:middle]; }
                up[@"at_us"] = @20; [complete addObject:up];
            }
            CGEventRef rebuilt = row ? RuyiAutomationCreateSequenceEvent(row, NULL) : NULL;
            BOOL matched = row && rebuilt && !failure && !RuyiAutomationValidateSequenceProfile(complete, nil, YES, @"standard_mouse")
                && CGEventGetIntegerValueField(rebuilt, kCGMouseEventSubtype) == 0
                && CGEventGetDoubleValueField(rebuilt, kCGMouseEventPressure) == ([@[@"mouse_down", @"drag"] containsObject:row[@"type"]] ? 1 : 0)
                && (!subtype.intValue || [row[@"source_subtype"] isEqual:subtype]);
            if (![row[@"type"] isEqual:@"move"]) matched = matched && ([row[@"associated_events_mask"] unsignedLongLongValue] & NSEventMaskPressure)
                && RuyiAutomationValidateSequence(complete, nil, YES) != nil;
            if (rebuilt) CFRelease(rebuilt);
            [cases addObject:@{@"subtype":subtype, @"type":type, @"matched":@(matched), @"row":row ?: @{}, @"failure":failure ?: @{}}];
        }
    }
    return @{@"ok":@YES, @"protocolVersion":@1, @"cases":cases};
}

NSDictionary *RuyiAutomationTestPointerSubtypes(void) {
    NSMutableArray *cases = [NSMutableArray array];
    for (NSNumber *subtype in @[@0, @1, @2, @3, @4]) {
        for (NSNumber *type in @[@(kCGEventMouseMoved), @(kCGEventLeftMouseDown), @(kCGEventLeftMouseUp), @(kCGEventLeftMouseDragged),
            @(kCGEventRightMouseDown), @(kCGEventRightMouseUp), @(kCGEventRightMouseDragged),
            @(kCGEventOtherMouseDown), @(kCGEventOtherMouseUp), @(kCGEventOtherMouseDragged)]) {
            CGMouseButton button = type.unsignedIntValue >= kCGEventOtherMouseDown ? 2
                : [@[@(kCGEventRightMouseDown), @(kCGEventRightMouseUp), @(kCGEventRightMouseDragged)] containsObject:type] ? 1 : 0;
            CGEventRef event = CGEventCreateMouseEvent(NULL, type.unsignedIntValue, CGPointMake(25, 35), button);
            if (!event) return Invalid();
            CGEventSetIntegerValueField(event, kCGMouseEventSubtype, subtype.longLongValue);
            CGEventSetIntegerValueField(event, kCGMouseEventClickState, 2);
            CGEventSetDoubleValueField(event, kCGMouseEventPressure, .5);
            CGEventSetIntegerValueField(event, kCGMouseEventDeltaX, 7);
            CGEventSetIntegerValueField(event, kCGMouseEventDeltaY, -4);
            CGEventSetFlags(event, 0);
            NSDictionary *failure = nil;
            NSDictionary *row = RuyiAutomationSequenceEvent(event, 0, &failure);
            BOOL supported = subtype.intValue == NX_SUBTYPE_DEFAULT || subtype.intValue == NX_SUBTYPE_MOUSE_TOUCH;
            BOOL matched = !supported && !row && [failure[@"code"] isEqual:@"pointer_event_unsupported"];
            if (supported && row) {
                CGEventRef rebuilt = RuyiAutomationCreateSequenceEvent(row, NULL);
                matched = rebuilt && CGEventGetType(rebuilt) == CGEventGetType(event)
                    && CGPointEqualToPoint(CGEventGetLocation(rebuilt), CGEventGetLocation(event));
                if (rebuilt) {
                    for (NSNumber *field in @[@(kCGMouseEventSubtype), @(kCGMouseEventButtonNumber), @(kCGMouseEventClickState), @(kCGMouseEventDeltaX), @(kCGMouseEventDeltaY)])
                        matched = matched && CGEventGetIntegerValueField(rebuilt, field.unsignedIntValue) == CGEventGetIntegerValueField(event, field.unsignedIntValue);
                    matched = matched && CGEventGetDoubleValueField(rebuilt, kCGMouseEventPressure) == CGEventGetDoubleValueField(event, kCGMouseEventPressure);
                    CFRelease(rebuilt);
                }
            }
            CFRelease(event);
            [cases addObject:@{@"subtype":subtype, @"type":type, @"matched":@(matched), @"row":row ?: @{}, @"failure":failure ?: @{}}];
        }
    }
    CGEventRef pressureAssociated = CGEventCreateMouseEvent(NULL, kCGEventLeftMouseDown, CGPointMake(25, 35), 0);
    if (!pressureAssociated) return Invalid();
    testPressureAssociation = YES;
    NSDictionary *failure = nil;
    NSDictionary *row = RuyiAutomationSequenceEvent(pressureAssociated, 0, &failure);
    testPressureAssociation = NO;
    CFRelease(pressureAssociated);
    return @{@"ok":@YES, @"protocolVersion":@1, @"cases":cases,
        @"pressure_association_refused":@(!row && [failure[@"code"] isEqual:@"pointer_semantics_unsupported"])};
}
#endif

NSDictionary *RuyiAutomationSequenceEvent(CGEventRef event, uint64_t offset, NSDictionary **failure) {
    return RuyiAutomationSequenceEventProfile(event, offset, failure, @"exact");
}

NSDictionary *RuyiAutomationSequenceEventProfile(CGEventRef event, uint64_t offset, NSDictionary **failure, NSString *profile) {
    if (![@[@"exact", @"standard_mouse"] containsObject:profile]) { *failure = Invalid(); return nil; }
    CGEventType type = CGEventGetType(event);
    NSDictionary *types = @{@(kCGEventKeyDown):@"key_down", @(kCGEventKeyUp):@"key_up", @(kCGEventFlagsChanged):@"flags",
        @(kCGEventMouseMoved):@"move", @(kCGEventLeftMouseDown):@"mouse_down", @(kCGEventRightMouseDown):@"mouse_down",
        @(kCGEventOtherMouseDown):@"mouse_down", @(kCGEventLeftMouseUp):@"mouse_up", @(kCGEventRightMouseUp):@"mouse_up",
        @(kCGEventOtherMouseUp):@"mouse_up", @(kCGEventLeftMouseDragged):@"drag", @(kCGEventRightMouseDragged):@"drag",
        @(kCGEventOtherMouseDragged):@"drag", @(kCGEventScrollWheel):@"scroll"};
    if (!types[@(type)]) { *failure = Invalid(); return nil; }
    if (CGEventGetFlags(event) > UINT32_MAX) {
        *failure = RuyiAutomationFailure(@"event_flags_unsupported", @"Event contains unsupported flags"); return nil;
    }
    NSMutableDictionary *row = [@{@"type":types[@(type)], @"at_us":@(offset), @"flags":@(CGEventGetFlags(event))} mutableCopy];
    if (Key(row[@"type"])) {
        row[@"keycode"] = @(CGEventGetIntegerValueField(event, kCGKeyboardEventKeycode));
        row[@"keyboard_type"] = @(CGEventGetIntegerValueField(event, kCGKeyboardEventKeyboardType));
        if (type != kCGEventFlagsChanged) {
            row[@"repeat"] = @(CGEventGetIntegerValueField(event, kCGKeyboardEventAutorepeat));
            CGEventRef clone = RuyiAutomationCreateSequenceEvent(row, NULL);
            BOOL same = clone && SameCharacters(event, clone);
            if (clone) CFRelease(clone);
            if (!same) {
                UniChar units[21]; UniCharCount length = 0;
                CGEventKeyboardGetUnicodeString(event, 21, &length, units);
                if (length > 20) { *failure = Invalid(); return nil; }
                row[@"unicode"] = [[NSString alloc] initWithCharacters:units length:length];
                clone = RuyiAutomationCreateSequenceEvent(row, NULL);
                same = clone && SameCharacters(event, clone);
                if (clone) CFRelease(clone);
                if (!same) { *failure = RuyiAutomationFailure(@"key_semantics_unsupported", @"Cannot reconstruct this keyboard event's character semantics"); return nil; }
            }
        }
    } else {
        CGPoint point = CGEventGetLocation(event); row[@"x"] = @(point.x); row[@"y"] = @(point.y);
        if (type == kCGEventScrollWheel) {
            NSMutableArray *delta = [NSMutableArray array], *fixed = [NSMutableArray array], *points = [NSMutableArray array];
            for (NSUInteger axis = 0; axis < 3; axis++) {
                [delta addObject:@(CGEventGetIntegerValueField(event, (CGEventField)(kCGScrollWheelEventDeltaAxis1 + axis)))];
                [fixed addObject:@(CGEventGetDoubleValueField(event, (CGEventField)(kCGScrollWheelEventFixedPtDeltaAxis1 + axis)))];
                [points addObject:@(CGEventGetIntegerValueField(event, (CGEventField)(kCGScrollWheelEventPointDeltaAxis1 + axis)))];
            }
            row[@"delta"] = delta; row[@"fixed"] = fixed; row[@"point"] = points;
            row[@"continuous"] = CGEventGetIntegerValueField(event, kCGScrollWheelEventIsContinuous) != 0 ? @YES : @NO;
            row[@"phase"] = @(CGEventGetIntegerValueField(event, kCGScrollWheelEventScrollPhase));
            row[@"momentum"] = @(CGEventGetIntegerValueField(event, kCGScrollWheelEventMomentumPhase));
            row[@"scroll_count"] = @(CGEventGetIntegerValueField(event, kCGScrollWheelEventScrollCount));
        } else {
            int64_t subtype = CGEventGetIntegerValueField(event, kCGMouseEventSubtype);
            // Trackpad mouse events use the SDK's mouse-touch subtype. It is
            // distinct from tablet point/proximity, which need additional fields.
            if (subtype != NX_SUBTYPE_DEFAULT && subtype != NX_SUBTYPE_MOUSE_TOUCH) {
                *failure = RuyiAutomationFailure(@"pointer_event_unsupported", @"Unsupported pointer subtype requires additional native fields"); return nil;
            }
            BOOL standard = [profile isEqual:@"standard_mouse"];
            if (subtype) row[standard ? @"source_subtype" : @"subtype"] = @(subtype);
            row[@"button"] = @(CGEventGetIntegerValueField(event, kCGMouseEventButtonNumber));
            row[@"click_state"] = @(CGEventGetIntegerValueField(event, kCGMouseEventClickState));
            row[@"pressure"] = standard ? @([@[@"mouse_down", @"drag"] containsObject:row[@"type"]] ? 1 : 0)
                : @(CGEventGetDoubleValueField(event, kCGMouseEventPressure));
            row[@"delta_x"] = @(CGEventGetIntegerValueField(event, kCGMouseEventDeltaX));
            row[@"delta_y"] = @(CGEventGetIntegerValueField(event, kCGMouseEventDeltaY));
            CGEventRef clone = RuyiAutomationCreateSequenceEvent(row, NULL);
            NSEvent *original = [NSEvent eventWithCGEvent:event];
            NSEvent *rebuilt = clone ? [NSEvent eventWithCGEvent:clone] : nil;
            // AppKit rejects associatedEventsMask on MouseMoved despite the
            // header's broad "mouse events" wording. Associations belong to
            // button sequences; moving alone cannot start a pressure sequence.
            NSEventMask associated = 0, reconstructed = 0;
            BOOL comparable = original && rebuilt;
            @try {
                if (type != kCGEventMouseMoved) {
                    associated = original.associatedEventsMask;
                    reconstructed = rebuilt.associatedEventsMask;
                }
                if (!standard) comparable = comparable && original.subtype == rebuilt.subtype;
            } @catch (NSException *exception) { (void)exception; comparable = NO; }
#ifdef RUYI_AUTOMATION_TESTING
            if (testPressureAssociation) associated |= NSEventMaskPressure;
#endif
            // Pressure events and their stages are outside this portable mouse
            // sequence. Do not silently change an application's deep-click path.
            BOOL same = comparable && (standard || (!(associated & NSEventMaskPressure) && associated == reconstructed));
            if (standard && type != kCGEventMouseMoved) row[@"associated_events_mask"] = @(associated);
            if (clone) CFRelease(clone);
            if (!same) {
                *failure = RuyiAutomationFailure(@"pointer_semantics_unsupported", @"Cannot reconstruct this pointer event's associated semantics"); return nil;
            }
        }
    }
    return row;
}

NSDictionary *RuyiAutomationValidateSequence(id events, NSDictionary *bounds, BOOL complete) {
    return RuyiAutomationValidateSequenceProfile(events, bounds, complete, @"exact");
}

NSDictionary *RuyiAutomationValidateSequenceProfile(id events, NSDictionary *bounds, BOOL complete, NSString *profile) {
    if (![@[@"exact", @"standard_mouse"] containsObject:profile]) return Invalid();
    if (![events isKindOfClass:NSArray.class] || [events count] < 1 || [events count] > 512) return Invalid();
    NSData *data = [NSJSONSerialization dataWithJSONObject:events options:0 error:nil];
    if (!data || data.length > 48000) return Invalid();
    NSMutableSet *keys = [NSMutableSet set], *buttons = [NSMutableSet set];
    uint64_t previous = 0; NSInteger scrolling = 0; BOOL momentum = NO;
    for (id value in events) {
        if (![value isKindOfClass:NSDictionary.class]) return Invalid();
        NSDictionary *row = value; NSString *type = row[@"type"];
        if (![type isKindOfClass:NSString.class]) return Invalid();
        NSMutableSet *fields = [NSMutableSet setWithArray:@[@"type", @"at_us", @"flags"]];
        if (!Number(row[@"at_us"], previous, 5000000, YES) || (row == [events firstObject] && [row[@"at_us"] unsignedLongLongValue] != 0)
            || !Number(row[@"flags"], 0, UINT32_MAX, YES)) return Invalid();
        previous = [row[@"at_us"] unsignedLongLongValue];
        if (Key(type)) {
            [fields addObjectsFromArray:@[@"keycode", @"keyboard_type"]];
            if (!Number(row[@"keycode"], 0, 127, YES) || !Number(row[@"keyboard_type"], 0, 65535, YES)) return Invalid();
            NSNumber *code = row[@"keycode"];
            if ([type isEqual:@"flags"]) {
                if (!RuyiAutomationSequenceModifier(code.unsignedShortValue) && code.intValue != 57) return Invalid();
                if (code.intValue != 57) {
                    if ([keys containsObject:code]) [keys removeObject:code]; else [keys addObject:code];
                }
            } else {
                [fields addObject:@"repeat"];
                if (!Number(row[@"repeat"], 0, 1, YES) || RuyiAutomationSequenceModifier(code.unsignedShortValue) || code.intValue == 57) return Invalid();
                if (row[@"unicode"]) {
                    [fields addObject:@"unicode"];
                    if (![row[@"unicode"] isKindOfClass:NSString.class] || [row[@"unicode"] length] > 20
                        || ![row[@"unicode"] canBeConvertedToEncoding:NSUTF8StringEncoding]) return Invalid();
                }
                if ([type isEqual:@"key_down"]) {
                    if ([row[@"repeat"] boolValue] != [keys containsObject:code]) return Invalid();
                    [keys addObject:code];
                } else {
                    if ([row[@"repeat"] boolValue] || ![keys containsObject:code]) return Invalid();
                    [keys removeObject:code];
                }
            }
        } else {
            [fields addObjectsFromArray:@[@"x", @"y"]];
            if (!Number(row[@"x"], -1000000, 1000000, NO) || !Number(row[@"y"], -1000000, 1000000, NO)
                || (bounds && !CGRectContainsPoint(RuyiAutomationFieldsRect(bounds), CGPointMake([row[@"x"] doubleValue], [row[@"y"] doubleValue])))) return Invalid();
            if ([type isEqual:@"scroll"]) {
                [fields addObjectsFromArray:@[@"delta", @"fixed", @"point", @"continuous", @"phase", @"momentum", @"scroll_count"]];
                if (![row[@"continuous"] isKindOfClass:NSNumber.class] || CFGetTypeID((__bridge CFTypeRef)row[@"continuous"]) != CFBooleanGetTypeID()
                    || !Number(row[@"phase"], 0, 255, YES) || ([row[@"phase"] intValue] & ~143)
                    || !Number(row[@"momentum"], 0, 3, YES) || !Number(row[@"scroll_count"], 0, INT32_MAX, YES)) return Invalid();
                for (NSString *name in @[@"delta", @"fixed", @"point"]) {
                    if (![row[name] isKindOfClass:NSArray.class] || [row[name] count] != 3) return Invalid();
                    for (id number in row[name]) if (!Number(number, -32767, 32767, ![name isEqual:@"fixed"])) return Invalid();
                }
                NSInteger phase = [row[@"phase"] integerValue], stage = [row[@"momentum"] integerValue];
                if (phase & 128) { if (scrolling || (phase & ~128)) return Invalid(); scrolling = 128; }
                if (phase & 1) { if (scrolling == 1 || momentum) return Invalid(); scrolling = 1; }
                if ((phase & 2) && scrolling != 1) return Invalid();
                if (phase & (4 | 8)) { if (!scrolling || ((phase & 4) && (phase & 8))) return Invalid(); scrolling = 0; }
                if (stage == 1) { if (momentum || scrolling) return Invalid(); momentum = YES; }
                if (stage == 2 && !momentum) return Invalid();
                if (stage == 3) { if (!momentum) return Invalid(); momentum = NO; }
            } else {
                if (![@[@"mouse_down", @"mouse_up", @"drag", @"move"] containsObject:type]) return Invalid();
                [fields addObjectsFromArray:@[@"button", @"click_state", @"pressure", @"delta_x", @"delta_y"]];
                if (row[@"associated_events_mask"]) {
                    [fields addObject:@"associated_events_mask"];
                    uint64_t allowed = NSEventMaskLeftMouseDown | NSEventMaskLeftMouseUp | NSEventMaskLeftMouseDragged
                        | NSEventMaskRightMouseDown | NSEventMaskRightMouseUp | NSEventMaskRightMouseDragged
                        | NSEventMaskOtherMouseDown | NSEventMaskOtherMouseUp | NSEventMaskOtherMouseDragged
                        | NSEventMaskMouseMoved | NSEventMaskPressure;
                    if (![profile isEqual:@"standard_mouse"] || [type isEqual:@"move"]
                        || !Number(row[@"associated_events_mask"], 0, 9007199254740991.0, YES)
                        || CFNumberIsFloatType((__bridge CFNumberRef)row[@"associated_events_mask"])
                        || ([row[@"associated_events_mask"] unsignedLongLongValue] & ~allowed)) return Invalid();
                }
                if (row[@"subtype"]) {
                    [fields addObject:@"subtype"];
                    if (!Number(row[@"subtype"], NX_SUBTYPE_DEFAULT, NX_SUBTYPE_MOUSE_TOUCH, YES)
                        || ![@[@(NX_SUBTYPE_DEFAULT), @(NX_SUBTYPE_MOUSE_TOUCH)] containsObject:row[@"subtype"]]) return Invalid();
                }
                if (row[@"source_subtype"]) {
                    [fields addObject:@"source_subtype"];
                    if (![profile isEqual:@"standard_mouse"] || !Number(row[@"source_subtype"], 0, 3, YES)
                        || ![@[@0, @3] containsObject:row[@"source_subtype"]]) return Invalid();
                }
                if (!Number(row[@"button"], 0, 2, YES) || !Number(row[@"click_state"], 0, 5, YES)
                    || !Number(row[@"pressure"], 0, 1, NO) || !Number(row[@"delta_x"], INT32_MIN, INT32_MAX, YES)
                    || !Number(row[@"delta_y"], INT32_MIN, INT32_MAX, YES)) return Invalid();
                if ([profile isEqual:@"standard_mouse"] && ([row[@"subtype"] intValue] != 0
                    || [row[@"pressure"] doubleValue] != ([@[@"mouse_down", @"drag"] containsObject:type] ? 1 : 0))) return Invalid();
                NSNumber *button = row[@"button"];
                if ([type isEqual:@"mouse_down"]) {
                    if ([buttons containsObject:button]) return Invalid();
                    [buttons addObject:button];
                } else if ([type isEqual:@"mouse_up"]) {
                    if (![buttons containsObject:button]) return Invalid();
                    [buttons removeObject:button];
                } else if ([type isEqual:@"drag"] && ![buttons containsObject:button]) return Invalid();
            }
        }
        if (![fields isEqual:[NSSet setWithArray:row.allKeys]]) return Invalid();
        CGEventFlags expected = 0, expectedDevice = 0;
        for (NSNumber *key in keys) {
            expected |= RuyiAutomationSequenceModifier(key.unsignedShortValue);
            expectedDevice |= RuyiAutomationSequenceDeviceModifier(key.unsignedShortValue);
        }
        CGEventFlags modifierMask = kCGEventFlagMaskCommand | kCGEventFlagMaskControl | kCGEventFlagMaskShift | kCGEventFlagMaskAlternate | kCGEventFlagMaskSecondaryFn;
        CGEventFlags flags = [row[@"flags"] unsignedLongLongValue];
        if ((flags & modifierMask) != expected) return Invalid();
        CGEventFlags deviceMask = NX_DEVICELCTLKEYMASK | NX_DEVICERCTLKEYMASK | NX_DEVICELSHIFTKEYMASK | NX_DEVICERSHIFTKEYMASK
            | NX_DEVICELCMDKEYMASK | NX_DEVICERCMDKEYMASK | NX_DEVICELALTKEYMASK | NX_DEVICERALTKEYMASK;
        // Synthetic events may omit all device bits. A supplied device state must agree with ownership.
        if ((flags & deviceMask) && (flags & deviceMask) != expectedDevice) return Invalid();
    }
    return complete && (keys.count || buttons.count || scrolling || momentum) ? Invalid() : nil;
}
