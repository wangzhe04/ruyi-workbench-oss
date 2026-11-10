// Bounded AX observations and session-private element references.
#import "macos-automation.h"

@interface RuyiAXBinding : NSObject {
    AXUIElementRef _element;
    AXUIElementRef _root;
}
@property(nonatomic, strong) NSDictionary *target;
@property(nonatomic, strong) NSDictionary *signature;
@property(nonatomic, strong) NSString *scope;
@property(nonatomic) NSTimeInterval touched;
- (void)bindElement:(AXUIElementRef)element root:(AXUIElementRef)root;
- (AXUIElementRef)element;
- (AXUIElementRef)root;
@end
@implementation RuyiAXBinding
- (void)bindElement:(AXUIElementRef)element root:(AXUIElementRef)root {
    _element = (AXUIElementRef)CFRetain(element);
    _root = (AXUIElementRef)CFRetain(root);
}
- (AXUIElementRef)element { return _element; }
- (AXUIElementRef)root { return _root; }
- (void)dealloc {
    if (_element) CFRelease(_element);
    if (_root) CFRelease(_root);
}
@end

static NSMutableDictionary<NSString *, RuyiAXBinding *> *elements;

void RuyiAutomationResetAXBindings(void) { [elements removeAllObjects]; }

void RuyiAutomationRefreshAXBindings(void) {
    NSTimeInterval now = NSProcessInfo.processInfo.systemUptime;
    for (NSString *ref in elements.allKeys)
        if (now - elements[ref].touched > 60) [elements removeObjectForKey:ref];
}

static NSDictionary *ReadinessFailure(BOOL locked, BOOL trusted) {
    if (!locked && trusted) return nil;
    RuyiAutomationResetInputBindings();
    if (locked)
        return RuyiAutomationFailure(@"session_locked", @"Unlock the desktop before accessing its elements");
    return RuyiAutomationFailure(@"permission_denied", @"Enable Accessibility for the responsible application");
}

static NSDictionary *Guard(NSTimeInterval deadline) {
    if (RuyiAutomationEventsStopping())
        return RuyiAutomationFailure(@"input_cancelled", @"Native accessibility session is stopping");
    NSDictionary *failure = ReadinessFailure(RuyiAutomationLocked(), AXIsProcessTrusted());
    if (failure) return failure;
    if (NSProcessInfo.processInfo.systemUptime >= deadline)
        return RuyiAutomationFailure(@"accessibility_timeout", @"Accessibility operation reached its bounded deadline");
    return nil;
}

static NSDictionary *AXFailure(AXError error) {
    if (error == kAXErrorAPIDisabled) return ReadinessFailure(NO, NO);
    NSString *code = @"accessibility_failed";
    if (error == kAXErrorInvalidUIElement) code = @"element_stale";
    if (error == kAXErrorCannotComplete) code = @"accessibility_timeout";
    if (error == kAXErrorAttributeUnsupported || error == kAXErrorActionUnsupported || error == kAXErrorNotImplemented)
        code = @"element_unsupported";
    return RuyiAutomationFailure(code, [NSString stringWithFormat:@"Accessibility provider returned error %d", error]);
}

static BOOL Integer(id value, NSInteger low, NSInteger high) {
    return RuyiAutomationFiniteNumber(value) && [value doubleValue] == trunc([value doubleValue]) &&
        [value doubleValue] >= low && [value doubleValue] <= high;
}

static BOOL IsBoolean(id value) {
    return value && CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID();
}

static NSDictionary *Signature(NSDictionary *node) {
    NSMutableDictionary *signature = [NSMutableDictionary dictionary];
    for (NSString *key in @[@"type", @"subrole", @"name", @"description", @"automation_id", @"bounds", @"enabled", @"editable", @"value_settable"])
        signature[key] = node[key] ?: NSNull.null;
    return signature;
}

static NSDictionary *Membership(AXUIElementRef element, AXUIElementRef root, pid_t pid,
                                NSTimeInterval deadline, CGRect *clip);

