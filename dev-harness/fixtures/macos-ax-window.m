// Controlled AX provider. Documents, labels and state belong exclusively to this fixture.
#import <AppKit/AppKit.h>
#include <unistd.h>

static NSWindow *primary;
static NSWindow *alternate;
static NSTextField *draft;
static NSTextField *result;
static NSTextView *plainArea;
static NSTextView *readonlyArea;
static NSButton *apply;
static NSButton *toggle;
static NSMutableArray *retired;
static NSInteger applied, duplicateOne, duplicateTwo, menuInvoked;
static NSInteger ghostPressed;
static BOOL stalled;
static BOOL ghostVisible = YES;
static BOOL expanded;
static NSView *ghostGroup;
static NSAccessibilityElement *ghost;

@interface GhostButton : NSAccessibilityElement
@end
@implementation GhostButton
- (BOOL)accessibilityPerformPress { ghostPressed++; return YES; }
@end

@interface GhostGroup : NSView
@end
@implementation GhostGroup
- (BOOL)isAccessibilityElement { return YES; }
- (NSString *)accessibilityRole { return NSAccessibilityGroupRole; }
- (NSArray *)accessibilityChildren { return ghostVisible ? @[ghost] : @[]; }
@end

@interface FlippedDocument : NSView
@end
@implementation FlippedDocument
- (BOOL)isFlipped { return YES; }
@end

@interface ExpandableView : NSView
@end
@implementation ExpandableView
- (BOOL)isAccessibilityElement { return YES; }
- (NSString *)accessibilityRole { return NSAccessibilityDisclosureTriangleRole; }
- (NSString *)accessibilityLabel { return @"P5 expandable"; }
- (BOOL)isAccessibilityEnabled { return YES; }
- (BOOL)isAccessibilityExpanded { return expanded; }
- (void)setAccessibilityExpanded:(BOOL)value { expanded = value; }
- (BOOL)isAccessibilitySelectorAllowed:(SEL)selector {
    if (selector == @selector(setAccessibilityExpanded:)) return YES;
    return [super isAccessibilitySelectorAllowed:selector];
}
- (void)drawRect:(NSRect)dirty { (void)dirty; [NSColor.systemGreenColor setFill]; NSRectFill(self.bounds); }
@end

@interface SlowGroup : NSView
@end
@implementation SlowGroup
- (BOOL)isAccessibilityElement { return YES; }
- (NSString *)accessibilityRole {
    if (stalled) [NSThread sleepForTimeInterval:3];
    return NSAccessibilityGroupRole;
}
- (NSString *)accessibilityLabel { return @"P5 slow group"; }
- (NSArray *)accessibilityChildren { return @[]; }
@end

@interface AXDelegate : NSObject <NSApplicationDelegate>
- (void)apply:(id)sender;
- (void)duplicateOne:(id)sender;
- (void)duplicateTwo:(id)sender;
- (void)menu:(id)sender;
@end
@implementation AXDelegate
- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)sender { (void)sender; return YES; }
- (void)apply:(id)sender { (void)sender; applied++; result.stringValue = draft.stringValue; }
- (void)duplicateOne:(id)sender { (void)sender; duplicateOne++; }
- (void)duplicateTwo:(id)sender { (void)sender; duplicateTwo++; }
- (void)menu:(id)sender { (void)sender; menuInvoked++; }
@end

static NSButton *Button(NSString *title, NSString *identifier, NSRect frame, id delegate, SEL action) {
    NSButton *button = [NSButton buttonWithTitle:title target:delegate action:action];
    button.frame = frame;
    button.accessibilityIdentifier = identifier;
    [primary.contentView addSubview:button];
    return button;
}

