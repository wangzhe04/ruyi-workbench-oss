// Disposable-keychain lifecycle for the Mac credential e2e; never opens the login Keychain.
#import <Foundation/Foundation.h>
#import <Security/Security.h>
int main(void) {
    @autoreleasepool {
        NSData *input = [[NSFileHandle fileHandleWithStandardInput] readDataToEndOfFile];
        NSDictionary *r = [NSJSONSerialization JSONObjectWithData:input options:0 error:NULL];
        NSString *path = r[@"path"], *op = r[@"op"], *password = r[@"password"];
        if (![path.lastPathComponent isEqual:@"fixture.keychain"]) return 2;
        SecKeychainSetUserInteractionAllowed(false);
        SecKeychainRef kc = NULL;
        OSStatus status;
        if ([op isEqual:@"create"]) {
            CFArrayRef previous = NULL;
            status = SecKeychainCopySearchList(&previous);
            if (!status) {
                status = SecKeychainCreate(path.fileSystemRepresentation, (UInt32)[password lengthOfBytesUsingEncoding:NSUTF8StringEncoding], password.UTF8String, false, NULL, &kc);
                OSStatus restored = SecKeychainSetSearchList(previous);
                if (!status) status = restored;
            }
            if (previous) CFRelease(previous);
        } else {
            status = SecKeychainOpen(path.fileSystemRepresentation, &kc);
            if (!status) {
                if ([op isEqual:@"lock"]) status = SecKeychainLock(kc);
                else if ([op isEqual:@"unlock"]) status = SecKeychainUnlock(kc, (UInt32)[password lengthOfBytesUsingEncoding:NSUTF8StringEncoding], password.UTF8String, true);
                else if ([op isEqual:@"delete"]) status = SecKeychainDelete(kc);
                else {
                    NSDictionary *q = @{(__bridge id)kSecClass:(__bridge id)kSecClassGenericPassword,
                        (__bridge id)kSecAttrService:@"org.ruyi.workbench.local-secrets", (__bridge id)kSecAttrAccount:@"wrapping-key-v1",
                        (__bridge id)kSecMatchSearchList:@[(__bridge id)kc]};
                    if ([op isEqual:@"remove-key"]) {
                        SecKeychainItemRef item = NULL;
                        const char *service = "org.ruyi.workbench.local-secrets", *account = "wrapping-key-v1";
                        status = SecKeychainFindGenericPassword(kc, (UInt32)strlen(service), service, (UInt32)strlen(account), account, NULL, NULL, &item);
                        if (!status) status = SecKeychainItemDelete(item);
                        if (item) CFRelease(item);
                    }
                    else if ([op isEqual:@"replace-key"] || [op isEqual:@"corrupt-key"]) {
                        NSMutableData *key = [NSMutableData dataWithLength:[op isEqual:@"corrupt-key"] ? 3 : 32];
                        SecRandomCopyBytes(kSecRandomDefault, key.length, key.mutableBytes);
                        status = SecItemUpdate((__bridge CFDictionaryRef)q, (__bridge CFDictionaryRef)@{(__bridge id)kSecValueData:key});
                    } else status = errSecParam;
                }
            }
        }
        if (kc) CFRelease(kc);
        printf("{\"status\":%d}\n", (int)status);
        return status ? 1 : 0;
    }
}
