// Offline, process-bounded Vision OCR. Image coordinates use a top-left pixel origin.
#import "macos-automation.h"
#import <Vision/Vision.h>
#import <ImageIO/ImageIO.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

static VNRecognizeTextRequest *Recognizer(void) {
    VNRecognizeTextRequest *request = [VNRecognizeTextRequest new];
    request.revision = VNRecognizeTextRequestRevision3;
    request.recognitionLevel = VNRequestTextRecognitionLevelAccurate;
    request.usesLanguageCorrection = NO;
    return request;
}

static NSArray<NSString *> *Languages(void) {
    return [Recognizer() supportedRecognitionLanguagesAndReturnError:nil] ?: @[];
}

NSDictionary *RuyiAutomationOCRStatus(void) {
    return @{@"ocrSupported":@YES, @"ocrReady":@(Languages().count > 0),
        @"ocrBackend":@"Vision", @"ocrRevision":@(VNRecognizeTextRequestRevision3)};
}

static NSData *ReadImage(NSString *path, NSDictionary **failure) {
    int descriptor = open(path.fileSystemRepresentation, O_RDONLY | O_CLOEXEC | O_NONBLOCK);
    if (descriptor < 0) {
        *failure = RuyiAutomationFailure(@"ocr_image_unavailable", @"Cannot open the requested image file");
        return nil;
    }
    NSMutableData *data = [NSMutableData data];
    @try {
        struct stat before, after;
        if (fstat(descriptor, &before) != 0 || !S_ISREG(before.st_mode) || before.st_size <= 0 || before.st_size > 50000000) {
            *failure = RuyiAutomationFailure(@"ocr_capacity", @"OCR requires a nonempty regular image file of at most 50MB");
            return nil;
        }
        uint8_t buffer[65536];
        ssize_t count;
        while ((count = read(descriptor, buffer, sizeof(buffer))) > 0) {
            if (data.length + (NSUInteger)count > 50000000) {
                *failure = RuyiAutomationFailure(@"ocr_capacity", @"OCR image exceeds the input byte limit");
                return nil;
            }
            [data appendBytes:buffer length:(NSUInteger)count];
        }
        if (count < 0 || fstat(descriptor, &after) != 0 || before.st_size != after.st_size ||
            before.st_mtimespec.tv_sec != after.st_mtimespec.tv_sec ||
            before.st_mtimespec.tv_nsec != after.st_mtimespec.tv_nsec ||
            before.st_ctimespec.tv_sec != after.st_ctimespec.tv_sec ||
            before.st_ctimespec.tv_nsec != after.st_ctimespec.tv_nsec || data.length != (NSUInteger)after.st_size) {
            *failure = RuyiAutomationFailure(@"ocr_image_changed", @"Image read failed or its contents changed during the read");
            return nil;
        }
    } @finally {
        close(descriptor);
    }
    return data;
}

static NSDictionary *PixelBox(CGRect normalized, size_t width, size_t height) {
    if (!isfinite(normalized.origin.x) || !isfinite(normalized.origin.y) ||
        !isfinite(normalized.size.width) || !isfinite(normalized.size.height)) return nil;
    CGRect clipped = CGRectIntersection(normalized, CGRectMake(0, 0, 1, 1));
    if (CGRectIsNull(clipped) || CGRectIsEmpty(clipped)) return nil;
    CGFloat left = MAX(0, floor(CGRectGetMinX(clipped) * width));
    CGFloat top = MAX(0, floor((1 - CGRectGetMaxY(clipped)) * height));
    CGFloat right = MIN(width, ceil(CGRectGetMaxX(clipped) * width));
    CGFloat bottom = MIN(height, ceil((1 - CGRectGetMinY(clipped)) * height));
    if (right <= left || bottom <= top) return nil;
    return @{@"left":@(left), @"top":@(top), @"width":@(right - left), @"height":@(bottom - top),
        @"center":@[@((left + right) / 2), @((top + bottom) / 2)]};
}