static NSDictionary *ReadNode(AXUIElementRef element, pid_t pid, NSTimeInterval deadline, NSDictionary **failure) {
    *failure = Guard(deadline);
    if (*failure) return nil;
    AXUIElementSetMessagingTimeout(element, 0.1);
    pid_t actualPID = 0;
    AXError error = AXUIElementGetPid(element, &actualPID);
    if (error != kAXErrorSuccess || actualPID != pid) {
        *failure = RuyiAutomationFailure(@"element_stale", @"Element no longer belongs to the observed process");
        return nil;
    }
    NSArray *attributes = @[(__bridge NSString *)kAXRoleAttribute, (__bridge NSString *)kAXSubroleAttribute,
        (__bridge NSString *)kAXTitleAttribute, (__bridge NSString *)kAXDescriptionAttribute,
        (__bridge NSString *)kAXIdentifierAttribute, (__bridge NSString *)kAXEnabledAttribute,
        (__bridge NSString *)kAXFocusedAttribute, (__bridge NSString *)kAXExpandedAttribute,
        (__bridge NSString *)kAXSelectedAttribute, (__bridge NSString *)kAXPositionAttribute,
        (__bridge NSString *)kAXSizeAttribute, (__bridge NSString *)kAXHiddenAttribute,
        (__bridge NSString *)kAXIsEditableAttribute];
    CFArrayRef values = NULL;
    error = AXUIElementCopyMultipleAttributeValues(element, (__bridge CFArrayRef)attributes, 0, &values);
    if (error != kAXErrorSuccess || !values || CFArrayGetCount(values) != (CFIndex)attributes.count) {
        if (values) CFRelease(values);
        *failure = AXFailure(error == kAXErrorSuccess ? kAXErrorFailure : error);
        return nil;
    }
    NSMutableDictionary *raw = [NSMutableDictionary dictionary];
    for (NSUInteger i = 0; i < attributes.count; i++) {
        CFTypeRef value = CFArrayGetValueAtIndex(values, i);
        if (CFGetTypeID(value) == AXValueGetTypeID() && AXValueGetType(value) == kAXValueAXErrorType) {
            AXError attributeError;
            if (AXValueGetValue(value, kAXValueAXErrorType, &attributeError) &&
                (attributeError == kAXErrorCannotComplete || attributeError == kAXErrorAPIDisabled))
                *failure = AXFailure(attributeError);
            continue;
        }
        raw[attributes[i]] = (__bridge id)value;
    }
    CFRelease(values);
    if (*failure) return nil;
    NSMutableDictionary *node = [NSMutableDictionary dictionary];
    NSArray *names = @[@"type", @"subrole", @"name", @"description", @"automation_id"];
    for (NSUInteger i = 0; i < names.count; i++) {
        id value = raw[attributes[i]];
        if (![value isKindOfClass:NSString.class]) continue;
        if ([value length] > 2048) {
            *failure = RuyiAutomationFailure(@"accessibility_capacity", @"Element metadata exceeds the string limit");
            return nil;
        }
        if ([value length]) node[names[i]] = value;
    }
    if (!node[@"type"]) {
        *failure = RuyiAutomationFailure(@"element_unsupported", @"Provider does not expose the element role");
        return nil;
    }
    if ([node[@"type"] isEqual:(__bridge NSString *)kAXTextAreaRole] ||
        [node[@"type"] isEqual:(__bridge NSString *)kAXTextFieldRole]) {
        Boolean settable = false;
        error = AXUIElementIsAttributeSettable(element, kAXValueAttribute, &settable);
        if (error == kAXErrorSuccess) { BOOL writable = settable; node[@"value_settable"] = @(writable); }
        else if (error == kAXErrorCannotComplete || error == kAXErrorAPIDisabled) { *failure = AXFailure(error); return nil; }
    }
    if (!node[@"name"] && node[@"description"]) node[@"name"] = node[@"description"];
    NSArray *states = @[@"enabled", @"focused", @"expanded", @"selected"];
    for (NSUInteger i = 0; i < states.count; i++) {
        id value = raw[attributes[i + 5]];
        if (IsBoolean(value)) node[states[i]] = value;
    }
    id hidden = raw[(__bridge NSString *)kAXHiddenAttribute];
    if (IsBoolean(hidden)) node[@"hidden"] = hidden;
    id editable = raw[(__bridge NSString *)kAXIsEditableAttribute];
    if (IsBoolean(editable)) node[@"editable"] = editable;
    id position = raw[(__bridge NSString *)kAXPositionAttribute], size = raw[(__bridge NSString *)kAXSizeAttribute];
    CGPoint point; CGSize dimensions;
    BOOL geometry = position && size && CFGetTypeID((__bridge CFTypeRef)position) == AXValueGetTypeID() &&
        CFGetTypeID((__bridge CFTypeRef)size) == AXValueGetTypeID() &&
        AXValueGetValue((__bridge AXValueRef)position, kAXValueCGPointType, &point) &&
        AXValueGetValue((__bridge AXValueRef)size, kAXValueCGSizeType, &dimensions) &&
        isfinite(point.x) && isfinite(point.y) && isfinite(dimensions.width) && isfinite(dimensions.height) &&
        dimensions.width > 0 && dimensions.height > 0;
    BOOL displayed = NO;
    if (geometry) {
        CGRect bounds = (CGRect){point, dimensions};
        node[@"bounds"] = RuyiAutomationRectFields(bounds);
        node[@"center"] = @[@(CGRectGetMidX(bounds)), @(CGRectGetMidY(bounds))];
        for (NSDictionary *display in RuyiAutomationDisplays())
            if (!CGRectIsEmpty(CGRectIntersection(bounds, RuyiAutomationFieldsRect(display)))) displayed = YES;
    }
    node[@"offscreen"] = @(!displayed || [node[@"hidden"] boolValue]);
    node[@"visibility"] = [node[@"offscreen"] boolValue] ? @"offscreen" : @"geometric";
    CFArrayRef actions = NULL;
    error = AXUIElementCopyActionNames(element, &actions);
    if (error == kAXErrorSuccess && actions) {
        NSMutableArray *supported = [NSMutableArray array];
        for (id action in (__bridge NSArray *)actions)
            if ([action isKindOfClass:NSString.class] && [action length] <= 128 && supported.count < 32)
                [supported addObject:action];
        node[@"actions"] = supported;
    }
    if (actions) CFRelease(actions);
    if (error == kAXErrorCannotComplete || error == kAXErrorAPIDisabled) *failure = AXFailure(error);
    if (!*failure) *failure = Guard(deadline);
    return *failure ? nil : node;
}

