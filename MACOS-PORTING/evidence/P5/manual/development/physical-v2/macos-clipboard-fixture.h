#import <AppKit/AppKit.h>

static NSArray *savedClipboard;
static NSInteger expectedClipboardVersion;
static BOOL clipboardSnapshot;
static void SaveClipboard(void) {
    if (![NSProcessInfo.processInfo.environment[@"RUYI_P5_CLIPBOARD_FIXTURE"] isEqual:@"1"]) return;
    NSPasteboard *board = NSPasteboard.generalPasteboard;
    NSInteger version = board.changeCount;
    NSMutableArray *items = [NSMutableArray array];
    NSUInteger bytes = 0;
    for (NSPasteboardItem *item in board.pasteboardItems) {
        NSPasteboardItem *copy = [NSPasteboardItem new];
        for (NSPasteboardType type in item.types) {
            NSData *data = [item dataForType:type];
            if (!data || data.length > 32 * 1024 * 1024 - bytes) return;
            bytes += data.length;
            [copy setData:data forType:type];
        }
        [items addObject:copy];
    }
    if (board.changeCount != version) return;
    savedClipboard = items; expectedClipboardVersion = version; clipboardSnapshot = YES;
}

static void RestoreClipboard(void) {
    if (!clipboardSnapshot) return;
    NSPasteboard *board = NSPasteboard.generalPasteboard;
    BOOL restored = NO;
    if (board.changeCount == expectedClipboardVersion) {
        [board clearContents];
        restored = savedClipboard.count == 0 || [board writeObjects:savedClipboard];
    }
    printf("{\"event\":\"clipboard-restore\",\"restored\":%s}\n", restored ? "true" : "false"); fflush(stdout);
}
