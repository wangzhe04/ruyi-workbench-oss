// Move one directory with the macOS Trash API. Never falls back to permanent deletion.
#import <Foundation/Foundation.h>
#include <sys/stat.h>

static int Emit(NSDictionary *value) {
    NSData *bytes = [NSJSONSerialization dataWithJSONObject:value options:0 error:NULL];
    if (!bytes || fwrite(bytes.bytes, 1, bytes.length, stdout) != bytes.length) return 1;
    return [value[@"ok"] boolValue] ? 0 : 1;
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        if (argc != 2) return Emit(@{@"ok":@NO, @"error":@"invalid_target"});
        NSString *target = [NSString stringWithUTF8String:argv[1]];
        struct stat st;
        if (!target || !target.isAbsolutePath || [target isEqualToString:@"/"]
            || lstat(target.fileSystemRepresentation, &st) != 0 || !S_ISDIR(st.st_mode))
            return Emit(@{@"ok":@NO, @"error":@"invalid_target"});
        NSURL *result = nil;
        NSError *error = nil;
        BOOL moved = [NSFileManager.defaultManager trashItemAtURL:[NSURL fileURLWithPath:target isDirectory:YES]
                                               resultingItemURL:&result error:&error];
        if (!moved || !result) return Emit(@{@"ok":@NO, @"error":@"trash_failed"});
        return Emit(@{@"ok":@YES, @"trashedPath":result.path});
    }
}