static void ApplyClip(NSMutableDictionary *node, CGRect clip) {
    if (!node[@"bounds"]) return;
    CGRect visible = CGRectIntersection(RuyiAutomationFieldsRect(node[@"bounds"]), clip);
    if (CGRectIsNull(visible) || CGRectIsEmpty(visible)) {
        node[@"offscreen"] = @YES; node[@"visibility"] = @"outside_clip";
    } else node[@"visible_bounds"] = RuyiAutomationRectFields(visible);
}

static BOOL VisibleHit(AXUIElementRef element, AXUIElementRef root, NSDictionary *row, NSString *scope,
                       NSDictionary *node, NSTimeInterval deadline, NSDictionary **failure) {
    if ([node[@"offscreen"] boolValue] || !node[@"visible_bounds"]) return NO;
    CGRect bounds = RuyiAutomationFieldsRect(node[@"visible_bounds"]);
    CGFloat insetX = MIN(2, bounds.size.width / 4), insetY = MIN(2, bounds.size.height / 4);
    CGPoint points[] = {CGPointMake(CGRectGetMidX(bounds), CGRectGetMidY(bounds)),
        CGPointMake(CGRectGetMinX(bounds) + insetX, CGRectGetMinY(bounds) + insetY),
        CGPointMake(CGRectGetMaxX(bounds) - insetX, CGRectGetMinY(bounds) + insetY),
        CGPointMake(CGRectGetMinX(bounds) + insetX, CGRectGetMaxY(bounds) - insetY),
        CGPointMake(CGRectGetMaxX(bounds) - insetX, CGRectGetMaxY(bounds) - insetY)};
    AXUIElementRef system = AXUIElementCreateSystemWide();
    AXUIElementSetMessagingTimeout(system, 0.1);
    BOOL confirmed = NO;
    for (NSUInteger i = 0; i < sizeof(points) / sizeof(points[0]); i++) {
        *failure = Guard(deadline);
        if (*failure) break;
        if ([scope isEqual:@"window"] && RuyiAutomationPointGuard(row, root, points[i])) continue;
        AXUIElementRef hit = NULL;
        AXError error = AXUIElementCopyElementAtPosition(system, points[i].x, points[i].y, &hit);
        if (error == kAXErrorSuccess && hit) {
            NSDictionary *membership = Membership(hit, element, [row[@"pid"] intValue], deadline, NULL);
            confirmed = membership == nil;
            if (membership && [@[@"accessibility_timeout", @"permission_denied", @"session_locked", @"input_cancelled"] containsObject:membership[@"code"]])
                *failure = membership;
        } else if (error == kAXErrorCannotComplete || error == kAXErrorAPIDisabled) *failure = AXFailure(error);
        if (hit) CFRelease(hit);
        if (confirmed || *failure) break;
    }
    CFRelease(system);
    return confirmed;
}

static NSString *Observe(AXUIElementRef element, AXUIElementRef root, NSDictionary *row,
                         NSString *scope, NSDictionary *node) {
    if (!elements) elements = [NSMutableDictionary dictionary];
    RuyiAutomationRefreshAXBindings();
    if (elements.count >= 2048) {
        NSString *oldest = nil;
        for (NSString *ref in elements)
            if (!oldest || elements[ref].touched < elements[oldest].touched) oldest = ref;
        [elements removeObjectForKey:oldest];
    }
    RuyiAXBinding *binding = [RuyiAXBinding new];
    [binding bindElement:element root:root];
    binding.target = row[@"target"];
    binding.signature = Signature(node);
    binding.scope = scope;
    binding.touched = NSProcessInfo.processInfo.systemUptime;
    NSString *ref = NSUUID.UUID.UUIDString;
    elements[ref] = binding;
    return ref;
}

@interface RuyiAXWalk : NSObject {
@public CFMutableSetRef visited;
}
@property(nonatomic) NSInteger count;
@property(nonatomic) NSInteger maxDepth;
@property(nonatomic) NSInteger maxNodes;
@property(nonatomic) NSInteger maxResults;
@property(nonatomic) NSTimeInterval deadline;
@property(nonatomic, strong) NSDictionary *request;
@property(nonatomic, strong) NSDictionary *row;
@property(nonatomic, strong) NSDictionary *failure;
@property(nonatomic, strong) NSMutableArray *matches;
@property(nonatomic, strong) NSMutableSet *truncatedBy;
@end
@implementation RuyiAXWalk
- (instancetype)init {
    self = [super init];
    if (self) {
        visited = CFSetCreateMutable(NULL, 0, &kCFTypeSetCallBacks);
        _matches = [NSMutableArray array];
        _truncatedBy = [NSMutableSet set];
    }
    return self;
}
- (void)dealloc { CFRelease(visited); }
@end

