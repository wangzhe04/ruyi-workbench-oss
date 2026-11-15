import Foundation
import Darwin

// Foundation may prefer /var while Node realpath returns /private/var. Use the POSIX
// identity for both existing directories and missing descendants of an existing parent.
func desktopCanonicalURL(_ input: URL) -> URL {
    var ancestor = input.standardizedFileURL
    var suffix: [String] = []
    while !FileManager.default.fileExists(atPath: ancestor.path), ancestor.path != "/" {
        suffix.insert(ancestor.lastPathComponent, at: 0)
        ancestor.deleteLastPathComponent()
    }
    let canonical = ancestor.withUnsafeFileSystemRepresentation { name -> String? in
        guard let name = name, let resolved = realpath(name, nil) else { return nil }
        defer { free(resolved) }
        return String(cString: resolved)
    }
    var result = URL(fileURLWithPath: canonical ?? ancestor.path)
    for component in suffix { result.appendPathComponent(component) }
    return result
}

enum DesktopFailure: Error {
    case unavailable(String)
}

final class DesktopService {
    let root: URL
    let dataRoot: URL
    private let runtimeRoots: [URL]
    private(set) var process: Process?
    private var lease: Pipe?
    private var pollTimer: Timer?
    private var generation = UUID()
    private var probing = false
    private var sleeping = false
    private var ready = false
    private var readinessGeneration = UUID()
    private var stopping = false
    private var onStopped: ((Bool) -> Void)?
    var onReady: ((URL) -> Void)?
    var onFailure: ((String) -> Void)?

    init(root: URL, environment: [String: String]) {
        self.root = root
        let home = environment["HOME"] ?? FileManager.default.homeDirectoryForCurrentUser.path
        let explicit = [environment["RUYI_HOME"], environment["WIN_CLAUDE_WORKBENCH_HOME"]]
            .compactMap { $0 }.first { !$0.isEmpty }
        let next = URL(fileURLWithPath: home).appendingPathComponent(".ruyi-workbench")
        let legacy = URL(fileURLWithPath: home).appendingPathComponent(".win-claude-workbench")
        let legacyType = try? FileManager.default.attributesOfItem(atPath: legacy.path)[.type] as? FileAttributeType
        var legacyDirectory: ObjCBool = false
        let linkedLegacy = !FileManager.default.fileExists(atPath: next.path) && legacyType == .typeSymbolicLink
            && FileManager.default.fileExists(atPath: legacy.path, isDirectory: &legacyDirectory) && legacyDirectory.boolValue
        dataRoot = desktopCanonicalURL(URL(fileURLWithPath: explicit ?? (linkedLegacy ? legacy.path : next.path), relativeTo: root))
        // Let the existing direct serve entry resolve and migrate old data. Both locations are
        // considered only after their runtime PID matches the actual child started by this host.
        runtimeRoots = explicit != nil ? [dataRoot] : [next, URL(fileURLWithPath: home).appendingPathComponent(".win-claude-workbench")]
    }

    func start() throws {
        guard process?.isRunning != true else { throw DesktopFailure.unavailable("service_already_running") }
        let files = FileManager.default
        var environment = ProcessInfo.processInfo.environment
        let home = environment["HOME"] ?? files.homeDirectoryForCurrentUser.path
        let bundled = Bundle.main.object(forInfoDictionaryKey: "RuyiBundledWorkbench") as? String == "true"
        let selected = bundled ? root.appendingPathComponent("runtime/node/bin/node").path
            : environment["RUYI_NODE_PATH"].flatMap { $0.isEmpty ? nil : $0 }
        let candidates = selected.map { [$0] }
            ?? [root.appendingPathComponent("runtime/node/bin/node").path, "\(home)/.local/bin/node", "/opt/homebrew/bin/node", "/usr/local/bin/node"]
        guard let node = candidates.first(where: { $0.hasPrefix("/") && files.isExecutableFile(atPath: $0) }) else {
            throw DesktopFailure.unavailable("node_missing")
        }
        let server = root.appendingPathComponent("app/server.js")
        let preload = root.appendingPathComponent("desktop-macos/service-lease.cjs")
        guard files.fileExists(atPath: server.path), files.fileExists(atPath: preload.path) else {
            throw DesktopFailure.unavailable("workbench_missing")
        }
        // Finder and terminal share the same explicit environment. Never execute login profiles.
        environment["PATH"] = ([URL(fileURLWithPath: node).deletingLastPathComponent().path]
            + (bundled ? [] : ["/opt/homebrew/bin", "/usr/local/bin"])
            + ["/usr/bin", "/bin", "/usr/sbin", "/sbin"]).joined(separator: ":")
        environment.removeValue(forKey: "NODE_OPTIONS")
        environment.removeValue(forKey: "NODE_PATH")
        if bundled {
            for key in ["PYTHONHOME", "PYTHONPATH", "PYTHON", "RUYI_BUNDLED_PYTHON", "RUYI_RG_PATH",
                        "AI_COMPUTER_CONTROL_HOME", "PLAYWRIGHT_BROWSERS_PATH", "PLAYWRIGHT_NODEJS_PATH",
                        "RUYI_MACOS_PROCESS_HELPER", "RUYI_MACOS_KEYCHAIN_HELPER", "RUYI_MACOS_AUTOMATION_HELPER"] {
                environment.removeValue(forKey: key)
            }
        }
        let child = Process()
        let input = Pipe()
        let output = Pipe()
        let errors = Pipe()
        child.executableURL = URL(fileURLWithPath: node)
        child.arguments = ["--require", preload.path, server.path, "serve", "--host", "127.0.0.1"]
        child.currentDirectoryURL = root
        child.environment = environment
        child.standardInput = input
        child.standardOutput = output
        child.standardError = errors
        // Drain both streams without retaining potentially sensitive service output.
        for pipe in [output, errors] {
            pipe.fileHandleForReading.readabilityHandler = { handle in
                if handle.availableData.isEmpty { handle.readabilityHandler = nil }
            }
        }
        generation = UUID()
        let run = generation
        stopping = false
        sleeping = false
        ready = false
        probing = false
        child.terminationHandler = { [weak self] _ in
            DispatchQueue.main.async {
                guard let self = self, self.generation == run else { return }
                self.pollTimer?.invalidate()
                self.lease?.fileHandleForWriting.closeFile()
                self.lease = nil
                if self.stopping {
                    let completion = self.onStopped
                    self.onStopped = nil
                    completion?(true)
                } else { self.onFailure?("service_exited") }
            }
        }
        try child.run()
        process = child
        lease = input
        beginReadinessPolling(run: run)
    }

