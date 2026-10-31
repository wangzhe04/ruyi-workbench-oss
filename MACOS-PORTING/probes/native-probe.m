// P0 fallback for a mismatched Swift SDK. No screenshots, input, TCC prompts or login secrets.
#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>
#import <WebKit/WebKit.h>
#import <Security/Security.h>
#import <ApplicationServices/ApplicationServices.h>
#import <AVFoundation/AVFoundation.h>
#import <Vision/Vision.h>

static void Emit(NSDictionary *value) {
    NSData *data = [NSJSONSerialization dataWithJSONObject:value options:NSJSONWritingSortedKeys error:nil];
    puts([[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding].UTF8String);
    fflush(stdout);
}

static NSDictionary *KeychainProbe(void) {
    NSString *dir = [NSTemporaryDirectory() stringByAppendingPathComponent:[@"ruyi-p0-keychain-" stringByAppendingString:NSUUID.UUID.UUIDString]];
    if (![NSFileManager.defaultManager createDirectoryAtPath:dir withIntermediateDirectories:NO attributes:@{NSFilePosixPermissions:@0700} error:nil])
        return @{@"ok":@NO, @"error":@"temporary_directory"};
    Boolean original = false;
    OSStatus getUI = SecKeychainGetUserInteractionAllowed(&original);
    OSStatus setUI = getUI == errSecSuccess ? SecKeychainSetUserInteractionAllowed(false) : getUI;
    if (getUI || setUI) return @{@"ok":@NO, @"error":@"cannot_disable_interaction"};
    NSString *password = NSUUID.UUID.UUIDString;
    SecKeychainRef kc = NULL;
    OSStatus create = SecKeychainCreate([[dir stringByAppendingPathComponent:@"probe.keychain"] fileSystemRepresentation],
        (UInt32)[password lengthOfBytesUsingEncoding:NSUTF8StringEncoding], password.UTF8String, false, NULL, &kc);
    NSMutableDictionary *out = [@{@"scope":@"disposable_file_keychain", @"createStatus":@(create), @"ok":@NO} mutableCopy];
    if (create == errSecSuccess && kc) {
        NSData *firstValue = [NSUUID.UUID.UUIDString dataUsingEncoding:NSUTF8StringEncoding];
        NSData *nextValue = [NSUUID.UUID.UUIDString dataUsingEncoding:NSUTF8StringEncoding];
        NSDictionary *query = @{(__bridge id)kSecClass:(__bridge id)kSecClassGenericPassword,
            (__bridge id)kSecAttrService:@"ruyi.p0.disposable", (__bridge id)kSecAttrAccount:@"probe",
            (__bridge id)kSecMatchSearchList:@[(__bridge id)kc]};
        NSMutableDictionary *add = [query mutableCopy];
        [add removeObjectForKey:(__bridge id)kSecMatchSearchList];
        add[(__bridge id)kSecUseKeychain] = (__bridge id)kc;
        add[(__bridge id)kSecValueData] = firstValue;
        OSStatus added = SecItemAdd((__bridge CFDictionaryRef)add, NULL);
        NSMutableDictionary *read = [query mutableCopy];
        read[(__bridge id)kSecReturnData] = @YES;
        read[(__bridge id)kSecMatchLimit] = (__bridge id)kSecMatchLimitOne;
        CFTypeRef first = NULL, second = NULL;
        OSStatus read1 = SecItemCopyMatching((__bridge CFDictionaryRef)read, &first);
        BOOL firstMatches = first && [(__bridge NSData *)first isEqualToData:firstValue];
        OSStatus updated = SecItemUpdate((__bridge CFDictionaryRef)query, (__bridge CFDictionaryRef)@{(__bridge id)kSecValueData:nextValue});
        OSStatus read2 = SecItemCopyMatching((__bridge CFDictionaryRef)read, &second);
        BOOL nextMatches = second && [(__bridge NSData *)second isEqualToData:nextValue];
        OSStatus deleted = SecItemDelete((__bridge CFDictionaryRef)query);
        CFTypeRef missingValue = NULL;
        OSStatus missing = SecItemCopyMatching((__bridge CFDictionaryRef)read, &missingValue);
        if (first) CFRelease(first);
        if (second) CFRelease(second);
        if (missingValue) CFRelease(missingValue);
        OSStatus cleanup = SecKeychainDelete(kc);
        CFRelease(kc);
        [out addEntriesFromDictionary:@{@"addStatus":@(added), @"readStatus":@(read1), @"readMatches":@(firstMatches),
            @"updateStatus":@(updated), @"secondReadStatus":@(read2), @"updatedMatches":@(nextMatches),
            @"deleteStatus":@(deleted), @"missingStatus":@(missing), @"cleanupStatus":@(cleanup),
            @"ok":@(!added && !read1 && firstMatches && !updated && !read2 && nextMatches && !deleted && missing == errSecItemNotFound && !cleanup)}];
    }
    SecKeychainSetUserInteractionAllowed(original);
    [NSFileManager.defaultManager removeItemAtPath:dir error:nil];
    return out;
}

static NSDictionary *OCRProbe(void) {
    // Render only synthetic text into an off-screen bitmap. Never capture the user's screen.
    NSBitmapImageRep *bitmap = [[NSBitmapImageRep alloc] initWithBitmapDataPlanes:NULL pixelsWide:1000 pixelsHigh:240
        bitsPerSample:8 samplesPerPixel:4 hasAlpha:YES isPlanar:NO colorSpaceName:NSDeviceRGBColorSpace bytesPerRow:0 bitsPerPixel:0];
    [NSGraphicsContext saveGraphicsState];
    NSGraphicsContext.currentContext = [NSGraphicsContext graphicsContextWithBitmapImageRep:bitmap];
    [NSColor.whiteColor setFill]; NSRectFill(NSMakeRect(0,0,1000,240));
    NSDictionary *attributes = @{NSFontAttributeName:[NSFont systemFontOfSize:52], NSForegroundColorAttributeName:NSColor.blackColor};
    [@"INVOICE 42" drawAtPoint:NSMakePoint(40,140) withAttributes:attributes];
    [@"中文测试" drawAtPoint:NSMakePoint(40,40) withAttributes:attributes];
    [NSGraphicsContext restoreGraphicsState];
    VNRecognizeTextRequest *request = [VNRecognizeTextRequest new];
    request.recognitionLevel = VNRequestTextRecognitionLevelAccurate;
    request.recognitionLanguages = @[@"zh-Hans", @"en-US"];
    VNImageRequestHandler *handler = [[VNImageRequestHandler alloc] initWithCGImage:bitmap.CGImage options:@{}];
    NSError *error = nil;
    BOOL performed = [handler performRequests:@[request] error:&error];
    NSMutableArray *lines = [NSMutableArray array];
    for (VNRecognizedTextObservation *observation in request.results) {
        VNRecognizedText *candidate = [observation topCandidates:1].firstObject;
        if (candidate) [lines addObject:@{@"text":candidate.string, @"confidence":@(candidate.confidence),
            @"normalizedBottomLeftBounds":@[@(observation.boundingBox.origin.x), @(observation.boundingBox.origin.y),
                @(observation.boundingBox.size.width), @(observation.boundingBox.size.height)]}];
    }
    NSString *text = [[lines valueForKey:@"text"] componentsJoinedByString:@" "];
    BOOL english = [[text stringByReplacingOccurrencesOfString:@" " withString:@""] containsString:@"INVOICE42"];
    BOOL chinese = [text containsString:@"中文测试"];
    return @{@"scope":@"synthetic_bitmap_only", @"ok":@(performed && english && chinese), @"errorCode":@(error.code),
        @"english":@(english), @"chinese":@(chinese), @"observations":lines};
}

@interface WebProbe : NSObject <WKScriptMessageHandler, WKNavigationDelegate>
@property(nonatomic,strong) WKWebView *web;
@property(nonatomic,strong) NSURL *origin;
@property(nonatomic) BOOL finished;
- (void)start:(NSURL *)url;
@end
@implementation WebProbe
- (void)finish:(NSDictionary *)result {
    if (self.finished) return;
    self.finished = YES;
    [self.web stopLoading];
    Emit(result);
    exit([result[@"ok"] boolValue] ? 0 : 1);
}
- (void)userContentController:(WKUserContentController *)controller didReceiveScriptMessage:(WKScriptMessage *)message {
    WKSecurityOrigin *source = message.frameInfo.securityOrigin;
    if (!message.frameInfo.isMainFrame || ![source.host isEqual:self.origin.host] ||
        ![source.protocol isEqual:self.origin.scheme] || source.port != self.origin.port.integerValue ||
        ![message.body isKindOfClass:NSDictionary.class]) return;
    [self finish:message.body];
}
- (void)webView:(WKWebView *)view decidePolicyForNavigationAction:(WKNavigationAction *)action decisionHandler:(void (^)(WKNavigationActionPolicy))decision {
    NSURL *url = action.request.URL;
    BOOL same = [url.host isEqual:self.origin.host] && [url.scheme isEqual:self.origin.scheme] && [url.port isEqual:self.origin.port];
    decision(same ? WKNavigationActionPolicyAllow : WKNavigationActionPolicyCancel);
}
- (void)webView:(WKWebView *)view didFailProvisionalNavigation:(WKNavigation *)navigation withError:(NSError *)error {
    [self finish:@{@"ok":@NO, @"error":@"navigation", @"code":@(error.code)}];
}
- (void)start:(NSURL *)url {
    self.origin = url;
    WKWebViewConfiguration *config = [WKWebViewConfiguration new];
    config.websiteDataStore = WKWebsiteDataStore.nonPersistentDataStore;
    [config.userContentController addScriptMessageHandler:self name:@"p0"];
    self.web = [[WKWebView alloc] initWithFrame:NSMakeRect(0,0,1000,800) configuration:config];
    self.web.navigationDelegate = self;
    [self.web loadRequest:[NSURLRequest requestWithURL:url]];
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 40*NSEC_PER_SEC), dispatch_get_main_queue(), ^{
        [self finish:@{@"ok":@NO, @"error":@"timeout"}];
    });
}
@end

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        NSString *mode = argc > 1 ? @(argv[1]) : @"capabilities";
        if ([mode isEqual:@"keychain"]) {
            NSDictionary *out = KeychainProbe(); Emit(out); return [out[@"ok"] boolValue] ? 0 : 1;
        }
        if ([mode isEqual:@"ocr"]) {
            NSDictionary *out = OCRProbe(); Emit(out); return [out[@"ok"] boolValue] ? 0 : 1;
        }
        if ([mode isEqual:@"webview"]) {
            NSURL *url = argc == 3 ? [NSURL URLWithString:@(argv[2])] : nil;
            if (![url.scheme isEqual:@"http"] || ![url.host isEqual:@"127.0.0.1"] || !url.port) {
                Emit(@{@"ok":@NO, @"error":@"loopback_url_required"}); return 2;
            }
            NSApplication *app = NSApplication.sharedApplication;
            [app setActivationPolicy:NSApplicationActivationPolicyProhibited];
            WebProbe *probe = [WebProbe new]; [probe start:url]; [app run];
            return 1;
        }
        if (![mode isEqual:@"capabilities"]) { Emit(@{@"ok":@NO,@"error":@"unknown_mode"}); return 2; }
        NSError *error = nil;
        NSArray *languages = [[VNRecognizeTextRequest new] supportedRecognitionLanguagesAndReturnError:&error];
        Emit(@{@"os":NSProcessInfo.processInfo.operatingSystemVersionString,
            @"accessibilityTrusted":@(AXIsProcessTrusted()), @"screenCapturePreflight":@(CGPreflightScreenCaptureAccess()),
            @"microphoneAuthorizationRaw":@([AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio]),
            @"visionLanguages":languages ?: @[], @"visionErrorCode":@(error.code),
            @"permissionRequestsMade":@NO, @"scope":@"unsigned_probe_process_only_not_release_app"});
    }
    return 0;
}