static BOOL Matches(NSDictionary *node, NSDictionary *request, BOOL checkVisibility) {
    for (NSString *key in @[@"name", @"control_type", @"automation_id"]) {
        NSString *needle = request[key];
        if (!needle.length) continue;
        NSString *value = node[[key isEqual:@"control_type"] ? @"type" : key] ?: @"";
        if ([key isEqual:@"automation_id"] ? ![value isEqual:needle] :
            [value rangeOfString:needle options:NSCaseInsensitiveSearch].location == NSNotFound) return NO;
    }
    return !(checkVisibility && [request[@"visible_only"] boolValue] && ![node[@"visibility"] isEqual:@"confirmed"]) &&
        !([request[@"enabled_only"] boolValue] && ![node[@"enabled"] boolValue]);
}

static NSMutableDictionary *Walk(RuyiAXWalk *walk, AXUIElementRef element, AXUIElementRef root, NSInteger depth, CGRect clip) {
    if (walk.failure) return nil;
    if (walk.count >= walk.maxNodes) { [walk.truncatedBy addObject:@"max_nodes"]; return nil; }
    if (CFSetContainsValue(walk->visited, element)) { [walk.truncatedBy addObject:@"cycle"]; return nil; }
    CFSetAddValue(walk->visited, element);
    walk.count++;
    if (walk.count % 16 == 0) RuyiAutomationRunBriefly();
    NSDictionary *failure = nil;
    NSMutableDictionary *node = [ReadNode(element, [walk.row[@"pid"] intValue], walk.deadline, &failure) mutableCopy];
    if (!node) { walk.failure = failure; return nil; }
    ApplyClip(node, clip);
    if ([walk.request[@"visible_only"] boolValue] && ![node[@"offscreen"] boolValue] && Matches(node, walk.request, NO)) {
        BOOL visible = VisibleHit(element, root, walk.row, walk.request[@"scope"], node, walk.deadline, &failure);
        if (failure) { walk.failure = failure; return nil; }
        node[@"visibility"] = visible ? @"confirmed" : @"unconfirmed";
    }
    BOOL finding = [walk.request[@"op"] isEqual:@"ax.find"];
    if (!finding || Matches(node, walk.request, YES)) {
        node[@"element_ref"] = Observe(element, root, walk.row, walk.request[@"scope"], node);
        if (finding) [walk.matches addObject:node];
    }
    if (finding && walk.matches.count >= (NSUInteger)walk.maxResults) {
        [walk.truncatedBy addObject:@"max_results"];
        return node;
    }
    CFIndex count = 0;
    AXError error = AXUIElementGetAttributeValueCount(element, kAXChildrenAttribute, &count);
    if (error == kAXErrorAttributeUnsupported || error == kAXErrorNoValue) return node;
    if (error != kAXErrorSuccess) { walk.failure = AXFailure(error); return nil; }
    if (!count) return node;
    if (depth >= walk.maxDepth) { [walk.truncatedBy addObject:@"max_depth"]; return node; }
    CFIndex limit = MIN(count, walk.maxNodes - walk.count);
    if (limit < count) [walk.truncatedBy addObject:@"max_nodes"];
    if (!limit) return node;
    CFArrayRef children = NULL;
    error = AXUIElementCopyAttributeValues(element, kAXChildrenAttribute, 0, limit, &children);
    if (error != kAXErrorSuccess || !children) {
        if (children) CFRelease(children);
        walk.failure = AXFailure(error == kAXErrorSuccess ? kAXErrorFailure : error);
        return nil;
    }
    NSMutableArray *output = [NSMutableArray array];
    CGRect childClip = clip;
    if ([node[@"type"] isEqual:(__bridge NSString *)kAXScrollAreaRole])
        childClip = node[@"bounds"] ? CGRectIntersection(clip, RuyiAutomationFieldsRect(node[@"bounds"])) : CGRectNull;
    if ([node[@"hidden"] boolValue]) childClip = CGRectNull;
    for (id child in (__bridge NSArray *)children) {
        if (walk.failure || (finding && walk.matches.count >= (NSUInteger)walk.maxResults)) break;
        if (CFGetTypeID((__bridge CFTypeRef)child) != AXUIElementGetTypeID()) {
            [walk.truncatedBy addObject:@"invalid_child"]; continue;
        }
        NSMutableDictionary *value = Walk(walk, (__bridge AXUIElementRef)child, root, depth + 1, childClip);
        if (value && !finding) [output addObject:value];
    }
    CFRelease(children);
    if (output.count) node[@"children"] = output;
    return node;
}

