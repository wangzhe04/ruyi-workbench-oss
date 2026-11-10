// One owned input worker per MCP session. JSONL requests are strictly serialized and bounded.
#import "macos-automation.h"
#include <unistd.h>

static void HandleFrame(NSData *data) {
    id request = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
    NSNumber *identifier = [request isKindOfClass:NSDictionary.class] ? request[@"id"] : nil;
    BOOL valid = [identifier isKindOfClass:NSNumber.class]
        && CFGetTypeID((__bridge CFTypeRef)identifier) != CFBooleanGetTypeID()
        && [identifier doubleValue] >= 1 && [identifier doubleValue] <= 9007199254740991.0
        && [identifier doubleValue] == trunc([identifier doubleValue])
        && [request[@"version"] isKindOfClass:NSNumber.class]
        && CFGetTypeID((__bridge CFTypeRef)request[@"version"]) != CFBooleanGetTypeID()
        && [request[@"version"] isEqual:@1] && [request[@"op"] isKindOfClass:NSString.class];
    dispatch_semaphore_t finished = dispatch_semaphore_create(0);
    dispatch_async(dispatch_get_main_queue(), ^{
        @autoreleasepool {
            NSDictionary *result;
            if (valid) {
                NSMutableDictionary *payload = [request mutableCopy]; [payload removeObjectForKey:@"id"];
                result = RuyiAutomationInputRequest(payload);
            } else result = RuyiAutomationFailure(@"invalid_args", @"Invalid native session request envelope");
            NSMutableDictionary *response = [result mutableCopy]; response[@"id"] = identifier ?: @0;
            NSData *encoded = [NSJSONSerialization dataWithJSONObject:response options:NSJSONWritingSortedKeys error:nil];
            [NSFileHandle.fileHandleWithStandardOutput writeData:encoded];
            [NSFileHandle.fileHandleWithStandardOutput writeData:[@"\n" dataUsingEncoding:NSUTF8StringEncoding]];
            dispatch_semaphore_signal(finished);
        }
    });
    // This deadline belongs to this frame, including a blocked AX call or output consumer.
    // It is not a timer left behind in the persistent worker's run loop.
    if (dispatch_semaphore_wait(finished, dispatch_time(DISPATCH_TIME_NOW, 12 * NSEC_PER_SEC)) != 0) _exit(70);
}

int RuyiAutomationRunInputSession(void) {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSTimer scheduledTimerWithTimeInterval:1 repeats:YES block:^(NSTimer *timer) {
        (void)timer; RuyiAutomationRefreshInputBindings();
    }];
    [NSWorkspace.sharedWorkspace.notificationCenter addObserverForName:NSWorkspaceSessionDidResignActiveNotification
        object:nil queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *note) {
            (void)note; RuyiAutomationResetInputBindings();
        }];
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
        NSMutableData *line = [NSMutableData data];
        uint8_t buffer[4096]; ssize_t count;
        while ((count = read(STDIN_FILENO, buffer, sizeof(buffer))) > 0) {
            for (ssize_t i = 0; i < count; i++) {
                if (buffer[i] == '\n') {
                    if (line.length) HandleFrame(line);
                    [line setLength:0];
                } else {
                    [line appendBytes:buffer + i length:1];
                    if (line.length > 65536) _exit(65);
                }
            }
        }
        dispatch_async(dispatch_get_main_queue(), ^{ RuyiAutomationResetInputBindings(); exit(0); });
    });
    [NSApp run];
    return 0;
}
