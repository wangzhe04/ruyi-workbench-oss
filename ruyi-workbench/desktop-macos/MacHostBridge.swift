import AppKit
@preconcurrency import WebKit
import UserNotifications
import UniformTypeIdentifiers
import CoreFoundation

final class MacHostBridge: NSObject, WKScriptMessageHandlerWithReply, UNUserNotificationCenterDelegate {
    weak var window: NSWindow?
    var origin: URL?
    var activate: (() -> Void)?
    private var panel: NSOpenPanel?
    private var pickerID: String?

    static func failure(_ code: String) -> [String: Any] {
        ["ok": false, "error": ["code": code, "message": code]]
    }

    func isTrustedFrame(_ frame: WKFrameInfo) -> Bool {
        guard let origin = origin, frame.isMainFrame else { return false }
        let source = frame.securityOrigin
        return source.protocol == origin.scheme && source.host == origin.host && source.port == origin.port
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard isTrustedFrame(message.frameInfo) else { replyHandler(nil, "host.origin_denied"); return }
        guard let body = message.body as? [String: Any], Set(body.keys) == ["version", "id", "method", "params"],
              let version = body["version"] as? NSNumber, CFGetTypeID(version) != CFBooleanGetTypeID(), version.doubleValue == 1,
              let id = body["id"] as? String, UUID(uuidString: id) != nil,
              let method = body["method"] as? String, let params = body["params"] as? [String: Any],
              let data = try? JSONSerialization.data(withJSONObject: body), data.count <= 16384 else {
            replyHandler(Self.failure("host.invalid_message"), nil)
            return
        }
        let reply: ([String: Any]) -> Void = { value in DispatchQueue.main.async { replyHandler(value, nil) } }
        switch method {
        case "pickFolder", "pickFile": pick(method: method, id: id, params: params, reply: reply)
        case "cancelPicker":
            guard Set(params.keys) == ["id"], let requested = params["id"] as? String, UUID(uuidString: requested) != nil else {
                reply(Self.failure("host.invalid_params")); return
            }
            if requested == pickerID { panel?.cancel(nil) }
            reply(["ok": true])
        case "notificationStatus", "requestNotifications":
            guard params.isEmpty else { reply(Self.failure("host.invalid_params")); return }
            if method == "requestNotifications" {
                UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { granted, error in
                    if error != nil { reply(Self.failure("host.notification_unavailable")); return }
                    // The completion is authoritative. An immediate settings query can still
                    // reflect the pre-prompt state while the system persists the new choice.
                    reply(["ok": true, "permission": granted ? "granted" : "denied"])
                }
            } else { notificationStatus(reply: reply) }
        case "notify": notify(params: params, reply: reply)
        default: reply(Self.failure("host.method_unsupported"))
        }
    }

    private func pick(method: String, id: String, params: [String: Any], reply: @escaping ([String: Any]) -> Void) {
        let keys: Set<String> = method == "pickFolder" ? ["title", "initialDir"] : ["filter"]
        guard Set(params.keys).isSubset(of: keys), params.values.allSatisfy({ (($0 as? String)?.utf8.count ?? 8193) <= 8192 }) else {
            reply(Self.failure("host.invalid_params")); return
        }
        guard panel == nil, let window = window, window.attachedSheet == nil else { reply(Self.failure("host.picker_busy")); return }
        let picker = NSOpenPanel()
        picker.title = params["title"] as? String ?? (method == "pickFolder" ? "选择工作文件夹" : "选择文件")
        picker.canChooseDirectories = method == "pickFolder"
        picker.canChooseFiles = method == "pickFile"
        picker.allowsMultipleSelection = false
        picker.canCreateDirectories = method == "pickFolder"
        if let initial = params["initialDir"] as? String, initial.hasPrefix("/"), FileManager.default.fileExists(atPath: initial) {
            picker.directoryURL = URL(fileURLWithPath: initial)
        }
        if let filter = params["filter"] as? String {
            let patterns = filter.split(separator: "|").enumerated().filter { $0.offset % 2 == 1 }.map { String($0.element) }
            let extensions = patterns.flatMap { $0.split(separator: ";") }.filter { $0.hasPrefix("*.") && $0 != "*.*" }
            let types = extensions.compactMap { UTType(filenameExtension: String($0.dropFirst(2))) }
            if !patterns.contains(where: { $0.contains("*.*") || $0 == "*" }), !types.isEmpty { picker.allowedContentTypes = types }
        }
        panel = picker
        pickerID = id
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        picker.beginSheetModal(for: window) { response in
            self.panel = nil
            self.pickerID = nil
            if response == .OK, let path = picker.url?.path { reply(["ok": true, "path": path]) }
            else { reply(["ok": true, "cancelled": true]) }
        }
    }

    func cancelPendingPicker() { panel?.cancel(nil) }

    private func notificationStatus(reply: @escaping ([String: Any]) -> Void) {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            let permission: String
            switch settings.authorizationStatus {
            case .authorized, .provisional: permission = "granted"
            case .denied: permission = "denied"
            case .notDetermined: permission = "default"
            @unknown default: permission = "unsupported"
            }
            reply(["ok": true, "permission": permission])
        }
    }

    private func notify(params: [String: Any], reply: @escaping ([String: Any]) -> Void) {
        guard Set(params.keys) == ["id", "title", "body"],
              let id = params["id"] as? String, !id.isEmpty, id.utf8.count <= 512,
              let title = params["title"] as? String, title.utf8.count <= 512,
              let body = params["body"] as? String, body.utf8.count <= 8192 else { reply(Self.failure("host.invalid_params")); return }
        notificationStatus { status in
            guard status["permission"] as? String == "granted" else { reply(Self.failure("host.notification_permission_required")); return }
            let content = UNMutableNotificationContent()
            content.title = title
            content.body = body
            UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: id, content: content, trigger: nil)) { error in
                reply(error == nil ? ["ok": true] : Self.failure("host.notification_failed"))
            }
        }
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        DispatchQueue.main.async { self.activate?(); completionHandler() }
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound])
    }

    static func externalURLAllowed(_ url: URL) -> Bool {
        guard ["https", "http", "mailto"].contains(url.scheme?.lowercased() ?? ""), url.user == nil, url.password == nil else { return false }
        return url.scheme == "mailto" || !(url.host ?? "").isEmpty
    }

    func openExternal(_ url: URL) {
        guard Self.externalURLAllowed(url) else { return }
        NSWorkspace.shared.open(url)
    }
}