static AXUIElementRef CopyRoot(NSDictionary *row, AXUIElementRef window, NSString *scope, NSDictionary **failure) {
    if ([scope isEqual:@"window"]) return (AXUIElementRef)CFRetain(window);
    AXUIElementRef app = AXUIElementCreateApplication([row[@"pid"] intValue]);
    AXUIElementSetMessagingTimeout(app, 0.1);
    CFTypeRef root = NULL;
    AXError error = AXUIElementCopyAttributeValue(app, kAXMenuBarAttribute, &root);
    CFRelease(app);
    if (!root || CFGetTypeID(root) != AXUIElementGetTypeID()) {
        if (root) CFRelease(root);
        *failure = error == kAXErrorCannotComplete || error == kAXErrorAPIDisabled ? AXFailure(error) :
            RuyiAutomationFailure(@"element_unsupported", @"Application does not expose an accessible menu bar");
        return NULL;
    }
    return (AXUIElementRef)root;
}

static NSDictionary *Membership(AXUIElementRef element, AXUIElementRef root, pid_t pid, NSTimeInterval deadline, CGRect *clip) {
    CFMutableSetRef seen = CFSetCreateMutable(NULL, 0, &kCFTypeSetCallBacks);
    AXUIElementRef current = (AXUIElementRef)CFRetain(element);
    NSDictionary *failure = nil;
    BOOL found = NO;
    for (NSInteger depth = 0; depth < 64; depth++) {
        failure = Guard(deadline);
        if (failure) break;
        pid_t owner = 0;
        AXUIElementSetMessagingTimeout(current, 0.1);
        if (AXUIElementGetPid(current, &owner) != kAXErrorSuccess || owner != pid || CFSetContainsValue(seen, current)) break;
        if (CFEqual(current, root)) { found = YES; break; }
        CFSetAddValue(seen, current);
        CFTypeRef parent = NULL;
        AXError error = AXUIElementCopyAttributeValue(current, kAXParentAttribute, &parent);
        if (error == kAXErrorCannotComplete || error == kAXErrorAPIDisabled) failure = AXFailure(error);
        if (!parent || CFGetTypeID(parent) != AXUIElementGetTypeID()) { if (parent) CFRelease(parent); break; }
        AXUIElementSetMessagingTimeout((AXUIElementRef)parent, 0.1);
        CFIndex count = 0;
        error = AXUIElementGetAttributeValueCount((AXUIElementRef)parent, kAXChildrenAttribute, &count);
        CFArrayRef children = NULL;
        BOOL member = NO;
        if (error == kAXErrorSuccess && count > 0 && count <= 1000) {
            error = AXUIElementCopyAttributeValues((AXUIElementRef)parent, kAXChildrenAttribute, 0, count, &children);
            if (error == kAXErrorSuccess && children)
                member = CFArrayContainsValue(children, CFRangeMake(0, CFArrayGetCount(children)), current);
        }
        if (children) CFRelease(children);
        if (count > 1000) failure = RuyiAutomationFailure(@"accessibility_capacity", @"Cannot verify element membership within the child enumeration limit");
        else if (error == kAXErrorCannotComplete || error == kAXErrorAPIDisabled) failure = AXFailure(error);
        if (!member || failure) { CFRelease(parent); break; }
        if (clip && !CFEqual(parent, root)) {
            NSDictionary *metadata = ReadNode((AXUIElementRef)parent, pid, deadline, &failure);
            if (!metadata) { CFRelease(parent); break; }
            if ([metadata[@"type"] isEqual:(__bridge NSString *)kAXScrollAreaRole])
                *clip = metadata[@"bounds"] ? CGRectIntersection(*clip, RuyiAutomationFieldsRect(metadata[@"bounds"])) : CGRectNull;
            if ([metadata[@"hidden"] boolValue]) *clip = CGRectNull;
        }
        CFRelease(current); current = (AXUIElementRef)parent;
    }
    CFRelease(current); CFRelease(seen);
    return failure ?: Guard(deadline) ?: (found ? nil : RuyiAutomationFailure(@"element_stale", @"Element is no longer a member of its observed tree"));
}

