// One owned input worker per MCP session. JSONL requests are strictly serialized and bounded.
#import "macos-automation.h"
#include <unistd.h>
#include <signal.h>

static BOOL frameActive;
static int stopSignal;

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
    // A run-loop block permits bounded AppKit waits to service asynchronous
    // LaunchServices completions and stop signals on the main dispatch queue.
    CFRunLoopPerformBlock(CFRunLoopGetMain(), kCFRunLoopDefaultMode, ^{
        @autoreleasepool {
            frameActive = YES;
            NSDictionary *result;
            if (valid) {
                NSMutableDictionary *payload = [request mutableCopy]; [payload removeObjectForKey:@"id"];
                result = RuyiAutomationInputRequest(payload);
            } else result = RuyiAutomationFailure(@"invalid_args", @"Invalid native session request envelope");
            NSMutableDictionary *response = [result mutableCopy]; response[@"id"] = identifier ?: @0;
            NSData *encoded = [NSJSONSerialization dataWithJSONObject:response options:NSJSONWritingSortedKeys error:nil];
            [NSFileHandle.fileHandleWithStandardOutput writeData:encoded];
            [NSFileHandle.fileHandleWithStandardOutput writeData:[@"\n" dataUsingEncoding:NSUTF8StringEncoding]];
            frameActive = NO;
            dispatch_semaphore_signal(finished);
            if (stopSignal) exit(128 + stopSignal);
        }
    });
    CFRunLoopWakeUp(CFRunLoopGetMain());
    // This deadline belongs to this frame, including a blocked AX call or output consumer.
    // It is not a timer left behind in the persistent worker's run loop.
    if (dispatch_semaphore_wait(finished, dispatch_time(DISPATCH_TIME_NOW, 12 * NSEC_PER_SEC)) != 0) {
        RuyiAutomationStopEvents();
        dispatch_group_t cleanup = dispatch_group_create();
        dispatch_group_async(cleanup, dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
            NSTimeInterval deadline = NSProcessInfo.processInfo.systemUptime + 0.45;
            while ([RuyiAutomationRestorePendingClipboard() isEqual:@"pending"] && NSProcessInfo.processInfo.systemUptime < deadline)
                [NSThread sleepForTimeInterval:0.01];
        });
        dispatch_group_wait(cleanup, dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC / 2));
        _exit(70);
    }
}

int RuyiAutomationRunInputSession(void) {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    NSMutableArray *signals = [NSMutableArray array];
    for (NSNumber *value in @[@(SIGTERM), @(SIGINT)]) {
        int number = value.intValue; signal(number, SIG_IGN);
        dispatch_source_t observer = dispatch_source_create(DISPATCH_SOURCE_TYPE_SIGNAL, number, 0, dispatch_get_main_queue());
        dispatch_source_set_event_handler(observer, ^{
            stopSignal = number; RuyiAutomationStopEvents();
            if (!frameActive) { RuyiAutomationRestorePendingClipboard(); RuyiAutomationResetInputBindings(); exit(128 + number); }
        });
        dispatch_resume(observer); [signals addObject:observer];
    }
    [NSTimer scheduledTimerWithTimeInterval:1 repeats:YES block:^(NSTimer *timer) {
        (void)timer; RuyiAutomationRefreshInputBindings(); RuyiAutomationRefreshRecording();
    }];
    [NSWorkspace.sharedWorkspace.notificationCenter addObserverForName:NSWorkspaceSessionDidResignActiveNotification
        object:nil queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *note) {
            (void)note; RuyiAutomationEndRecording(@"session_locked");
            RuyiAutomationReleaseEvents(); RuyiAutomationResetInputBindings();
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
                    if (line.length > 65536) { RuyiAutomationStopEvents(); _exit(65); }
                }
            }
        }
        dispatch_async(dispatch_get_main_queue(), ^{ RuyiAutomationStopEvents(); RuyiAutomationResetInputBindings(); exit(0); });
    });
    [NSApp run];
    (void)signals;
    return 0;
}