static NSDictionary *Recognize(CGImageRef image, NSString *language, NSArray *available) {
    VNRecognizeTextRequest *recognizer = Recognizer();
    NSArray *selected;
    if (language.length) {
        NSDictionary *aliases = @{@"zh":@"zh-Hans", @"chinese":@"zh-Hans", @"zh-cn":@"zh-Hans",
            @"zh-hans-cn":@"zh-Hans", @"zh-hans":@"zh-Hans", @"zh-tw":@"zh-Hant", @"zh-hk":@"zh-Hant",
            @"zh-hant-tw":@"zh-Hant", @"zh-hant":@"zh-Hant", @"en":@"en-US", @"english":@"en-US",
            @"ja":@"ja-JP", @"japanese":@"ja-JP", @"ko":@"ko-KR", @"korean":@"ko-KR"};
        NSString *canonical = aliases[language.lowercaseString] ?: language;
        NSString *supported = nil;
        for (NSString *candidate in available)
            if ([candidate caseInsensitiveCompare:canonical] == NSOrderedSame) { supported = candidate; break; }
        if (!supported) return @{@"ok":@NO, @"code":@"ocr_language_unsupported",
            @"error":@"Requested language is not supported by the installed Vision recognizer", @"available_languages":available};
        selected = @[supported];
    } else {
        NSMutableArray *preferred = [NSMutableArray array];
        for (NSString *candidate in @[@"zh-Hans", @"en-US"])
            if ([available containsObject:candidate]) [preferred addObject:candidate];
        selected = preferred.count ? preferred : @[available.firstObject];
        recognizer.automaticallyDetectsLanguage = YES;
    }
    recognizer.recognitionLanguages = selected;
    VNImageRequestHandler *handler = [[VNImageRequestHandler alloc] initWithCGImage:image options:@{}];
    NSError *error = nil;
    if (![handler performRequests:@[recognizer] error:&error])
        return RuyiAutomationFailure(@"ocr_failed", [NSString stringWithFormat:@"Vision recognition failed (%ld)", (long)error.code]);
    NSMutableArray *lines = [NSMutableArray array], *words = [NSMutableArray array];
    NSRegularExpression *tokens = [NSRegularExpression regularExpressionWithPattern:
        @"[\\p{Han}\\p{Hiragana}\\p{Katakana}\\p{Hangul}]\\p{M}*|[^\\s\\p{Han}\\p{Hiragana}\\p{Katakana}\\p{Hangul}]+"
        options:0 error:nil];
    if (!tokens) return RuyiAutomationFailure(@"ocr_failed", @"Cannot create the Unicode OCR tokenizer");
    NSUInteger textLength = 0;
    size_t width = CGImageGetWidth(image), height = CGImageGetHeight(image);
    for (VNRecognizedTextObservation *observation in recognizer.results) {
        VNRecognizedText *candidate = [observation topCandidates:1].firstObject;
        if (!candidate.string.length) continue;
        if (lines.count >= 2000 || candidate.string.length > 4096 || textLength + candidate.string.length > 65536)
            return RuyiAutomationFailure(@"ocr_capacity", @"Recognized text exceeds the line or text limit");
        NSUInteger line = lines.count;
        textLength += candidate.string.length;
        [lines addObject:candidate.string];
        NSArray<NSTextCheckingResult *> *ranges = [tokens matchesInString:candidate.string options:0
            range:NSMakeRange(0, candidate.string.length)];
        if (words.count + ranges.count > 10000)
            return RuyiAutomationFailure(@"ocr_capacity", @"Recognized word count exceeds 10000");
        for (NSTextCheckingResult *token in ranges) {
            NSError *boxError = nil;
            VNRectangleObservation *box = [candidate boundingBoxForRange:token.range error:&boxError];
            NSDictionary *pixels = box ? PixelBox(box.boundingBox, width, height) : nil;
            if (!pixels) return RuyiAutomationFailure(@"ocr_geometry_unavailable",
                @"Vision did not provide valid geometry for a recognized token");
            NSMutableDictionary *word = [pixels mutableCopy];
            [word addEntriesFromDictionary:@{@"text":[candidate.string substringWithRange:token.range],
                @"line":@(line), @"confidence":@(candidate.confidence)}];
            [words addObject:word];
        }
    }
    return @{@"ok":@YES, @"success":@YES, @"protocolVersion":@1, @"backend":@"Vision",
        @"recognition_revision":@(recognizer.revision), @"recognition_languages":selected,
        @"text":[lines componentsJoinedByString:@"\n"], @"lines":lines, @"words":words, @"words_total":@(words.count),
        @"width":@(width), @"height":@(height), @"coordinate_space":@"image_pixels",
        @"confidence_scope":@"line_candidate", @"image_orientation":@"decoded_pixels_up"};
}