static NSDictionary *Action(NSDictionary *request, NSDictionary *row, AXUIElementRef window, NSTimeInterval deadline) {
    RuyiAutomationRefreshAXBindings();
    RuyiAXBinding *binding = elements[request[@"element_ref"]];
    if (!binding || ![binding.target isEqual:request[@"target"]])
        return RuyiAutomationFailure(@"element_stale", @"Element reference expired, changed target or belongs to another native session");
    NSDictionary *failure = nil;
    AXUIElementRef root = CopyRoot(row, window, binding.scope, &failure);
    if (!root) return failure;
    BOOL sameRoot = CFEqual(root, binding.root);
    CFRelease(root);
    if (!sameRoot) return RuyiAutomationFailure(@"element_stale", @"Element tree identity changed after observation");
    CGRect clip = [binding.scope isEqual:@"window"] ? RuyiAutomationFieldsRect(row[@"target"][@"bounds"]) : CGRectInfinite;
    failure = Membership(binding.element, binding.root, [row[@"pid"] intValue], deadline, &clip);
    if (failure) return failure;
    NSMutableDictionary *node = [ReadNode(binding.element, [row[@"pid"] intValue], deadline, &failure) mutableCopy];
    if (!node) return failure;
    if (![binding.signature isEqual:Signature(node)])
        return RuyiAutomationFailure(@"element_changed", @"Element identity, geometry or state changed. Observe it again");
    if (!RuyiAutomationForegroundMatches(row, window))
        return RuyiAutomationFailure(@"focus_changed", @"Focus the exact observed window before invoking its elements");
    ApplyClip(node, clip);
    BOOL visible = VisibleHit(binding.element, binding.root, row, binding.scope, node, deadline, &failure);
    if (failure) return failure;
    if ((node[@"enabled"] && ![node[@"enabled"] boolValue]) || !visible)
        return RuyiAutomationFailure(@"element_not_actionable", @"Element must be enabled and confirmed visible within its current ancestor clip");
    node[@"visibility"] = @"confirmed";
    NSString *action = request[@"action"];
    CFStringRef attribute = NULL;
    CFTypeRef value = NULL;
    if ([action isEqual:@"set_value"]) { attribute = kAXValueAttribute; value = (__bridge CFStringRef)request[@"text"]; }
    if ([action isEqual:@"focus"]) { attribute = kAXFocusedAttribute; value = kCFBooleanTrue; }
    if ([action isEqual:@"expand"] || [action isEqual:@"collapse"]) {
        attribute = kAXExpandedAttribute; value = [action isEqual:@"expand"] ? kCFBooleanTrue : kCFBooleanFalse;
    }
    AXError error;
    if (attribute) {
        Boolean settable = false;
        error = AXUIElementIsAttributeSettable(binding.element, attribute, &settable);
        if (error == kAXErrorAPIDisabled) return AXFailure(error);
        if (error != kAXErrorSuccess || !settable)
            return RuyiAutomationFailure(@"element_unsupported", @"Requested attribute is not settable on this element");
    } else if (![node[@"actions"] containsObject:(__bridge NSString *)kAXPressAction])
        return RuyiAutomationFailure(@"element_unsupported", @"Element does not support AXPress");
    BOOL writableText = [@[(__bridge NSString *)kAXTextAreaRole, (__bridge NSString *)kAXTextFieldRole] containsObject:node[@"type"]]
        && [node[@"value_settable"] boolValue];
    if (!node[@"enabled"] && !([action isEqual:@"focus"] || ([action isEqual:@"set_value"] && writableText)))
        return RuyiAutomationFailure(@"element_not_actionable", @"Provider does not confirm the state required by this action");
    if ([action isEqual:@"set_value"] && node[@"editable"] && ![node[@"editable"] boolValue])
        return RuyiAutomationFailure(@"element_not_actionable", @"Text element is read-only");
    id previous = nil;
    if ([action isEqual:@"toggle"]) {
        if (![@[(__bridge NSString *)kAXCheckBoxRole, @"AXSwitch"] containsObject:node[@"type"]])
            return RuyiAutomationFailure(@"element_unsupported", @"Toggle requires an accessible checkbox or switch");
        previous = CFBridgingRelease(RuyiAutomationCopyAttribute(binding.element, kAXValueAttribute));
        if (![previous isKindOfClass:NSNumber.class] || ![@[@0, @1] containsObject:previous])
            return RuyiAutomationFailure(@"element_unsupported", @"Cannot read a binary toggle state before the action");
    }
    failure = Guard(deadline);
    if (failure) return failure;
    NSDictionary *current = RuyiAutomationCheckTarget(row[@"target"]);
    if (current[@"error"]) return current;
    if (!RuyiAutomationForegroundMatches(current, window))
        return RuyiAutomationFailure(@"focus_changed", @"Window focus changed before the accessibility action");
    failure = Guard(deadline);
    if (failure) return failure;
    // AppKit button presses include a short animation before returning. Reads
    // remain at 100 ms, while one action may use the remaining bounded budget.
    AXUIElementSetMessagingTimeout(binding.element, MIN(0.75, deadline - NSProcessInfo.processInfo.systemUptime));
    error = attribute ? AXUIElementSetAttributeValue(binding.element, attribute, value) :
        AXUIElementPerformAction(binding.element, kAXPressAction);
    AXUIElementSetMessagingTimeout(binding.element, 0.1);
    NSMutableDictionary *out = [@{@"ok":@YES, @"protocolVersion":@1, @"acted":@YES, @"action_sent":@YES,
        @"control":node, @"verification":@"accessibility_action_accepted", @"confirmed":NSNull.null,
        @"outcome":@"unconfirmed"} mutableCopy];
    if (error != kAXErrorSuccess) [out addEntriesFromDictionary:AXFailure(error)];
    failure = Guard(deadline);
    if (!failure && [out[@"ok"] boolValue]) {
        current = RuyiAutomationCheckTarget(row[@"target"]);
        if (current[@"error"]) failure = current;
        else if (!RuyiAutomationForegroundMatches(current, window))
            failure = RuyiAutomationFailure(@"focus_changed", @"Window focus changed after the accessibility action");
    }
    if (failure) [out addEntriesFromDictionary:failure];
    if ([out[@"ok"] boolValue] && (attribute || previous)) {
        CFStringRef verifiedAttribute = attribute ?: kAXValueAttribute;
        id expected = previous ? @(![previous boolValue]) : (__bridge id)value;
        id actual = CFBridgingRelease(RuyiAutomationCopyAttribute(binding.element, verifiedAttribute));
        BOOL confirmed = actual && [actual isEqual:expected];
        out[@"confirmed"] = @(confirmed);
        if (confirmed) { out[@"verification"] = @"attribute_readback"; [out removeObjectForKey:@"outcome"]; }
        else [out addEntriesFromDictionary:RuyiAutomationFailure(@"element_action_unconfirmed", @"Action was sent but its attribute readback did not match")];
    }
    failure = Guard(deadline);
    if (failure) { [out addEntriesFromDictionary:failure]; out[@"outcome"] = @"unconfirmed"; }
    binding.touched = NSProcessInfo.processInfo.systemUptime;
    return out;
}

