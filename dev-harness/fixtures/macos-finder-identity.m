// Read-only ownership verifier for the selected Finder scenario. Never sends AX actions.
#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>

static id Attribute(AXUIElementRef element, CFStringRef name, BOOL optional) {
    CFTypeRef value = NULL;
    AXError error = AXUIElementCopyAttributeValue(element, name, &value);
    if (error == kAXErrorSuccess && value) return CFBridgingRelease(value);
    if (value) CFRelease(value);
    if (optional && (error == kAXErrorAttributeUnsupported || error == kAXErrorNoValue)) return NSNull.null;
    if (optional && error == kAXErrorFailure && (CFEqual(name, kAXTitleAttribute) || CFEqual(name, kAXDescriptionAttribute)))
        return NSNull.null;
    @throw [NSException exceptionWithName:@"AXObservation" reason:[NSString stringWithFormat:@"Attribute %@ error %d", name, error] userInfo:nil];
}

static NSDictionary *Tree(AXUIElementRef element, NSUInteger depth, NSUInteger *count) {
    if (depth > 20 || ++*count > 1000)
        @throw [NSException exceptionWithName:@"AXCapacity" reason:@"Finder ownership tree exceeds its limit" userInfo:nil];
    AXUIElementSetMessagingTimeout(element, 0.1);
    NSMutableDictionary *node = [NSMutableDictionary dictionary];
    id role = Attribute(element, kAXRoleAttribute, NO);
    if (![role isKindOfClass:NSString.class] || ![role length] || [role length] > 2048)
        @throw [NSException exceptionWithName:@"AXObservation" reason:@"Finder node role is missing or invalid" userInfo:nil];
    node[@"AXRole"] = role;
    for (NSString *name in @[@"AXTitle", @"AXDescription"]) {
        id value = Attribute(element, (__bridge CFStringRef)name, YES);
        if ([value isKindOfClass:NSString.class] && [value length] <= 2048) node[name] = value;
    }
    id tabs = Attribute(element, kAXTabsAttribute, YES);
    if (tabs != NSNull.null && ![tabs isKindOfClass:NSArray.class])
        @throw [NSException exceptionWithName:@"AXObservation" reason:@"Finder tabs are not an array" userInfo:nil];
    if ([tabs isKindOfClass:NSArray.class]) node[@"tabCount"] = @([tabs count]);
    id url = Attribute(element, kAXURLAttribute, YES);
    NSURL *location = [url isKindOfClass:NSURL.class] ? url :
        ([url isKindOfClass:NSString.class] ? [NSURL URLWithString:url] : nil);
    if (location.isFileURL) node[@"url"] = location.filePathURL.URLByResolvingSymlinksInPath.absoluteString;
    if ([role isEqual:@"AXRadioButton"]) {
        id value = Attribute(element, kAXValueAttribute, NO);
        if ([value isKindOfClass:NSNumber.class]) node[@"selectedValue"] = value;
    }
    if ([role isEqual:@"AXTextField"] || [role isEqual:@"AXStaticText"]) {
        id value = Attribute(element, kAXValueAttribute, YES);
        if ([value isKindOfClass:NSString.class] && [value length] <= 2048) node[@"text"] = value;
    }
    id children = Attribute(element, kAXChildrenAttribute, YES);
    if (children != NSNull.null && ![children isKindOfClass:NSArray.class])
        @throw [NSException exceptionWithName:@"AXObservation" reason:@"Finder children are not an array" userInfo:nil];
    if ([children isKindOfClass:NSArray.class]) {
        NSMutableArray *output = [NSMutableArray array];
        for (id child in children) {
            if (CFGetTypeID((__bridge CFTypeRef)child) != AXUIElementGetTypeID())
                @throw [NSException exceptionWithName:@"AXObservation" reason:@"Invalid Finder child" userInfo:nil];
            [output addObject:Tree((__bridge AXUIElementRef)child, depth + 1, count)];
        }
        node[@"children"] = output;
    }
    return node;
}