NSDictionary *RuyiAutomationOCRRequest(NSDictionary *request) {
    NSString *op = request[@"op"];
    BOOL recognizing = [op isEqual:@"ocr.image"];
    if (!recognizing && ![op isEqual:@"ocr.languages"])
        return RuyiAutomationFailure(@"invalid_args", @"Unsupported OCR operation");
    NSSet *keys = [NSSet setWithArray:recognizing ? @[@"version", @"op", @"path", @"lang"] : @[@"version", @"op"]];
    for (NSString *key in request)
        if (![keys containsObject:key]) return RuyiAutomationFailure(@"invalid_args", @"Unexpected OCR field");
    NSArray *available = Languages();
    if (!available.count) return RuyiAutomationFailure(@"ocr_unavailable", @"The installed Vision recognizer exposes no languages");
    if (!recognizing) {
        NSMutableArray *items = [NSMutableArray array];
        for (NSString *tag in available)
            [items addObject:@{@"tag":tag, @"name":[NSLocale.currentLocale localizedStringForLanguageCode:tag] ?: tag}];
        return @{@"ok":@YES, @"protocolVersion":@1, @"backend":@"Vision", @"languages":items,
            @"count":@(items.count), @"recognition_revision":@(VNRecognizeTextRequestRevision3)};
    }
    NSString *path = request[@"path"], *language = request[@"lang"];
    NSCharacterSet *nul = [NSCharacterSet characterSetWithRange:NSMakeRange(0, 1)];
    if (![path isKindOfClass:NSString.class] || !path.isAbsolutePath || path.length > 4096 ||
        [path rangeOfCharacterFromSet:nul].location != NSNotFound || ![language isKindOfClass:NSString.class] ||
        language.length > 64 || [language rangeOfCharacterFromSet:nul].location != NSNotFound)
        return RuyiAutomationFailure(@"invalid_args", @"OCR requires an absolute image path and bounded language hint");
    NSDictionary *failure = nil;
    NSData *data = ReadImage(path, &failure);
    if (!data) return failure;
    CGImageSourceRef source = CGImageSourceCreateWithData((__bridge CFDataRef)data, NULL);
    if (!source) return RuyiAutomationFailure(@"ocr_image_invalid", @"Input does not decode as an image");
    CGImageRef image = NULL;
    NSDictionary *out;
    @try {
        NSDictionary *properties = CFBridgingRelease(CGImageSourceCopyPropertiesAtIndex(source, 0, NULL));
        if (!properties) return RuyiAutomationFailure(@"ocr_image_invalid", @"Input has no decodable image properties");
        double width = [properties[(__bridge NSString *)kCGImagePropertyPixelWidth] doubleValue];
        double height = [properties[(__bridge NSString *)kCGImagePropertyPixelHeight] doubleValue];
        if (!isfinite(width) || !isfinite(height) || width < 1 || height < 1 || width > 16384 || height > 16384 || width * height > 32000000)
            return RuyiAutomationFailure(@"ocr_capacity", @"OCR image must contain at most 32 million pixels with each side at most 16384");
        image = CGImageSourceCreateImageAtIndex(source, 0, NULL);
        if (!image || CGImageGetWidth(image) != (size_t)width || CGImageGetHeight(image) != (size_t)height)
            return RuyiAutomationFailure(@"ocr_image_invalid", @"Image decoding or dimensions failed validation");
        out = Recognize(image, [language stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet], available);
    } @finally {
        if (image) CGImageRelease(image);
        CFRelease(source);
    }
    return out;
}
