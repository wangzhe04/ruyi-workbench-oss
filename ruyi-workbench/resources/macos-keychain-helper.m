// One bounded stdin request; no subprocesses, secret arguments, environment or files.
// Release builds use the user's Keychain search list/default write target. Tests bind one disposable domain.
#import <Foundation/Foundation.h>
#import <Security/Security.h>

static int Emit(NSDictionary *value) {
    NSData *data = [NSJSONSerialization dataWithJSONObject:value options:0 error:NULL];
    if (!data || fwrite(data.bytes, 1, data.length, stdout) != data.length) return 1;
    return [value[@"ok"] boolValue] ? 0 : 1;
}

static NSString *Failure(OSStatus status, SecKeychainRef keychain) {
    if (status == errSecItemNotFound) return @"key_missing";
    if (status == errSecInteractionNotAllowed || status == errSecAuthFailed || status == errSecUserCanceled) {
        SecKeychainRef current = keychain;
        if (current) CFRetain(current);
        else SecKeychainCopyDefault(&current);
        SecKeychainStatus state = 0;
        OSStatus checked = current ? SecKeychainGetStatus(current, &state) : errSecNoDefaultKeychain;
        if (current) CFRelease(current);
        if (checked == errSecSuccess && !(state & kSecUnlockStateStatus)) return @"keychain_locked";
        return status == errSecInteractionNotAllowed ? @"permission_required" : @"permission_denied";
    }
    if (status == errSecDecode) return @"keychain_corrupt";
    return @"keychain_unavailable";
}

int main(void) {
    @autoreleasepool {
        unsigned char input[4097];
        size_t size = fread(input, 1, sizeof(input), stdin);
        if (size > 4096 || ferror(stdin)) return Emit(@{@"ok":@NO, @"error":@"input_invalid"});
        id request = [NSJSONSerialization JSONObjectWithData:[NSData dataWithBytes:input length:size] options:0 error:NULL];
        if (![request isKindOfClass:NSDictionary.class] || [request count] != 2 || ![request[@"version"] isEqual:@1]
            || !([request[@"op"] isEqual:@"get"] || [request[@"op"] isEqual:@"get-or-create"]))
            return Emit(@{@"ok":@NO, @"error":@"input_invalid"});
        // An unsigned CLI must not leave a UI prompt pending after its caller times out.
        // Users can unlock their login Keychain / grant access, then retry explicitly.
        SecKeychainSetUserInteractionAllowed(false);
        SecKeychainRef keychain = NULL;
#ifdef RUYI_KEYCHAIN_TEST_PATH
        OSStatus opened = SecKeychainOpen(RUYI_KEYCHAIN_TEST_PATH, &keychain);
        if (opened) return Emit(@{@"ok":@NO, @"error":@"keychain_unavailable"});
#endif
        NSMutableDictionary *query = [@{(__bridge id)kSecClass:(__bridge id)kSecClassGenericPassword,
            (__bridge id)kSecAttrService:@"org.ruyi.workbench.local-secrets",
            (__bridge id)kSecAttrAccount:@"wrapping-key-v1"} mutableCopy];
        if (keychain) query[(__bridge id)kSecMatchSearchList] = @[(__bridge id)keychain];
        NSMutableDictionary *read = [query mutableCopy];
        read[(__bridge id)kSecReturnData] = @YES;
        read[(__bridge id)kSecMatchLimit] = (__bridge id)kSecMatchLimitOne;
        CFTypeRef found = NULL;
        OSStatus status = SecItemCopyMatching((__bridge CFDictionaryRef)read, &found);
        if (status == errSecItemNotFound && [request[@"op"] isEqual:@"get-or-create"]) {
            NSMutableData *key = [NSMutableData dataWithLength:32];
            status = SecRandomCopyBytes(kSecRandomDefault, key.length, key.mutableBytes);
            if (!status) {
                NSMutableDictionary *add = [query mutableCopy];
                [add removeObjectForKey:(__bridge id)kSecMatchSearchList];
                if (keychain) add[(__bridge id)kSecUseKeychain] = (__bridge id)keychain;
                add[(__bridge id)kSecValueData] = key;
                add[(__bridge id)kSecAttrLabel] = @"Ruyi local credential wrapping key";
                status = SecItemAdd((__bridge CFDictionaryRef)add, NULL);
                // Concurrent first use keeps the existing key; never replace another caller's record.
                if (!status || status == errSecDuplicateItem) status = SecItemCopyMatching((__bridge CFDictionaryRef)read, &found);
            }
            memset_s(key.mutableBytes, key.length, 0, key.length);
        }
        NSDictionary *response;
        if (status) response = @{@"ok":@NO, @"error":Failure(status, keychain)};
        else if (!found || CFGetTypeID(found) != CFDataGetTypeID() || CFDataGetLength(found) != 32)
            response = @{@"ok":@NO, @"error":@"keychain_corrupt"};
        else response = @{@"ok":@YES, @"value":[(__bridge NSData *)found base64EncodedStringWithOptions:0]};
        int result = Emit(response);
        if (found) CFRelease(found);
        if (keychain) CFRelease(keychain);
        return result;
    }
}