NSDictionary *RuyiAutomationAXRequest(NSDictionary *request) {
    NSString *op = request[@"op"];
    BOOL acting = [op isEqual:@"ax.invoke"], finding = [op isEqual:@"ax.find"];
    if (!acting && !finding && ![op isEqual:@"ax.inspect"])
        return RuyiAutomationFailure(@"invalid_args", @"Unsupported accessibility operation");
    NSMutableSet *keys = [NSMutableSet setWithArray:@[@"version", @"op", @"target"]];
    [keys addObjectsFromArray:acting ? @[@"element_ref", @"action", @"text"] : @[@"scope", @"max_depth", @"max_nodes"]];
    if (finding) [keys addObjectsFromArray:@[@"name", @"control_type", @"automation_id", @"max_results", @"visible_only", @"enabled_only"]];
    for (NSString *key in request)
        if (![keys containsObject:key]) return RuyiAutomationFailure(@"invalid_args", @"Unexpected accessibility request field");
    if (acting) {
        if (![request[@"element_ref"] isKindOfClass:NSString.class] || ![request[@"element_ref"] length] || [request[@"element_ref"] length] > 128 ||
            ![@[@"invoke", @"click", @"set_value", @"focus", @"toggle", @"expand", @"collapse"] containsObject:request[@"action"]] ||
            ![request[@"text"] isKindOfClass:NSString.class] || [request[@"text"] lengthOfBytesUsingEncoding:NSUTF8StringEncoding] > 48000 ||
            [request[@"text"] rangeOfCharacterFromSet:[NSCharacterSet characterSetWithRange:NSMakeRange(0, 1)]].location != NSNotFound)
            return RuyiAutomationFailure(@"invalid_args", @"Pass an observed element reference, supported action and bounded text");
    } else {
        if (![@[@"window", @"menu_bar"] containsObject:request[@"scope"]] || !Integer(request[@"max_depth"], 0, 20) ||
            !Integer(request[@"max_nodes"], 1, 1000))
            return RuyiAutomationFailure(@"invalid_args", @"Accessibility queries require scope window/menu_bar, depth 0..20 and nodes 1..1000");
        if (finding) {
            if (!Integer(request[@"max_results"], 1, 100) || !IsBoolean(request[@"visible_only"]) || !IsBoolean(request[@"enabled_only"]))
                return RuyiAutomationFailure(@"invalid_args", @"Pass bounded result count and boolean state filters");
            for (NSString *key in @[@"name", @"control_type", @"automation_id"])
                if (![request[key] isKindOfClass:NSString.class] || [request[key] length] > 2048)
                    return RuyiAutomationFailure(@"invalid_args", @"Selectors must be strings of at most 2048 characters");
        }
    }
    NSTimeInterval deadline = NSProcessInfo.processInfo.systemUptime + 4;
    NSDictionary *failure = Guard(deadline);
    if (failure) return failure;
    NSDictionary *row = RuyiAutomationCheckTarget(request[@"target"]);
    if (row[@"error"]) return row;
    AXUIElementRef window = RuyiAutomationCopyTargetWindow(row, &failure);
    if (!window) return failure;
    NSDictionary *result;
    AXUIElementRef root = NULL;
    @try {
        if (acting) result = Action(request, row, window, deadline);
        else {
            root = CopyRoot(row, window, request[@"scope"], &failure);
            if (!root) return failure;
            RuyiAXWalk *walk = [RuyiAXWalk new];
            walk.deadline = deadline; walk.maxDepth = [request[@"max_depth"] integerValue];
            walk.maxNodes = [request[@"max_nodes"] integerValue]; walk.maxResults = [request[@"max_results"] integerValue];
            walk.request = request; walk.row = row;
            CGRect clip = [request[@"scope"] isEqual:@"window"] ? RuyiAutomationFieldsRect(row[@"target"][@"bounds"]) : CGRectInfinite;
            NSDictionary *tree = Walk(walk, root, root, 0, clip);
            if (walk.failure) return walk.failure;
            failure = Guard(deadline);
            if (failure) return failure;
            NSDictionary *current = RuyiAutomationCheckTarget(row[@"target"]);
            if (current[@"error"]) return current;
            NSMutableDictionary *out = [@{@"ok":@YES, @"protocolVersion":@1, @"success":@YES,
                @"window":row, @"scope":request[@"scope"], @"nodes_scanned":@(walk.count),
                @"truncated":@(walk.truncatedBy.count > 0), @"truncated_by":[walk.truncatedBy.allObjects sortedArrayUsingSelector:@selector(compare:)],
                @"coordinate_space":@"macos_global_points", @"element_ttl_seconds":@60} mutableCopy];
            if (finding) { out[@"matches"] = walk.matches; out[@"count"] = @(walk.matches.count); }
            else { out[@"tree"] = tree ?: @{}; out[@"nodes"] = @(walk.count); }
            if (walk.count == 1 && walk.maxDepth > 0 && !walk.truncatedBy.count)
                out[@"accessibility_limited"] = @YES;
            result = out;
        }
    } @finally {
        if (root) CFRelease(root);
        CFRelease(window);
    }
    return result;
}