int main(void) {
    @autoreleasepool {
        NSMutableDictionary *out = [NSMutableDictionary dictionary];
        AXUIElementRef app = NULL;
        @try {
            NSArray *apps = [NSRunningApplication runningApplicationsWithBundleIdentifier:@"com.apple.finder"];
            if (apps.count != 1)
                @throw [NSException exceptionWithName:@"FinderIdentity" reason:@"Expected exactly one running Finder" userInfo:nil];
            NSRunningApplication *finder = apps[0];
            out[@"pid"] = @(finder.processIdentifier);
            out[@"bundleID"] = finder.bundleIdentifier;
            NSDictionary *info = [NSBundle bundleWithURL:finder.bundleURL].infoDictionary;
            out[@"applicationVersion"] = info[@"CFBundleShortVersionString"] ?: NSNull.null;
            out[@"applicationBuild"] = info[@"CFBundleVersion"] ?: NSNull.null;
            app = AXUIElementCreateApplication(finder.processIdentifier);
            AXUIElementSetMessagingTimeout(app, 0.5);
            id windows = Attribute(app, kAXWindowsAttribute, NO);
            if (![windows isKindOfClass:NSArray.class])
                @throw [NSException exceptionWithName:@"AXObservation" reason:@"Finder AXWindows is not an array" userInfo:nil];
            NSMutableArray *axWindows = [NSMutableArray array];
            for (id item in windows) {
                AXUIElementRef window = (__bridge AXUIElementRef)item;
                if (CFGetTypeID(window) != AXUIElementGetTypeID())
                    @throw [NSException exceptionWithName:@"AXObservation" reason:@"Invalid Finder window" userInfo:nil];
                id role = Attribute(window, kAXRoleAttribute, NO);
                NSUInteger count = 0;
                CFArrayRef names = NULL;
                AXUIElementCopyAttributeNames(window, &names);
                id proxy = Attribute(window, kAXProxyAttribute, YES);
                [axWindows addObject:@{@"document":Attribute(window, kAXDocumentAttribute, YES), @"role":role,
                    @"attributes":names ? CFBridgingRelease(names) : @[],
                    @"proxy":proxy != NSNull.null && CFGetTypeID((__bridge CFTypeRef)proxy) == AXUIElementGetTypeID() ?
                        Tree((__bridge AXUIElementRef)proxy, 0, &count) : @{},
                    @"tree":[role isEqual:@"AXWindow"] ? Tree(window, 0, &count) : @{@"AXRole":role}}];
            }
            out[@"windows"] = axWindows;
            CFArrayRef copied = CGWindowListCopyWindowInfo(kCGWindowListOptionAll, kCGNullWindowID);
            if (!copied)
                @throw [NSException exceptionWithName:@"CGObservation" reason:@"Cannot enumerate all WindowServer windows" userInfo:nil];
            NSArray *allWindows = CFBridgingRelease(copied);
            NSMutableArray *cgWindows = [NSMutableArray array];
            for (NSDictionary *row in allWindows) {
                if ([row[(__bridge NSString *)kCGWindowOwnerPID] intValue] != finder.processIdentifier ||
                    [row[(__bridge NSString *)kCGWindowLayer] intValue] != 0) continue;
                [cgWindows addObject:@{@"handle":row[(__bridge NSString *)kCGWindowNumber],
                    @"title":row[(__bridge NSString *)kCGWindowName] ?: NSNull.null,
                    @"bounds":row[(__bridge NSString *)kCGWindowBounds],
                    @"onScreen":row[(__bridge NSString *)kCGWindowIsOnscreen] ?: @NO}];
            }
            out[@"cgWindows"] = cgWindows;
            out[@"ok"] = @YES;
        } @catch (NSException *exception) {
            out[@"ok"] = @NO;
            out[@"error"] = exception.reason ?: exception.name;
        } @finally {
            if (app) CFRelease(app);
        }
        NSData *data = [NSJSONSerialization dataWithJSONObject:out options:0 error:nil];
        puts([[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding].UTF8String);
        return [out[@"ok"] boolValue] ? 0 : 1;
    }
}