static void Report(NSString *event) {
    NSDictionary *report = @{@"event":event, @"pid":@(NSProcessInfo.processInfo.processIdentifier),
        @"id":@(primary.windowNumber), @"title":primary.title, @"text":draft.stringValue,
        @"result":result.stringValue, @"applied":@(applied), @"duplicateOne":@(duplicateOne),
        @"duplicateTwo":@(duplicateTwo), @"menuInvoked":@(menuInvoked), @"toggle":@(toggle.state == NSControlStateValueOn),
        @"ghostPressed":@(ghostPressed), @"areaText":plainArea.string, @"readonlyText":readonlyArea.string, @"expanded":@(expanded),
        @"active":@(NSApp.active), @"keyWindow":@(NSApp.keyWindow.windowNumber)};
    NSData *data = [NSJSONSerialization dataWithJSONObject:report options:NSJSONWritingSortedKeys error:nil];
    puts([[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding].UTF8String);
    fflush(stdout);
}

static void Command(NSString *command, AXDelegate *delegate) {
    if ([command isEqual:@"replace"]) {
        NSRect frame = apply.frame;
        [apply removeFromSuperview];
        [retired addObject:apply];
        apply = Button(@"Apply 中文", @"apply", frame, delegate, @selector(apply:));
    }
    if ([command isEqual:@"move"]) {
        NSRect frame = apply.frame; frame.origin.x += 30; apply.frame = frame;
    }
    if ([command isEqual:@"alternate"]) {
        if (!alternate) {
            alternate = [[NSWindow alloc] initWithContentRect:NSMakeRect(300, 300, 400, 250)
                styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable backing:NSBackingStoreBuffered defer:NO];
            alternate.releasedWhenClosed = NO;
            alternate.title = @"P5 AX alternate";
        }
        [alternate makeKeyAndOrderFront:nil];
    }
    if ([command isEqual:@"focus"]) {
        [alternate orderOut:nil];
        [primary makeKeyAndOrderFront:nil];
        [NSApp activateIgnoringOtherApps:YES];
    }
    if ([command isEqual:@"stall"]) stalled = YES;
    if ([command isEqual:@"unstall"]) stalled = NO;
    if ([command isEqual:@"hide-ghost"]) {
        ghostVisible = NO;
        NSAccessibilityPostNotification(ghostGroup, NSAccessibilityLayoutChangedNotification);
    }
    if ([command isEqual:@"quit"]) { [NSApp terminate:nil]; return; }
    Report(command);
}

int main(void) {
    @autoreleasepool {
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
        AXDelegate *delegate = [AXDelegate new];
        NSApp.delegate = delegate;
        retired = [NSMutableArray array];
        NSMenu *bar = [NSMenu new];
        NSMenuItem *application = [[NSMenuItem alloc] initWithTitle:@"P5 AX" action:nil keyEquivalent:@""];
        application.submenu = [[NSMenu alloc] initWithTitle:@"P5 AX"];
        NSMenuItem *quit = [[NSMenuItem alloc] initWithTitle:@"Quit" action:@selector(terminate:) keyEquivalent:@"q"];
        quit.target = NSApp;
        [application.submenu addItem:quit];
        [bar addItem:application];
        NSMenuItem *controls = [[NSMenuItem alloc] initWithTitle:@"P5 Fixture Menu" action:nil keyEquivalent:@""];
        NSMenu *menu = [[NSMenu alloc] initWithTitle:@"P5 Fixture Menu"];
        NSMenuItem *item = [[NSMenuItem alloc] initWithTitle:@"Fixture Action" action:@selector(menu:) keyEquivalent:@""];
        item.target = delegate;
        [menu addItem:item];
        controls.submenu = menu;
        [bar addItem:controls];
        NSApp.mainMenu = bar;
        primary = [[NSWindow alloc] initWithContentRect:NSMakeRect(180, 200, 740, 500)
            styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable backing:NSBackingStoreBuffered defer:NO];
        primary.releasedWhenClosed = NO;
        primary.title = [NSString stringWithFormat:@"Ruyi P5 AX %d", getpid()];
        draft = [[NSTextField alloc] initWithFrame:NSMakeRect(30, 410, 650, 30)];
        draft.stringValue = @"controlled baseline";
        draft.accessibilityIdentifier = @"draft";
        draft.accessibilityLabel = @"P5 AX draft";
        [primary.contentView addSubview:draft];
        apply = Button(@"Apply 中文", @"apply", NSMakeRect(30, 340, 190, 40), delegate, @selector(apply:));
        NSButton *disabled = Button(@"Disabled", @"disabled", NSMakeRect(300, 340, 190, 40), delegate, @selector(apply:));
        disabled.enabled = NO;
        Button(@"Duplicate", @"duplicate-one", NSMakeRect(30, 270, 190, 40), delegate, @selector(duplicateOne:));
        Button(@"Duplicate", @"duplicate-two", NSMakeRect(300, 270, 190, 40), delegate, @selector(duplicateTwo:));
        toggle = Button(@"Enable fixture", @"toggle", NSMakeRect(30, 210, 300, 30), nil, nil);
        [toggle setButtonType:NSButtonTypeSwitch];
        result = [NSTextField labelWithString:@"not applied"];
        result.frame = NSMakeRect(30, 140, 650, 35);
        result.accessibilityIdentifier = @"result";
        [primary.contentView addSubview:result];
        [primary.contentView addSubview:[[SlowGroup alloc] initWithFrame:NSMakeRect(30, 40, 300, 60)]];
        ghostGroup = [[GhostGroup alloc] initWithFrame:NSMakeRect(350, 40, 160, 60)];
        [primary.contentView addSubview:ghostGroup];
        NSRect ghostFrame = [primary convertRectToScreen:[ghostGroup convertRect:NSMakeRect(10, 10, 140, 30) toView:nil]];
        ghost = [GhostButton accessibilityElementWithRole:NSAccessibilityButtonRole frame:ghostFrame label:@"Retained ghost" parent:ghostGroup];
        ghost.accessibilityIdentifier = @"ghost";
        ghost.accessibilityEnabled = YES;
        NSScrollView *scroll = [[NSScrollView alloc] initWithFrame:NSMakeRect(520, 220, 180, 150)];
        scroll.hasVerticalScroller = YES;
        FlippedDocument *document = [[FlippedDocument alloc] initWithFrame:NSMakeRect(0, 0, 160, 400)];
        NSButton *scrolledOut = [NSButton buttonWithTitle:@"Outside viewport" target:delegate action:@selector(apply:)];
        scrolledOut.frame = NSMakeRect(10, 220, 140, 30);
        scrolledOut.accessibilityIdentifier = @"scrolled-out";
        [document addSubview:scrolledOut];
        scroll.documentView = document;
        [primary.contentView addSubview:scroll];
        plainArea = [[NSTextView alloc] initWithFrame:NSMakeRect(520, 30, 180, 70)];
        plainArea.richText = NO;
        plainArea.string = @"controlled area";
        plainArea.accessibilityIdentifier = @"text-area";
        [primary.contentView addSubview:plainArea];
        readonlyArea = [[NSTextView alloc] initWithFrame:NSMakeRect(350, 110, 160, 25)];
        readonlyArea.string = @"read-only fixture";
        readonlyArea.editable = NO;
        readonlyArea.accessibilityIdentifier = @"readonly-area";
        [primary.contentView addSubview:readonlyArea];
        ExpandableView *disclosure = [[ExpandableView alloc] initWithFrame:NSMakeRect(350, 180, 140, 25)];
        disclosure.accessibilityIdentifier = @"disclosure";
        [primary.contentView addSubview:disclosure];
        [primary makeKeyAndOrderFront:nil];
        [primary makeFirstResponder:draft];
        [NSApp activateIgnoringOtherApps:YES];
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 300 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
            [scroll.contentView scrollToPoint:NSZeroPoint];
            [scroll reflectScrolledClipView:scroll.contentView];
            Report(@"ready");
        });
        dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
            char *line = NULL; size_t capacity = 0;
            while (getline(&line, &capacity, stdin) > 0) {
                NSString *command = [@(line) stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
                dispatch_async(dispatch_get_main_queue(), ^{ Command(command, delegate); });
            }
            free(line);
            dispatch_async(dispatch_get_main_queue(), ^{ [NSApp terminate:nil]; });
        });
        [NSApp run];
    }
    return 0;
}
