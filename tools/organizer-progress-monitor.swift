import Cocoa
import Foundation
import WebKit

// Native window wrapper around the proven HTML progress renderer. It reads the
// progress file only and passes the raw JSON to JavaScript for display.
final class Monitor: NSObject, NSApplicationDelegate {
    let progressPath: String?
    let sshHost: String?
    let sshPort: String?
    let sshPath: String?
    var remoteFetchInFlight = false
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 600, height: 255), styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
    let webView: WKWebView
    var timer: Timer?

    init(path: String) {
        if let components = URLComponents(string: path), components.scheme == "ssh", let host = components.host {
            progressPath = nil
            sshHost = host
            sshPort = components.port.map(String.init) ?? "22"
            sshPath = components.percentEncodedPath.removingPercentEncoding ?? components.path
        } else {
            progressPath = path
            sshHost = nil
            sshPort = nil
            sshPath = nil
        }
        let configuration = WKWebViewConfiguration()
        let controller = WKUserContentController()
        controller.addUserScript(WKUserScript(source: "window.__nativeMonitor = true;", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        configuration.userContentController = controller
        webView = WKWebView(frame: .zero, configuration: configuration)
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        window.title = "Photo Organizer Progress"
        webView.translatesAutoresizingMaskIntoConstraints = false
        window.contentView = webView
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        let htmlPath = "/Users/johnhausman/source/immich/tools/organizer-progress-monitor.html"
        if let html = try? String(contentsOfFile: htmlPath, encoding: .utf8) { webView.loadHTMLString(html, baseURL: URL(fileURLWithPath: htmlPath).deletingLastPathComponent()) }
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.refresh() }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func refresh() {
        if let progressPath, let data = try? Data(contentsOf: URL(fileURLWithPath: progressPath)), let json = String(data: data, encoding: .utf8) {
            webView.evaluateJavaScript("window.renderProgress(\(json));", completionHandler: nil)
            return
        }
        guard !remoteFetchInFlight, let sshHost, let sshPort, let sshPath else { return }
        remoteFetchInFlight = true
        DispatchQueue.global(qos: .utility).async { [weak self] in
            defer { self?.remoteFetchInFlight = false }
            let output = Pipe()
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/ssh")
            process.arguments = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "-p", sshPort, sshHost, "cat", sshPath]
            process.standardOutput = output
            process.standardError = FileHandle.nullDevice
            do {
                try process.run()
                process.waitUntilExit()
                guard process.terminationStatus == 0 else { return }
                let data = output.fileHandleForReading.readDataToEndOfFile()
                guard let json = String(data: data, encoding: .utf8), !json.isEmpty else { return }
                DispatchQueue.main.async { self?.webView.evaluateJavaScript("window.renderProgress(\(json));", completionHandler: nil) }
            } catch { return }
        }
    }
}

guard let path = CommandLine.arguments.dropFirst().first, !path.isEmpty else { fputs("Usage: organizer-progress-monitor PATH_TO_PROGRESS_JSON | ssh://USER@HOST:PORT/REMOTE_PROGRESS_JSON\n", stderr); exit(2) }
let app = NSApplication.shared
let monitor = Monitor(path: path)
app.delegate = monitor
app.run()