#ifdef RUYI_AUTOMATION_TESTING
NSDictionary *RuyiAutomationTestAXState(NSDictionary *request) {
    NSDictionary *listing = RuyiAutomationInputRequest(@{@"version":@1, @"op":@"window.list"});
    NSDictionary *row = nil;
    for (NSDictionary *candidate in listing[@"windows"])
        if ([candidate[@"pid"] isEqual:request[@"pid"]] && [candidate[@"handle"] isEqual:request[@"handle"]]) row = candidate;
    if (!row) return RuyiAutomationFailure(@"fixture_missing", @"Controlled AX state test window was not observed");
    AXUIElementRef app = AXUIElementCreateApplication([row[@"pid"] intValue]);
    NSDictionary *node = @{@"type":@"AXGroup", @"name":@"memory-only fixture"};
    NSString *old = Observe(app, app, row, @"window", node);
    elements[old].touched = NSProcessInfo.processInfo.systemUptime - 61;
    RuyiAutomationRefreshAXBindings();
    BOOL expired = elements[old] == nil;
    NSString *first = Observe(app, app, row, @"window", node);
    for (NSInteger i = 0; i < 2048; i++) Observe(app, app, row, @"window", node);
    BOOL bounded = elements.count == 2048 && elements[first] == nil;
    BOOL retained = ReadinessFailure(NO, YES) == nil && elements.count == 2048;
    NSDictionary *denied = ReadinessFailure(NO, NO);
    BOOL deniedReset = [denied[@"code"] isEqual:@"permission_denied"] && elements.count == 0 &&
        [RuyiAutomationCheckTarget(row[@"target"])[@"code"] isEqual:@"target_stale"];
    NSDictionary *freshListing = RuyiAutomationInputRequest(@{@"version":@1, @"op":@"window.list"});
    NSDictionary *fresh = nil;
    for (NSDictionary *candidate in freshListing[@"windows"])
        if ([candidate[@"pid"] isEqual:row[@"pid"]] && [candidate[@"handle"] isEqual:row[@"handle"]]) fresh = candidate;
    NSString *newRef = fresh ? Observe(app, app, fresh, @"window", node) : nil;
    BOOL recovered = fresh && ![fresh[@"target"][@"ref"] isEqual:row[@"target"][@"ref"]] &&
        newRef && ![newRef isEqual:first] && elements[first] == nil;
    NSDictionary *locked = ReadinessFailure(YES, YES);
    BOOL lockedReset = [locked[@"code"] isEqual:@"session_locked"] && elements.count == 0 &&
        [RuyiAutomationCheckTarget(fresh[@"target"])[@"code"] isEqual:@"target_stale"];
    Observe(app, app, row, @"window", node);
    NSDictionary *providerDenied = AXFailure(kAXErrorAPIDisabled);
    BOOL providerReset = [providerDenied[@"code"] isEqual:@"permission_denied"] && elements.count == 0;
    CFRelease(app);
    return @{@"ok":@YES, @"protocolVersion":@1, @"expired":@(expired), @"bounded":@(bounded), @"retained":@(retained),
        @"denied_reset":@(deniedReset), @"locked_reset":@(lockedReset), @"provider_reset":@(providerReset),
        @"fresh_after_recovery":@(recovered)};
}
#endif
