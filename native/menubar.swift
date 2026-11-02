/*
 * Myna menu bar host.
 *
 * This is deliberately small: a status item, a Carbon global hotkey, and a
 * JSON-lines pipe to the Node daemon. It does not touch the microphone or the
 * model. The daemon owns those, which keeps the UI responsive and lets the
 * terminal be closed.
 *
 * The daemon is spawned as a child process. If this app quits, the child sees
 * EOF on stdin and shuts down.
 */

import AppKit
import Carbon
import Foundation

private let HOTKEY_ID: UInt32 = 1

private final class AppDelegate: NSObject, NSApplicationDelegate {
    var statusItem: NSStatusItem!
    var menu = NSMenu()
    var status = "starting"
    var mic = "cold"
    var detail = ""
    var lastText: String?
    var hotkeyLabel = ""
    var hotkeyError: String?
    var soundsEnabled = true
    var startedAt = Date()
    var recordingStartedAt: Date?
    var flashUntil: Date?
    var flashWork: DispatchWorkItem?
    var timer: Timer?
    var crestPhase = 0
    var animationTick = 0

    var homeURL: URL!
    var stateURL: URL!
    var logURL: URL!
    var config: [String: Any] = [:]
    var nodePath = ""
    var daemonScript = ""

    var daemon: Process?
    var daemonStdin: Pipe?
    var daemonStdout: Pipe?
    var daemonLogHandle: FileHandle?
    var readBuffer = Data()
    var terminating = false
    var hotKeyRef: EventHotKeyRef?
    var hotKeyHandler: EventHandlerRef?
    var signalSources: [DispatchSourceSignal] = []
    var lastErrorSound = Date.distantPast

    let tink = NSSound(contentsOfFile: "/System/Library/Sounds/Tink.aiff", byReference: true)
    let pop = NSSound(contentsOfFile: "/System/Library/Sounds/Pop.aiff", byReference: true)
    let basso = NSSound(contentsOfFile: "/System/Library/Sounds/Basso.aiff", byReference: true)

    // MARK: - launch

    func applicationDidFinishLaunching(_ notification: Notification) {
        guard loadConfiguration() else { return }
        guard singleInstance() else { return }

        NSApp.setActivationPolicy(.accessory)
        setupStatusItem()
        setupSignalHandlers()
        setupTimer()
        registerHotkey()
        refresh()

        writeState()
        startDaemon()
    }

    func applicationWillTerminate(_ notification: Notification) {
        cleanup()
    }

    private func loadConfiguration() -> Bool {
        let arguments = CommandLine.arguments
        var configPath = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".myna/menubar.json")
        if let index = arguments.firstIndex(of: "--config"), index + 1 < arguments.count {
            configPath = URL(fileURLWithPath: arguments[index + 1])
        }

        guard
            let data = try? Data(contentsOf: configPath),
            let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let node = object["node"] as? String,
            let daemon = object["daemon"] as? String,
            let home = object["home"] as? String
        else {
            alert(
                "Myna could not start",
                "The menu bar configuration is missing or invalid.\n\nRun `myna daemon start` from a terminal."
            )
            NSApp.terminate(nil)
            return false
        }

        config = object
        nodePath = node
        daemonScript = daemon
        homeURL = URL(fileURLWithPath: home, isDirectory: true)
        stateURL = homeURL.appendingPathComponent("daemon.json")
        logURL = homeURL.appendingPathComponent("daemon.log")
        hotkeyLabel = object["hotkeyLabel"] as? String ?? ""

        if let defaults = UserDefaults.standard.object(forKey: "sounds") as? Bool {
            soundsEnabled = defaults
        } else {
            soundsEnabled = (object["sounds"] as? Bool) ?? true
        }

