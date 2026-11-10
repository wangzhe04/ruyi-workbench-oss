#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>

NSDictionary *RuyiAutomationFailure(NSString *code, NSString *message);
NSDictionary *RuyiAutomationRectFields(CGRect rect);
CGRect RuyiAutomationFieldsRect(NSDictionary *value);
BOOL RuyiAutomationLocked(void);
NSArray *RuyiAutomationDisplays(void);
NSDictionary *RuyiAutomationEncodeImage(CGImageRef image, BOOL rejectBlank);
NSDictionary *RuyiAutomationInputStatus(void);
NSDictionary *RuyiAutomationInputRequest(NSDictionary *request);
void RuyiAutomationRefreshInputBindings(void);
void RuyiAutomationResetInputBindings(void);
int RuyiAutomationRunInputSession(void);
NSString *RuyiAutomationProcessIdentity(pid_t pid);
CFTypeRef RuyiAutomationCopyAttribute(AXUIElementRef element, CFStringRef attribute);
NSDictionary *RuyiAutomationCheckTarget(NSDictionary *target);
AXUIElementRef RuyiAutomationCopyTargetWindow(NSDictionary *row, NSDictionary **failure);
BOOL RuyiAutomationForegroundMatches(NSDictionary *row, AXUIElementRef expected);
NSDictionary *RuyiAutomationPointGuard(NSDictionary *row, AXUIElementRef window, CGPoint point);
BOOL RuyiAutomationFiniteNumber(id value);
void RuyiAutomationRunBriefly(void);
NSArray *RuyiAutomationSnapshotClipboard(NSPasteboard *board, NSInteger *version);
NSDictionary *RuyiAutomationWriteClipboard(NSPasteboard *board, NSArray *objects, NSArray **previous);
NSString *RuyiAutomationRestoreClipboard(NSPasteboard *board, NSArray *previous, NSInteger expected);
NSDictionary *RuyiAutomationEventsRequest(NSDictionary *request);
void RuyiAutomationReleaseEvents(void);
void RuyiAutomationStopEvents(void);
BOOL RuyiAutomationEventsStopping(void);
BOOL RuyiAutomationTrackClipboard(NSArray *previous, NSInteger expected);
void RuyiAutomationUpdateClipboardVersion(NSInteger expected);
void RuyiAutomationFinishClipboardWrite(void);
NSString *RuyiAutomationRestorePendingClipboard(void);
#ifdef RUYI_AUTOMATION_TESTING
NSDictionary *RuyiAutomationTestInputState(void);
NSDictionary *RuyiAutomationTestBlockedClipboard(NSDictionary *request);
#endif
