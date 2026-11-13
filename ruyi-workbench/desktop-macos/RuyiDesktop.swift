import AppKit
@preconcurrency import WebKit
import CryptoKit
import Darwin
import UserNotifications
import ServiceManagement

final class RuyiDesktop: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var status: NSStackView!
    private var label: NSTextField!
    private var retry: NSButton!
    private var service: DesktopService!
    private var trustedOrigin: URL?
    private var lockDescriptor: Int32 = -1
    private var ownsInstance = false
    private var activationKey = ""
    private var hostCache: URL?
    private var signalSources: [DispatchSourceSignal] = []
    private var quitting = false
    private var shutdownComplete = false
    private var report: URL?
    private var screenshot: URL?
    private var pageDeadline: Date?
    private var pageTimer: Timer?
    private var inspectionInFlight = false
    private var failureQuitRequested = false
    private var acceptanceScript = "return null;"
    private var activationCount = 0
    private var lastReport: [String: Any] = [:]
    private var previewNavigations = 0
    private let hostBridge = MacHostBridge()
    private var statusItem: NSStatusItem?
    private var backgroundOnClose = true
    private var backgroundMenuItem: NSMenuItem?
    private var loginMenuItem: NSMenuItem?
    private var resumePending = false
    private var wakeValidated = false
    private var sleepEvents = 0
    private var wakeEvents = 0
    private var microphoneAcceptanceObserver: NSKeyValueObservation?
    private var microphoneAcceptanceDeadline: DispatchWorkItem?
    private var microphoneAcceptancePoll: Timer?
    private var microphoneAcceptanceInspecting = false
    private var microphoneAcceptanceRun = UUID()
    private var microphoneAcceptanceStarted: TimeInterval?
    private var microphoneAcceptanceEvents: [[String: Any]] = []
    private var microphoneAcceptanceLimitFired = false
    private var microphoneAcceptanceStopsInFlight = 0

    func applicationDidFinishLaunching(_ notification: Notification) {
        let args = ProcessInfo.processInfo.arguments
        func argument(_ name: String) -> String? {
            guard let index = args.firstIndex(of: name), index + 1 < args.count else { return nil }
            return args[index + 1]
        }
        if let path = argument("--acceptance-report") { report = URL(fileURLWithPath: path) }
        if report != nil, let path = argument("--acceptance-screenshot") { screenshot = URL(fileURLWithPath: path) }
        if report != nil, let path = argument("--acceptance-script"), let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
           data.count <= 65536, let script = String(data: data, encoding: .utf8) { acceptanceScript = script }
        let bundled = Bundle.main.object(forInfoDictionaryKey: "RuyiBundledWorkbench") as? String == "true"
        let bundledRoot = Bundle.main.resourceURL?.appendingPathComponent("workbench").path ?? ""
        let root = bundled ? bundledRoot
            : argument("--workbench-root") ?? Bundle.main.object(forInfoDictionaryKey: "RuyiWorkbenchRoot") as? String ?? ""
        service = DesktopService(root: URL(fileURLWithPath: root), environment: ProcessInfo.processInfo.environment)
        buildMenu()
        hostBridge.activate = { [weak self] in self?.activateWindow() }
        UNUserNotificationCenter.current().delegate = hostBridge
        for number in [SIGTERM, SIGINT] {
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
            source.setEventHandler { NSApp.terminate(nil) }
            source.resume()
            signalSources.append(source)
        }
        if report != nil, args.contains("--acceptance-system-events") {
            for number in [SIGUSR1, SIGUSR2] {
                signal(number, SIG_IGN)
                let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
                source.setEventHandler { [weak self] in
                    if number == SIGUSR1 { self?.systemWillSleep(Notification(name: NSWorkspace.willSleepNotification)) }
                    else { self?.systemDidWake(Notification(name: NSWorkspace.didWakeNotification)) }
                }
                source.resume()
                signalSources.append(source)
            }
        }
        service.onReady = { [weak self] url in
            guard let self = self else { return }
            if self.resumePending, self.trustedOrigin == url, self.allowed(self.webView.url) {
                self.resumePending = false
                self.wakeValidated = true
                self.webView.evaluateJavaScript("window.dispatchEvent(new Event('ruyi:host-wake'))")
                self.writeReport(self.lastReport)
                return
            }
            self.resumePending = false
            self.trustedOrigin = url
            self.hostBridge.origin = url
            self.installHostMarker(url)
            self.webView.load(URLRequest(url: url))
        }
        service.onFailure = { [weak self] code in self?.showFailure(code) }
        do {
            guard try acquireInstance() else {
                DistributedNotificationCenter.default().postNotificationName(.init("org.ruyi.workbench.activate"), object: activationKey)
                writeReport(["state": "existing_host_activated"])
                NSApp.terminate(nil)
                return
            }
        } catch {
            buildWindow()
            showFailure("instance_lock_unavailable")
            return
        }
        buildWindow()
        if report != nil, args.contains("--acceptance-toggle-background") { toggleBackgroundOnClose() }
        NSWorkspace.shared.notificationCenter.addObserver(self, selector: #selector(systemWillSleep(_:)), name: NSWorkspace.willSleepNotification, object: nil)
        NSWorkspace.shared.notificationCenter.addObserver(self, selector: #selector(systemDidWake(_:)), name: NSWorkspace.didWakeNotification, object: nil)
        startService()
    }

    private func acquireInstance() throws -> Bool {
        activationKey = SHA256.hash(data: Data(service.dataRoot.path.utf8)).map { String(format: "%02x", $0) }.joined()
        let home = ProcessInfo.processInfo.environment["HOME"] ?? FileManager.default.homeDirectoryForCurrentUser.path
        let cache = URL(fileURLWithPath: home).appendingPathComponent("Library/Application Support/RuyiWorkbench/Hosts", isDirectory: true)
        hostCache = cache
        try FileManager.default.createDirectory(at: cache, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        if lockDescriptor >= 0 { close(lockDescriptor) }
        lockDescriptor = open(cache.appendingPathComponent(activationKey + ".lock").path, O_CREAT | O_RDWR | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard lockDescriptor >= 0 else { throw DesktopFailure.unavailable("instance_lock_unavailable") }
        if flock(lockDescriptor, LOCK_EX | LOCK_NB) == 0 {
            ownsInstance = true
            DistributedNotificationCenter.default().addObserver(self, selector: #selector(activateWindow),
                name: .init("org.ruyi.workbench.activate"), object: activationKey)
            return true
        }
        if errno == EWOULDBLOCK { return false }
        throw DesktopFailure.unavailable("instance_lock_unavailable")
    }

    private func buildMenu() {
        let menu = NSMenu()
        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "显示如意工作台", action: #selector(activateWindow), keyEquivalent: "0").target = self
        backgroundMenuItem = appMenu.addItem(withTitle: "关闭窗口后继续后台运行", action: #selector(toggleBackgroundOnClose), keyEquivalent: "")
        backgroundMenuItem?.target = self
        backgroundMenuItem?.state = .on
        loginMenuItem = appMenu.addItem(withTitle: "登录时启动", action: #selector(toggleLoginStartup), keyEquivalent: "")
        loginMenuItem?.target = self
        updateLoginMenu()
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "隐藏如意工作台", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "退出如意工作台", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        menu.addItem(appItem)
        let edit = NSMenuItem()
        edit.submenu = NSMenu(title: "编辑")
        for (title, action, key) in [("撤销", "undo:", "z"), ("重做", "redo:", "Z"), ("剪切", "cut:", "x"),
                                     ("复制", "copy:", "c"), ("粘贴", "paste:", "v"), ("全选", "selectAll:", "a")] {
            edit.submenu?.addItem(withTitle: title, action: Selector(action), keyEquivalent: key)
        }
        menu.addItem(edit)
        let file = NSMenuItem()
        file.submenu = NSMenu(title: "文件")
        for (title, action, key) in [("新建线程", #selector(newThread), "n"), ("选择工作文件夹…", #selector(chooseWorkspace), "o"),
                                     ("设置…", #selector(showSettings), ","), ("关闭窗口", #selector(NSWindow.performClose(_:)), "w")] {
            let item = file.submenu!.addItem(withTitle: title, action: action, keyEquivalent: key)
            if key != "w" { item.target = self }
        }
        menu.addItem(file)
        NSApp.mainMenu = menu
    }

    private func updateLoginMenu() {
        let status = SMAppService.mainApp.status
        loginMenuItem?.state = status == .enabled ? .on : (status == .requiresApproval ? .mixed : .off)
        loginMenuItem?.title = status == .requiresApproval ? "登录时启动（等待系统批准）" : "登录时启动"
    }

    @objc private func toggleLoginStartup() {
        guard window?.attachedSheet == nil else { return }
        do {
            let service = SMAppService.mainApp
            if service.status == .enabled || service.status == .requiresApproval { try service.unregister() }
            else { try service.register() }
            updateLoginMenu()
            if service.status == .requiresApproval { SMAppService.openSystemSettingsLoginItems() }
        } catch {
            updateLoginMenu()
            let alert = NSAlert()
            alert.messageText = "登录启动设置未能完成"
            alert.informativeText = "请检查系统设置中的登录项，并确认如意工作台位于稳定的安装目录。\n" + error.localizedDescription
            alert.beginSheetModal(for: window)
        }
    }

    @objc private func toggleBackgroundOnClose() {
        guard let cache = hostCache, window?.attachedSheet == nil else { return }
        let enabled = !backgroundOnClose
        do {
            try (enabled ? "1" : "0").write(to: cache.appendingPathComponent(activationKey + ".background"), atomically: true, encoding: .utf8)
            backgroundOnClose = enabled
            backgroundMenuItem?.state = enabled ? .on : .off
        } catch {
            let alert = NSAlert()
            alert.messageText = "关窗行为设置未能保存"
            alert.informativeText = error.localizedDescription
            alert.beginSheetModal(for: window)
        }
    }

    private func buildStatusMenu() {
        guard statusItem == nil else { return }
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        item.button?.image = NSImage(systemSymbolName: "sparkles", accessibilityDescription: "如意工作台")
        item.button?.toolTip = "如意工作台"
        let menu = NSMenu()
        menu.addItem(withTitle: "显示工作台", action: #selector(activateWindow), keyEquivalent: "").target = self
        menu.addItem(withTitle: "设置…", action: #selector(showSettings), keyEquivalent: "").target = self
        menu.addItem(.separator())
        menu.addItem(withTitle: "退出如意工作台", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "")
        item.menu = menu
        statusItem = item
    }

    @objc private func newThread() { hostAction("newThread") }
    @objc private func chooseWorkspace() { hostAction("chooseWorkspace") }
    @objc private func showSettings() { activateWindow(); hostAction("settings") }

    private func hostAction(_ action: String) {
        guard allowed(webView?.url) else { return }
        webView.evaluateJavaScript("window.dispatchEvent(new CustomEvent('ruyi:host-action', {detail: '\(action)'}))")
    }

    private func suspendPage() {
        if microphoneAcceptanceObserver != nil { webView?.setMicrophoneCaptureState(.none, completionHandler: nil) }
        guard allowed(webView?.url) else { return }
        webView.evaluateJavaScript("window.dispatchEvent(new Event('ruyi:host-suspend'))")
    }

    @objc private func systemWillSleep(_ notification: Notification) {
        guard !quitting, ownsInstance else { return }
        sleepEvents += 1
        wakeValidated = false
        suspendPage()
        hostBridge.cancelPendingPicker()
        service.prepareForSleep()
        writeReport(lastReport)
    }

    @objc private func systemDidWake(_ notification: Notification) {
        guard !quitting, ownsInstance, service.process != nil else { return }
        wakeEvents += 1
        wakeValidated = false
        resumePending = true
        service.resumeAfterSleep()
        writeReport(lastReport)
    }

    func applicationDidHide(_ notification: Notification) { suspendPage() }
    func applicationDidBecomeActive(_ notification: Notification) { updateLoginMenu() }
    func windowDidMiniaturize(_ notification: Notification) { suspendPage() }

    private func installHostMarker(_ url: URL) {
        let value = "\(url.scheme!)://\(url.host!):\(url.port!)"
        let script = "if (location.origin === '\(value)') Object.defineProperty(globalThis, '__ruyiDesktopPlatform', {value:'darwin'});"
        let controller = webView.configuration.userContentController
        controller.removeAllUserScripts()
        controller.addUserScript(WKUserScript(source: script, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    }

    private func buildWindow() {
        if let cache = hostCache,
           let saved = try? String(contentsOf: cache.appendingPathComponent(activationKey + ".background"), encoding: .utf8) {
            backgroundOnClose = saved != "0"
        }
        backgroundMenuItem?.state = backgroundOnClose ? .on : .off
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 840),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "如意工作台"
        window.minSize = NSSize(width: 780, height: 560)
        window.isReleasedWhenClosed = false
        window.center()
        if let cache = hostCache, let saved = try? String(contentsOf: cache.appendingPathComponent(activationKey + ".frame"), encoding: .utf8) {
            let frame = NSRectFromString(saved)
            if frame.width >= 780, frame.height >= 560, NSScreen.screens.contains(where: { $0.visibleFrame.intersects(frame) }) {
                window.setFrame(frame, display: false)
            }
        }
        window.delegate = self
        let config = WKWebViewConfiguration()
        let hash = SHA256.hash(data: Data(service.dataRoot.path.utf8)).map { String(format: "%02x", $0) }.joined()
        let uuid = "\(hash.prefix(8))-\(hash.dropFirst(8).prefix(4))-\(hash.dropFirst(12).prefix(4))-\(hash.dropFirst(16).prefix(4))-\(hash.dropFirst(20).prefix(12))"
        config.websiteDataStore = WKWebsiteDataStore(forIdentifier: UUID(uuidString: uuid)!)
        config.userContentController.addScriptMessageHandler(hostBridge, contentWorld: .page, name: "ruyiHost")
        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        hostBridge.window = window
        if report != nil, ProcessInfo.processInfo.arguments.contains("--acceptance-microphone-deadline") {
            microphoneAcceptanceObserver = webView.observe(\.microphoneCaptureState, options: [.initial, .new]) { [weak self] view, _ in
                let state = view.microphoneCaptureState
                DispatchQueue.main.async { self?.observeAcceptanceMicrophone(state) }
            }
        }
        webView.translatesAutoresizingMaskIntoConstraints = false
        let content = window.contentView!
        content.addSubview(webView)
        NSLayoutConstraint.activate([webView.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: content.trailingAnchor), webView.topAnchor.constraint(equalTo: content.topAnchor),
            webView.bottomAnchor.constraint(equalTo: content.bottomAnchor)])
        label = NSTextField(wrappingLabelWithString: "正在启动如意工作台…")
        label.alignment = .center
        retry = NSButton(title: "重试", target: self, action: #selector(startService))
        status = NSStackView(views: [label, retry])
        status.orientation = .vertical
        status.spacing = 16
        status.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(status)
        NSLayoutConstraint.activate([status.centerXAnchor.constraint(equalTo: content.centerXAnchor),
            status.centerYAnchor.constraint(equalTo: content.centerYAnchor), status.widthAnchor.constraint(lessThanOrEqualToConstant: 650)])
        buildStatusMenu()
        activateWindow()
    }

    // Physical acceptance only. The native deadline starts at actual capture, so an
    // unanswered authorization prompt consumes no recording time. Web content cannot
    // delay this deadline by blocking its own JavaScript event loop.
    private func observeAcceptanceMicrophone(_ state: WKMediaCaptureState) {
        let now = ProcessInfo.processInfo.systemUptime
        var event: [String: Any] = ["state": state.rawValue]
        if state != .none, microphoneAcceptanceStarted == nil {
            microphoneAcceptanceStarted = now
            microphoneAcceptanceRun = UUID()
            let run = microphoneAcceptanceRun
            let deadline = DispatchWorkItem { [weak self] in
                guard let self = self, self.microphoneAcceptanceRun == run,
                      self.webView.microphoneCaptureState != .none else { return }
                self.microphoneAcceptanceLimitFired = true
                self.stopAcceptanceMicrophone(reason: "deadline")
            }
            microphoneAcceptanceDeadline = deadline
            DispatchQueue.main.asyncAfter(deadline: .now() + 2, execute: deadline)
            microphoneAcceptancePoll = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { [weak self] _ in
                guard let self = self, self.microphoneAcceptanceRun == run,
                      !self.microphoneAcceptanceInspecting, self.microphoneAcceptanceStopsInFlight == 0,
                      self.allowed(self.webView.url) else { return }
                self.microphoneAcceptanceInspecting = true
                self.webView.evaluateJavaScript("window.__physicalCaptureMonitor?.trace.requests.at(-1)?.state === 'released'",
                                               in: nil, in: .page) { [weak self] result in
                    guard let self = self, self.microphoneAcceptanceRun == run else { return }
                    self.microphoneAcceptanceInspecting = false
                    if case .success(let value) = result, value as? Bool == true {
                        self.stopAcceptanceMicrophone(reason: "tracks_released")
                    }
                }
            }
        } else if state == .none {
            if let started = microphoneAcceptanceStarted { event["observedDurationMs"] = (now - started) * 1000 }
            microphoneAcceptanceStarted = nil
            microphoneAcceptanceRun = UUID()
            microphoneAcceptanceDeadline?.cancel()
            microphoneAcceptanceDeadline = nil
            microphoneAcceptancePoll?.invalidate()
            microphoneAcceptancePoll = nil
            microphoneAcceptanceInspecting = false
        }
        microphoneAcceptanceEvents.append(event)
        writeReport(lastReport)
    }

    private func stopAcceptanceMicrophone(reason: String) {
        guard let started = microphoneAcceptanceStarted else { return }
        let run = microphoneAcceptanceRun
        microphoneAcceptanceStopsInFlight += 1
        microphoneAcceptancePoll?.invalidate()
        microphoneAcceptanceEvents.append(["action": reason + "_stop_requested",
                                           "elapsedMs": (ProcessInfo.processInfo.systemUptime - started) * 1000])
        writeReport(lastReport)
        webView.setMicrophoneCaptureState(.none) { [weak self] in
            guard let self = self else { return }
            self.microphoneAcceptanceEvents.append(["action": reason + "_stop_completed",
                                                   "elapsedMs": (ProcessInfo.processInfo.systemUptime - started) * 1000])
            self.microphoneAcceptanceStopsInFlight -= 1
            // The public completion confirms the stop. Capture-state reporting can
            // retain the indicator for WebKit's minimum display interval.
            if self.microphoneAcceptanceRun == run {
                self.microphoneAcceptanceDeadline?.cancel()
                self.microphoneAcceptanceDeadline = nil
            }
            self.writeReport(self.lastReport)
        }
    }

    @objc private func activateWindow() {
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        activationCount += 1
        if lastReport["state"] as? String == "ready" { writeReport(lastReport) }
    }

    @objc private func startService() {
        guard !quitting else { return }
        if !ownsInstance {
            do {
                guard try acquireInstance() else {
                    DistributedNotificationCenter.default().postNotificationName(.init("org.ruyi.workbench.activate"), object: activationKey)
                    writeReport(["state": "existing_host_activated"])
                    NSApp.terminate(nil)
                    return
                }
            } catch { showFailure("instance_lock_unavailable"); return }
        }
        pageTimer?.invalidate()
        inspectionInFlight = false
        resumePending = false
        suspendPage()
        trustedOrigin = nil
        hostBridge.origin = nil
        hostBridge.cancelPendingPicker()
        webView.isHidden = true
        status.isHidden = false
        retry.isHidden = true
        label.stringValue = "正在启动如意工作台…"
        writeReport(["state": "starting"])
        if service.process?.isRunning == true, let origin = webView.url {
            trustedOrigin = origin
            hostBridge.origin = origin
            installHostMarker(origin)
            webView.reload()
            return
        }
        do { try service.start() }
        catch DesktopFailure.unavailable(let code) { showFailure(code) }
        catch { showFailure("service_launch_failed") }
    }

    private func showFailure(_ code: String) {
        suspendPage()
        pageTimer?.invalidate()
        hostBridge.origin = nil
        hostBridge.cancelPendingPicker()
        webView?.isHidden = true
        status?.isHidden = false
        retry?.isHidden = service?.process?.isRunning == true && trustedOrigin == nil
        label?.stringValue = "如意工作台暂时无法启动。\n错误代码 \(code)\n请检查 Node.js 与工作台目录后重试。"
        if code == "service_start_timeout" {
            label?.stringValue += "\n若程序或工作区位于文稿目录，请解锁 Mac 并处理文件夹访问提示。\n也可在系统设置 → 隐私与安全性 → 文件与文件夹中允许如意工作台访问，然后退出并重新打开。"
        }
        writeReport(["state": "failed", "code": code])
        if report != nil, ProcessInfo.processInfo.arguments.contains("--acceptance-auto-quit"), !failureQuitRequested {
            failureQuitRequested = true
            DispatchQueue.main.async { NSApp.terminate(nil) }
        }
    }

    private func allowed(_ url: URL?) -> Bool {
        guard let url = url, let origin = trustedOrigin else { return false }
        return url.scheme == origin.scheme && url.host == origin.host && url.port == origin.port && url.user == nil && url.password == nil
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let url = navigationAction.request.url
        if navigationAction.targetFrame?.isMainFrame == false,
           url?.absoluteString == "about:srcdoc" || url?.absoluteString == "about:blank" {
            previewNavigations += 1
            decisionHandler(.allow)
            return
        }
        if allowed(url) { decisionHandler(.allow); return }
        if hostBridge.isTrustedFrame(navigationAction.sourceFrame), navigationAction.navigationType == .linkActivated, let url = url {
            hostBridge.openExternal(url)
        }
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if allowed(navigationAction.request.url) { webView.load(navigationAction.request) }
        return nil
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard allowed(webView.url) else { return }
        status.isHidden = true
        webView.isHidden = false
        guard report != nil else { return }
        pageDeadline = Date().addingTimeInterval(30)
        pageTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in self?.inspectPage() }
    }

    private func inspectPage() {
        guard !inspectionInFlight else { return }
        inspectionInFlight = true
        let script = """
        (async () => {
          await import('/app.js');
          const { state } = await import('/js/state.js');
          const health = await (await fetch('/health')).json();
          const page = { title: document.title, frame: !!document.querySelector('#appFrame'),
            composer: !!document.querySelector('#promptInput'), configLoaded: !!state.status?.config,
            health: health.ok === true, readyState: document.readyState };
          if (page.frame && page.composer && page.configLoaded && page.health) {
            try {
              page.additional = await (async () => { \(acceptanceScript) })();
              JSON.stringify(page.additional);
            } catch (error) {
              delete page.additional;
              page.acceptanceError = String(error).slice(0, 1000);
            }
          }
          return JSON.stringify(page);
        })()
        """
        webView.callAsyncJavaScript("return await " + script, arguments: [:], in: nil, in: .page) { [weak self] result in
            guard let self = self, !self.quitting else { return }
            self.inspectionInFlight = false
            if case .success(let value) = result, let text = value as? String, let data = text.data(using: .utf8),
               let page = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               page["frame"] as? Bool == true, page["composer"] as? Bool == true,
               page["configLoaded"] as? Bool == true, page["health"] as? Bool == true {
                self.pageTimer?.invalidate()
                if let error = page["acceptanceError"] as? String {
                    self.showFailure("acceptance_script_failed")
                    self.writeReport(["state": "failed", "code": "acceptance_script_failed", "detail": error])
                    return
                }
                self.finishAcceptance(page)
            } else if Date() >= (self.pageDeadline ?? .distantPast) { self.showFailure("page_readiness_timeout") }
        }
    }

    private func finishAcceptance(_ page: [String: Any]) {
        let finish = {
            self.writeReport(["state": "ready", "url": self.trustedOrigin!.absoluteString, "page": page])
            if ProcessInfo.processInfo.arguments.contains("--acceptance-close-window") { self.window.performClose(nil) }
            if ProcessInfo.processInfo.arguments.contains("--acceptance-hide") { NSApp.hide(nil) }
            if ProcessInfo.processInfo.arguments.contains("--acceptance-minimize") { self.window.miniaturize(nil) }
            if ProcessInfo.processInfo.arguments.contains("--acceptance-auto-quit") { NSApp.terminate(nil) }
        }
        guard let screenshot = screenshot else { finish(); return }
        webView.takeSnapshot(with: nil) { image, _ in
            guard let tiff = image?.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff),
                  let png = bitmap.representation(using: .png, properties: [:]),
                  (try? png.write(to: screenshot, options: .atomic)) != nil else {
                self.showFailure("acceptance_snapshot_failed")
                return
            }
            finish()
        }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        showFailure("page_load_failed")
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { showFailure("web_content_exited") }

    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        guard type == .microphone, hostBridge.isTrustedFrame(frame),
              origin.protocol == trustedOrigin?.scheme, origin.host == trustedOrigin?.host,
              origin.port == trustedOrigin?.port else { decisionHandler(.deny); return }
        decisionHandler(.prompt)
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping () -> Void) {
        guard hostBridge.isTrustedFrame(frame), window.attachedSheet == nil else { completionHandler(); return }
        let alert = NSAlert()
        alert.messageText = String(message.prefix(4000))
        alert.addButton(withTitle: "好")
        alert.beginSheetModal(for: window) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping (Bool) -> Void) {
        guard hostBridge.isTrustedFrame(frame), window.attachedSheet == nil else { completionHandler(false); return }
        let alert = NSAlert()
        alert.messageText = String(message.prefix(4000))
        alert.addButton(withTitle: "确定")
        alert.addButton(withTitle: "取消")
        alert.beginSheetModal(for: window) { response in completionHandler(response == .alertFirstButtonReturn) }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        activateWindow()
        return true
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func windowDidMove(_ notification: Notification) { saveFrame() }
    func windowDidResize(_ notification: Notification) { saveFrame() }
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        if backgroundOnClose { return true }
        NSApp.terminate(nil)
        return false
    }
    func windowWillClose(_ notification: Notification) {
        suspendPage()
        saveFrame()
        DispatchQueue.main.async { [weak self] in
            guard let self = self, self.lastReport["state"] as? String == "ready" else { return }
            self.writeReport(self.lastReport)
        }
    }

    private func saveFrame() {
        guard let cache = hostCache, let window = window else { return }
        try? NSStringFromRect(window.frame).write(to: cache.appendingPathComponent(activationKey + ".frame"), atomically: true, encoding: .utf8)
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if shutdownComplete { return .terminateNow }
        guard let service = service else { return .terminateNow }
        guard !quitting else { return .terminateCancel }
        quitting = true
        suspendPage()
        pageTimer?.invalidate()
        hostBridge.origin = nil
        hostBridge.cancelPendingPicker()
        service.stop { [weak self] stopped in
            guard let self = self else { return }
            DispatchQueue.main.async {
                if stopped {
                    self.shutdownComplete = true
                    NSApp.terminate(nil)
                } else {
                    self.quitting = false
                    self.showFailure("service_cleanup_incomplete")
                }
            }
        }
        // terminateLater enters an AppKit nested loop. A quit requested from a main-queue
        // signal callback would prevent the service's main-queue completion from running.
        return .terminateCancel
    }

    func applicationWillTerminate(_ notification: Notification) {
        microphoneAcceptanceDeadline?.cancel()
        microphoneAcceptancePoll?.invalidate()
        microphoneAcceptanceObserver?.invalidate()
        DistributedNotificationCenter.default().removeObserver(self)
        NSWorkspace.shared.notificationCenter.removeObserver(self)
        if lockDescriptor >= 0 { close(lockDescriptor) }
    }

    private func writeReport(_ fields: [String: Any]) {
        guard let report = report else { return }
        lastReport = fields
        var value = fields
        value["nativePID"] = ProcessInfo.processInfo.processIdentifier
        value["servicePID"] = service?.process?.processIdentifier ?? 0
        value["activationCount"] = activationCount
        value["windowVisible"] = window?.isVisible ?? false
        value["windowFrame"] = window.map { NSStringFromRect($0.frame) } ?? ""
        value["profileIdentifier"] = webView?.configuration.websiteDataStore.identifier?.uuidString ?? ""
        value["previewNavigations"] = previewNavigations
        value["backgroundOnClose"] = backgroundOnClose
        value["loginStartupStatus"] = SMAppService.mainApp.status.rawValue
        value["sleepEvents"] = sleepEvents
        value["wakeEvents"] = wakeEvents
        value["wakeValidated"] = wakeValidated
        value["simulatedSystemEvents"] = ProcessInfo.processInfo.arguments.contains("--acceptance-system-events")
        if microphoneAcceptanceObserver != nil {
            value["microphoneCaptureEvents"] = microphoneAcceptanceEvents
            value["microphoneCaptureLimitFired"] = microphoneAcceptanceLimitFired
            value["microphoneCaptureStopping"] = microphoneAcceptanceStopsInFlight > 0
            value["microphoneCaptureState"] = webView.microphoneCaptureState.rawValue
        }
        if let data = try? JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys]) {
            try? data.write(to: report, options: .atomic)
        }
    }
}
