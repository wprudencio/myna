/*
 * Microphone helper for Myna.
 *
 * macOS gives command line tools no easy way to read the default input at a
 * fixed sample rate, so this tiny AVFoundation program does one thing: it
 * captures the default input, converts it to 16 kHz mono signed 16-bit PCM,
 * and writes the samples to stdout. The Node side spawns it once and keeps it
 * warm while the TUI is open.
 *
 *   recorder --info   print {"name":...,"status":...} and exit
 *   recorder          stream raw LE s16 samples at 16 kHz to stdout
 *
 * The parent stops it with SIGINT. `ready` appears on stderr as soon as the
 * first buffer has been written, so the UI knows when the microphone is live.
 */

import AVFoundation
import Foundation

func fail(_ message: String) -> Never {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
    exit(1)
}

func statusName(_ status: AVAuthorizationStatus) -> String {
    switch status {
    case .authorized: return "authorized"
    case .denied: return "denied"
    case .restricted: return "restricted"
    case .notDetermined: return "notDetermined"
    @unknown default: return "unknown"
    }
}

if CommandLine.arguments.contains("--info") {
    let device = AVCaptureDevice.default(for: .audio)
    let info: [String: Any] = [
        "name": device?.localizedName ?? "default input",
        "id": device?.uniqueID ?? "",
        "status": statusName(AVCaptureDevice.authorizationStatus(for: .audio)),
    ]
    let data = try! JSONSerialization.data(withJSONObject: info)
    print(String(data: data, encoding: .utf8)!)
    exit(0)
}

/* Ask for permission before touching the engine. Without this, a denied
 * process still gets a working engine that silently returns zeros. */
let status = AVCaptureDevice.authorizationStatus(for: .audio)
if status == .denied || status == .restricted {
    fail("microphone-permission-denied")
}
if status == .notDetermined {
    FileHandle.standardError.write("permission-request\n".data(using: .utf8)!)
    let semaphore = DispatchSemaphore(value: 0)
    var granted = false
    AVCaptureDevice.requestAccess(for: .audio) { ok in
        granted = ok
        semaphore.signal()
    }
    _ = semaphore.wait(timeout: .now() + 120)
    if !granted {
        fail("microphone-permission-denied")
    }
}

let engine = AVAudioEngine()
let input = engine.inputNode
let inputFormat = input.inputFormat(forBus: 0)

guard inputFormat.channelCount > 0, inputFormat.sampleRate > 0 else {
    fail("no-audio-input")
}
guard
    let outputFormat = AVAudioFormat(
        commonFormat: .pcmFormatInt16,
        sampleRate: 16_000,
        channels: 1,
        interleaved: true
    ),
    let converter = AVAudioConverter(from: inputFormat, to: outputFormat)
else {
    fail("cannot-convert-input")
}
converter.downmix = true
converter.sampleRateConverterQuality = 127

let ratio = 16_000.0 / inputFormat.sampleRate
let output = FileHandle.standardOutput
var announced = false

func emit(_ buffer: AVAudioPCMBuffer) {
    guard buffer.frameLength > 0 else { return }
    guard let samples = buffer.int16ChannelData?[0] else { return }
    output.write(Data(bytes: samples, count: Int(buffer.frameLength) * 2))
    if !announced {
        announced = true
        FileHandle.standardError.write("ready\n".data(using: .utf8)!)
    }
}

input.installTap(onBus: 0, bufferSize: 2048, format: inputFormat) { buffer, _ in
    let capacity = AVAudioFrameCount(ceil(Double(buffer.frameLength) * ratio)) + 128
    guard let output = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: capacity) else { return }
    var supplied = false
    var error: NSError?
    let result = converter.convert(to: output, error: &error) { _, outStatus in
        if supplied {
            outStatus.pointee = .noDataNow
            return nil
        }
        supplied = true
        outStatus.pointee = .haveData
        return buffer
    }
    if result == .haveData || result == .inputRanDry {
        emit(output)
    } else if result == .error {
        let message = error?.localizedDescription ?? "unknown conversion error"
        FileHandle.standardError.write(("convert-error: \(message)\n").data(using: .utf8)!)
    }
}

signal(SIGINT, SIG_IGN)
signal(SIGTERM, SIG_IGN)

let sigint = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
sigint.setEventHandler {
    engine.stop()
    input.removeTap(onBus: 0)
    exit(0)
}
sigint.resume()

let sigterm = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
sigterm.setEventHandler {
    engine.stop()
    exit(0)
}
sigterm.resume()

FileHandle.standardError.write(
    "device \(AVCaptureDevice.default(for: .audio)?.localizedName ?? "default")\n"
        .data(using: .utf8)!
)
FileHandle.standardError.write(
    "format \(Int(inputFormat.sampleRate)) \(inputFormat.channelCount)\n".data(using: .utf8)!
)

engine.prepare()
do {
    try engine.start()
} catch {
    fail("microphone-start-failed: \(error.localizedDescription)")
}

RunLoop.main.run()