        guard FileManager.default.fileExists(atPath: nodePath) else {
            alert("Myna could not start", "Node was not found at:\n\(nodePath)")
            NSApp.terminate(nil)
            return false
        }
        guard FileManager.default.fileExists(atPath: daemonScript) else {
            alert("Myna could not start", "The daemon was not found at:\n\(daemonScript)")
            NSApp.terminate(nil)
            return false
        }
        return true
    }

    private func singleInstance() -> Bool {
        let bundleID = Bundle.main.bundleIdentifier ?? "com.wprudencio.myna"
        let others = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID)
            .filter { $0.processIdentifier != getpid() }
        if others.isEmpty { return true }
        NSApp.activate(ignoringOtherApps: true)
        alert("Myna is already running", "Use the microphone icon in the menu bar.")
        NSApp.terminate(nil)
        return false
    }

    private func alert(_ title: String, _ message: String) {
        let box = NSAlert()
        box.messageText = title
        box.informativeText = message
        box.alertStyle = .warning
        box.runModal()
    }

    // MARK: - status item and menu

    private func setupStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.imagePosition = .imageLeading
        statusItem.button?.toolTip = "Myna"
        statusItem.menu = menu
        menu.autoenablesItems = false
    }

    private func mynaMark(color: NSColor?, phase: Int = 0) -> NSImage {
        let image = NSImage(size: NSSize(width: 18, height: 18))
        image.lockFocus()
        defer { image.unlockFocus() }

        (color ?? .black).setFill()

        let head = NSBezierPath(ovalIn: NSRect(x: 3.1, y: 3.9, width: 10.3, height: 10.3))
        head.fill()

        let beak = NSBezierPath()
        beak.move(to: NSPoint(x: 11.7, y: 8.7))
        beak.line(to: NSPoint(x: 17.1, y: 9.5))
        beak.line(to: NSPoint(x: 12.1, y: 11.2))
        beak.close()
        beak.fill()

        let patterns = [
            [3.1, 4.8, 2.4],
            [4.7, 2.4, 3.9],
            [2.5, 3.8, 5.0],
            [3.9, 3.1, 2.5],
        ]
        let bars = patterns[phase % patterns.count]
        for (index, height) in bars.enumerated() {
            let bar = NSBezierPath(
                roundedRect: NSRect(x: 4.3 + CGFloat(index) * 2.6, y: 13.0, width: 1.5, height: height),
                xRadius: 0.75,
                yRadius: 0.75
            )
            bar.fill()
        }

        if let context = NSGraphicsContext.current {
            context.compositingOperation = .clear
            NSBezierPath(ovalIn: NSRect(x: 7.7, y: 9.0, width: 1.8, height: 1.8)).fill()
            context.compositingOperation = .sourceOver
        }

        image.isTemplate = color == nil
        return image
    }

    private func statusTitle() -> String {
        switch status {
        case "starting": return "Starting…"
        case "loading": return "Loading…"
        case "arming": return "Warming microphone…"
        case "recording": return "Recording…"
        case "transcribing": return "Transcribing…"
        case "error": return "Needs attention"
        case "idle": return "Ready"
        default: return status.capitalized
        }
    }

    private func updateTitle() {
        guard let button = statusItem.button else { return }
        switch status {
        case "arming", "transcribing":
            button.title = " …"
        case "recording":
            if let start = recordingStartedAt {
                let elapsed = max(0, Date().timeIntervalSince(start))
                let minutes = Int(elapsed) / 60
                let seconds = Int(elapsed) % 60
                button.title = String(format: " %d:%02d", minutes, seconds)
            } else {
                button.title = " 0:00"
            }
        default:
            button.title = ""
        }
        button.toolTip = "Myna — \(statusTitle())"
    }

    private func menuIcon() -> NSImage {
        if daemon == nil && status != "starting" {
            return mynaMark(color: .systemOrange)
        }
        switch status {
        case "starting", "loading", "arming":
            return mynaMark(color: nil)
        case "recording":
            return mynaMark(color: .systemRed, phase: crestPhase)
        case "transcribing":
            return mynaMark(color: .systemOrange, phase: crestPhase)
        case "error":
            return mynaMark(color: .systemOrange)
        case "idle":
            if let until = flashUntil, Date() < until {
                return mynaMark(color: .systemGreen)
            }
            return mynaMark(color: nil)
        default:
            return mynaMark(color: nil)
        }
    }

    private func refreshIcon() {
        statusItem.button?.image = menuIcon()
    }

    private func refresh() {
        refreshIcon()
        updateTitle()
        rebuildMenu()
    }

    private func timerTick() {
        animationTick += 1
        if status == "recording" || status == "transcribing" {
            crestPhase = (crestPhase + 1) % 4
            refreshIcon()
        }
        if animationTick % 4 == 0 {
            updateTitle()
        }
    }

    private func rebuildMenu() {
        menu.removeAllItems()

        let header = NSMenuItem(title: "Myna — \(statusTitle())", action: nil, keyEquivalent: "")
        header.isEnabled = false
        menu.addItem(header)

        if !detail.isEmpty {
            let line = NSMenuItem(title: truncate(detail, 72), action: nil, keyEquivalent: "")
            line.isEnabled = false
            menu.addItem(line)
        }
        if let hotkeyError = hotkeyError {
            let line = NSMenuItem(title: truncate(hotkeyError, 72), action: nil, keyEquivalent: "")
            line.isEnabled = false
            menu.addItem(line)
        }

        menu.addItem(.separator())

        let working = status == "recording" || status == "arming"
        let toggle = NSMenuItem(
            title: working ? "Stop Recording" : "Start Recording",
            action: #selector(toggleRecording),
            keyEquivalent: ""
        )
        toggle.target = self
        toggle.isEnabled = daemon != nil && status != "transcribing"
        menu.addItem(toggle)

        let copy = NSMenuItem(title: "Copy Last Transcript", action: #selector(copyLast), keyEquivalent: "")
        copy.target = self
        copy.isEnabled = lastText != nil
        menu.addItem(copy)

        if let lastText = lastText, !lastText.isEmpty {
            let preview = NSMenuItem(title: "“\(truncate(lastText, 68))”", action: nil, keyEquivalent: "")
            preview.isEnabled = false
            menu.addItem(preview)
        }

        menu.addItem(.separator())

        let micTitle = "Microphone: \(mic == "warm" ? "warm" : mic == "warming" ? "starting…" : "cold")"
        let micItem = NSMenuItem(title: micTitle, action: nil, keyEquivalent: "")
        micItem.isEnabled = false
        menu.addItem(micItem)

        let release = NSMenuItem(title: "Release Microphone", action: #selector(releaseMicrophone), keyEquivalent: "")
        release.target = self
        release.isEnabled = daemon != nil && (mic == "warm" || mic == "warming") && !working
        menu.addItem(release)

        let sounds = NSMenuItem(title: "Sounds", action: #selector(toggleSounds), keyEquivalent: "")
        sounds.target = self
        sounds.state = soundsEnabled ? .on : .off
        menu.addItem(sounds)

        let micSettings = NSMenuItem(title: "Open Microphone Settings…", action: #selector(openMicrophoneSettings), keyEquivalent: "")
        micSettings.target = self
        menu.addItem(micSettings)

        if daemon == nil || status == "error" {
            let restart = NSMenuItem(title: "Restart Daemon", action: #selector(restartDaemon), keyEquivalent: "")
            restart.target = self
            menu.addItem(restart)
        }

        if !hotkeyLabel.isEmpty {
            let shortcut = NSMenuItem(title: "Shortcut: \(hotkeyLabel)", action: nil, keyEquivalent: "")
            shortcut.isEnabled = false
            menu.addItem(shortcut)
        }

        menu.addItem(.separator())
        let quit = NSMenuItem(title: "Quit Myna", action: #selector(quitMyna), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)
    }

    private func truncate(_ text: String, _ count: Int) -> String {
        let clean = text.replacingOccurrences(of: "\n", with: " ")
            .replacingOccurrences(of: "\r", with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return clean.count > count ? String(clean.prefix(count - 1)) + "…" : clean
    }

    // MARK: - hotkey

    private func registerHotkey() {
        let keyCode = (config["keyCode"] as? Int) ?? 49
        let modifiers = (config["modifiers"] as? Int) ?? 6144
        let signature = OSType(0x50524B54) // 'PRKT'

        var eventType = EventTypeSpec(
            eventClass: OSType(kEventClassKeyboard),
            eventKind: UInt32(kEventHotKeyPressed)
        )
        let callback: EventHandlerUPP = { _, _, userData in
            guard let userData = userData else { return noErr }
            let delegate = Unmanaged<AppDelegate>.fromOpaque(userData).takeUnretainedValue()
            DispatchQueue.main.async {
                delegate.hotkeyPressed()
            }
            return noErr
        }
        let target = GetApplicationEventTarget()
        let installStatus = withUnsafePointer(to: &eventType) { pointer in
            InstallEventHandler(
                target,
                callback,
                1,
                pointer,
                Unmanaged.passUnretained(self).toOpaque(),
                &hotKeyHandler
            )
        }
        guard installStatus == noErr else {
            hotkeyError = "Could not install the shortcut handler."
            return
        }

        let hotKeyID = EventHotKeyID(signature: signature, id: HOTKEY_ID)
        let status = RegisterEventHotKey(
            UInt32(keyCode),
            UInt32(modifiers),
            hotKeyID,
            target,
            0,
            &hotKeyRef
        )
        if status != noErr {
            hotkeyError = "Shortcut \(hotkeyLabel) is unavailable."
        }
    }

    private func hotkeyPressed() {
        if daemon == nil {
            startDaemon()
            return
        }
        send(["type": "toggle"])
    }

    // MARK: - daemon process

    private func startDaemon() {
        if daemon != nil { return }
        status = "starting"
        detail = ""
        refresh()
        writeState()

        FileManager.default.createFile(atPath: logURL.path, contents: nil)
        let logHandle = try? FileHandle(forWritingTo: logURL)
        logHandle?.seekToEndOfFile()

        let process = Process()
        process.executableURL = URL(fileURLWithPath: nodePath)
        process.arguments = [daemonScript, "--home", homeURL.path]
        var environment = ProcessInfo.processInfo.environment
        let path = environment["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin"
        environment["PATH"] = "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:\(path)"
        process.environment = environment

        let stdinPipe = Pipe()
        let stdoutPipe = Pipe()
        process.standardInput = stdinPipe
        process.standardOutput = stdoutPipe
        process.standardError = logHandle ?? FileHandle.nullDevice

        process.terminationHandler = { [weak self] finished in
            DispatchQueue.main.async {
                guard let self = self, self.daemon === finished else { return }
                self.daemonExited()
            }
        }

        do {
            try process.run()
        } catch {
            status = "error"
            detail = "Could not start the daemon: \(error.localizedDescription)"
            daemon = nil
            daemonLogHandle = logHandle
            refresh()
            writeState()
            return
        }

        daemon = process
        daemonStdin = stdinPipe
        daemonStdout = stdoutPipe
        daemonLogHandle = logHandle
        readBuffer.removeAll()
        readDaemon(stdoutPipe)
        status = "starting"
        detail = ""
        refresh()
        writeState()
    }

    private func readDaemon(_ pipe: Pipe) {
        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            guard let self = self else { return }
            let data = handle.availableData
            if data.isEmpty {
                handle.readabilityHandler = nil
                DispatchQueue.main.async {
                    guard self.daemonStdout === pipe else { return }
                    self.daemonExited()
                }
                return
            }
            DispatchQueue.main.async {
                guard self.daemonStdout === pipe else { return }
                self.consume(data)
            }
        }
    }

    private func consume(_ data: Data) {
        readBuffer.append(data)
        while let newline = readBuffer.firstIndex(of: 0x0a) {
            let line = readBuffer.prefix(upTo: newline)
            readBuffer.removeSubrange(...newline)
            guard !line.isEmpty, let object = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else {
                continue
            }
            handleMessage(object)
        }
    }

    private func handleMessage(_ message: [String: Any]) {
        switch message["type"] as? String {
        case "status":
            let next = (message["state"] as? String) ?? "idle"
            let previous = status
            status = next
            mic = (message["mic"] as? String) ?? mic
            detail = (message["detail"] as? String) ?? ""
            if let progress = message["progress"] as? Double, progress > 0 {
                detail = "Downloading model · \(Int(progress * 100))%"
            }
            if next == "recording", previous != "recording" {
                recordingStartedAt = Date()
                flashUntil = nil
                flashWork?.cancel()
                play(tink)
            } else if next != "recording" && next != "arming" {
                recordingStartedAt = nil
            }
            if next == "error" && previous != "error" {
                play(basso)
            }
            if next == "recording" || next == "arming" || next == "transcribing" {
                flashUntil = nil
                flashWork?.cancel()
            }
            refresh()
            writeState()
        case "last":
            if let text = message["text"] as? String, !text.isEmpty {
                lastText = text
                flashUntil = Date().addingTimeInterval(1.6)
                play(pop)
                copyTextToPasteboard(text)
                flashWork?.cancel()
                let work = DispatchWorkItem { [weak self] in
                    self?.flashUntil = nil
                    self?.refresh()
                }
                flashWork = work
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.7, execute: work)
                refresh()
                writeState()
            }
        default:
            break
        }
    }

    private func send(_ object: [String: Any]) {
        guard let pipe = daemonStdin, daemon != nil else { return }
        guard var data = try? JSONSerialization.data(withJSONObject: object) else { return }
        data.append(0x0a)
        do {
            try pipe.fileHandleForWriting.write(contentsOf: data)
        } catch {
            daemonExited()
        }
    }

    private func daemonExited() {
        if terminating { return }
        if daemon == nil { return }
        daemon = nil
        daemonStdin = nil
        daemonStdout = nil
        status = "error"
        detail = "The daemon stopped."
        mic = "cold"
        recordingStartedAt = nil
        play(basso)
        refresh()
        writeState()
    }

    private func copyTextToPasteboard(_ text: String) {
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.setString(text, forType: .string)
    }

    // MARK: - state file

    private func writeState() {
        guard stateURL != nil else { return }
        var object: [String: Any] = [
            "appPid": Int(getpid()),
            "status": status,
            "mic": mic,
            "hotkey": hotkeyLabel,
            "startedAt": Int(startedAt.timeIntervalSince1970 * 1000),
        ]
        if let process = daemon {
            object["daemonPid"] = Int(process.processIdentifier)
        }
        if lastText != nil {
            object["lastAt"] = Int(Date().timeIntervalSince1970 * 1000)
        }
        if !detail.isEmpty, status == "error" {
            object["message"] = detail
        }
        if let hotkeyError = hotkeyError {
            object["hotkeyError"] = hotkeyError
        }
        if let data = try? JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted]) {
            try? data.write(to: stateURL, options: .atomic)
        }
    }

    private func removeState() {
        guard stateURL != nil else { return }
        try? FileManager.default.removeItem(at: stateURL)
    }

    // MARK: - sounds

    private func play(_ sound: NSSound?) {
        guard soundsEnabled else { return }
        sound?.stop()
        sound?.play()
    }

    // MARK: - menu actions

    @objc private func toggleRecording() {
        if daemon == nil {
            startDaemon()
            return
        }
        send(["type": "toggle"])
    }

    @objc private func copyLast() {
        guard let text = lastText else { return }
        copyTextToPasteboard(text)
        flashUntil = Date().addingTimeInterval(1.2)
        flashWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            self?.flashUntil = nil
            self?.refresh()
        }
        flashWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.3, execute: work)
        play(pop)
        refresh()
    }

    @objc private func releaseMicrophone() {
        send(["type": "releaseMic"])
    }

    @objc private func toggleSounds() {
        soundsEnabled.toggle()
        UserDefaults.standard.set(soundsEnabled, forKey: "sounds")
        rebuildMenu()
    }

    @objc private func openMicrophoneSettings() {
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone") {
            NSWorkspace.shared.open(url)
        }
    }

    @objc private func restartDaemon() {
        if let process = daemon {
            send(["type": "shutdown"])
            process.terminate()
        }
        daemon = nil
        daemonStdin = nil
        daemonStdout = nil
        recordingStartedAt = nil
        mic = "cold"
        status = "starting"
        detail = ""
        refresh()
        writeState()
        startDaemon()
    }

    @objc private func quitMyna() {
        shutdown()
    }

    // MARK: - lifecycle

    private func setupTimer() {
        let timer = Timer(timeInterval: 0.25, repeats: true) { [weak self] _ in
            self?.timerTick()
        }
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }

    private func setupSignalHandlers() {
        for signalNumber in [SIGTERM, SIGINT] {
            signal(signalNumber, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .main)
            source.setEventHandler { [weak self] in
                self?.shutdown()
            }
            source.resume()
            signalSources.append(source)
        }
    }

    private func shutdown() {
        if terminating { return }
        terminating = true
        timer?.invalidate()
        if hotKeyRef != nil {
            UnregisterEventHotKey(hotKeyRef)
            hotKeyRef = nil
        }
        send(["type": "shutdown"])
        removeState()

        let process = daemon
        daemon = nil
        daemonStdin = nil
        daemonStdout = nil
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
            if let process = process, process.isRunning {
                process.terminate()
            }
            NSApp.terminate(nil)
        }
    }

    private func cleanup() {
        timer?.invalidate()
        timer = nil
        if let process = daemon, process.isRunning {
            process.terminate()
        }
        daemon = nil
        removeState()
    }
}

private let application = NSApplication.shared
private let appDelegate = AppDelegate()
application.delegate = appDelegate
application.setActivationPolicy(.accessory)
application.run()