    func prepareForSleep() {
        sleeping = true
        readinessGeneration = UUID()
        pollTimer?.invalidate()
    }

    func resumeAfterSleep() {
        guard !stopping else { return }
        sleeping = false
        guard process?.isRunning == true else { onFailure?("service_exited"); return }
        beginReadinessPolling(run: generation)
    }

    private func beginReadinessPolling(run: UUID) {
        pollTimer?.invalidate()
        probing = false
        readinessGeneration = UUID()
        let readiness = readinessGeneration
        let failureCode = ready ? "service_resume_timeout" : "service_start_timeout"
        let deadline = Date().addingTimeInterval(ready ? 15 : 60)
        pollTimer = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { [weak self] _ in
            guard let self = self, self.generation == run, self.readinessGeneration == readiness,
                  !self.stopping, !self.sleeping else { return }
            if Date() >= deadline {
                self.pollTimer?.invalidate()
                self.stop { _ in self.onFailure?(failureCode) }
                return
            }
            self.probe(run: run, readiness: readiness)
        }
    }

    private func probe(run: UUID, readiness: UUID) {
        guard !probing, let child = process, child.isRunning else { return }
        let record = runtimeRoots.lazy.compactMap { directory -> [String: Any]? in
            guard let data = try? Data(contentsOf: directory.appendingPathComponent("runtime.json")), data.count <= 65536,
                  let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  value["pid"] as? Int == Int(child.processIdentifier) else { return nil }
            return value
        }.first
        guard let record = record,
              record["host"] as? String == "127.0.0.1",
              let port = record["port"] as? Int, (1...65535).contains(port),
              let overlay = record["overlayId"] as? String,
              let base = URL(string: "http://127.0.0.1:\(port)/") else { return }
        probing = true
        var request = URLRequest(url: base.appendingPathComponent("health"))
        request.timeoutInterval = 1
        URLSession.shared.dataTask(with: request) { [weak self] data, response, _ in
            DispatchQueue.main.async {
                guard let self = self, self.generation == run, self.readinessGeneration == readiness,
                      !self.stopping, !self.sleeping else { return }
                self.probing = false
                guard let data = data, data.count <= 65536,
                      (response as? HTTPURLResponse)?.statusCode == 200,
                      let health = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                      health["ok"] as? Bool == true, health["overlayId"] as? String == overlay,
                      child.isRunning else { return }
                self.pollTimer?.invalidate()
                self.ready = true
                self.onReady?(base)
            }
        }.resume()
    }

    func stop(completion: @escaping (Bool) -> Void) {
        pollTimer?.invalidate()
        guard let child = process, child.isRunning else { completion(true); return }
        stopping = true
        onStopped = completion
        lease?.fileHandleForWriting.closeFile()
        lease = nil
        child.terminate()
        let run = generation
        DispatchQueue.main.asyncAfter(deadline: .now() + 8) { [weak self] in
            guard let self = self, self.generation == run, let callback = self.onStopped else { return }
            self.onStopped = nil
            callback(!child.isRunning)
        }
    }
}
