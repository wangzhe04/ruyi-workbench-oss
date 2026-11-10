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
