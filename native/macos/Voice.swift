import AppKit
import AVFoundation
import Carbon
import Foundation

struct VoiceCommand {
    let type: String
    let turnID: String?

    static func parse(_ data: Data) -> VoiceCommand? {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = object["type"] as? String else { return nil }
        if type == "shutdown", Set(object.keys) == ["type"] { return VoiceCommand(type: type, turnID: nil) }
        guard ["start", "stop", "cancel", "settled"].contains(type), Set(object.keys) == ["type", "turnId"],
              let id = object["turnId"] as? String,
              (1...64).contains(id.utf8.count),
              id.utf8.allSatisfy({ $0 == 45 || (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) }) else { return nil }
        return VoiceCommand(type: type, turnID: id)
    }
}

// The converter persists across input buffers so resampling never resets at
// chunk boundaries. The only output format is provider-ready PCM16LE/24k/mono.
final class VoicePCMConverter {
    private let converter: AVAudioConverter
    private let outputFormat: AVAudioFormat
    private let inputSampleRate: Double
    private var inputFrames: UInt64 = 0
    private var outputFrames: UInt64 = 0

    init?(inputFormat: AVAudioFormat) {
        guard inputFormat.sampleRate > 0, inputFormat.channelCount > 0,
              let format = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 24_000, channels: 1, interleaved: true),
              let converter = AVAudioConverter(from: inputFormat, to: format) else { return nil }
        self.outputFormat = format
        self.converter = converter
        self.inputSampleRate = inputFormat.sampleRate
        converter.primeMethod = .none
    }

    func convert(_ input: AVAudioPCMBuffer?, end: Bool = false) throws -> Data {
        if let input { inputFrames += UInt64(input.frameLength) }
        let capacity = input.map { AVAudioFrameCount(ceil(Double($0.frameLength) * 24_000 / $0.format.sampleRate)) + 256 } ?? 4096
        guard capacity <= 65_536, let output = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: capacity) else {
            throw NSError(domain: "VoiceCapture", code: 1)
        }
        var supplied = false
        var error: NSError?
        let status = converter.convert(to: output, error: &error) { _, inputStatus in
            if !supplied, let input {
                supplied = true
                inputStatus.pointee = .haveData
                return input
            }
            inputStatus.pointee = end ? .endOfStream : .noDataNow
            return nil
        }
        guard status != .error, error == nil, let samples = output.int16ChannelData?[0] else {
            throw NSError(domain: "VoiceCapture", code: 2)
        }
        // AVAudioConverter can append filter padding at end-of-stream. Do not
        // send extra silence beyond the actual captured duration.
        let expectedFrames = UInt64((Double(inputFrames) * 24_000 / inputSampleRate).rounded(.down))
        let count = end ? min(UInt64(output.frameLength), expectedFrames > outputFrames ? expectedFrames - outputFrames : 0) : UInt64(output.frameLength)
        outputFrames += count
        return Data(bytes: samples, count: Int(count) * 2)
    }
}

final class VoiceCapture {
    private let engine = AVAudioEngine()
    private let lock = NSLock()
    private var chunks: [Data] = []
    private var queuedBytes = 0
    private var failed = false
    private var accepting = true
    private var tapped = false
    private var converter: VoicePCMConverter?

    func start() throws {
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard let converter = VoicePCMConverter(inputFormat: format) else {
            throw NSError(domain: "VoiceCapture", code: 3)
        }
        self.converter = converter
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            guard let self else { return }
            self.lock.lock()
            defer { self.lock.unlock() }
            guard self.accepting, !self.failed else { return }
            do { self.enqueue(try converter.convert(buffer)) }
            catch { self.failed = true }
        }
        tapped = true
        try engine.start()
    }

    // Called only with the lock held. A stalled parent never grows memory or
    // makes the real-time callback wait for a pipe write.
    private func enqueue(_ data: Data) {
        guard !data.isEmpty else { return }
        if data.count > 65_536 || queuedBytes + data.count > 256 * 1024 {
            failed = true
            return
        }
        chunks.append(data)
        queuedBytes += data.count
    }

    func drain() -> (chunks: [Data], failed: Bool) {
        lock.lock()
        defer { lock.unlock() }
        let result = (chunks, failed)
        chunks.removeAll(keepingCapacity: true)
        queuedBytes = 0
        return result
    }

    func stop(discard: Bool) {
        engine.stop()
        if tapped { engine.inputNode.removeTap(onBus: 0); tapped = false }
        lock.lock()
        accepting = false
        if discard { chunks.removeAll(); queuedBytes = 0 }
        else if let converter, !failed {
            do { enqueue(try converter.convert(nil, end: true)) }
            catch { failed = true }
        }
        lock.unlock()
        engine.reset()
    }
}

// Nonblocking stdout is bounded independently of the audio callback queue.
// EOF, broken pipes, or backpressure terminate the helper and close the mic.
final class VoiceOutput {
    private var pending = Data()
    private(set) var failed = false
    init() { _ = fcntl(STDOUT_FILENO, F_SETFL, fcntl(STDOUT_FILENO, F_GETFL) | O_NONBLOCK) }
    func send(_ event: [String: Any]) {
        guard !failed, var data = try? JSONSerialization.data(withJSONObject: event, options: [.sortedKeys]) else { return }
        data.append(10)
        guard pending.count + data.count <= 512 * 1024 else { failed = true; return }
        pending.append(data)
        flush()
    }
    func flush() {
        while !pending.isEmpty && !failed {
            let written = pending.withUnsafeBytes { Darwin.write(STDOUT_FILENO, $0.baseAddress, $0.count) }
            if written > 0 { pending.removeFirst(written) }
            else if written < 0 && (errno == EAGAIN || errno == EINTR) { return }
            else { failed = true }
        }
    }
}

final class VoiceSession {
    private let output = VoiceOutput()
    private var running = true
    private var input = Data()
    private var handler: EventHandlerRef?
    private var toggleHotkey: EventHotKeyRef?
    private var escapeHotkey: EventHotKeyRef?
    private var down: Set<UInt32> = []
    private var turnID: String?
    private var capture: VoiceCapture?
    private var waitingForPermission = false
    private var captureDeadline: Date?
    private var pointerSampler = PointerTrajectorySampler()

    func run() {
        signal(SIGPIPE, SIG_IGN)
        let signals = [SIGINT, SIGTERM].map { number -> DispatchSourceSignal in
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
            source.setEventHandler { [weak self] in self?.running = false }
            source.resume()
            return source
        }
        defer {
            clearTurn(discard: true)
            if let toggleHotkey { UnregisterEventHotKey(toggleHotkey) }
            if let handler { RemoveEventHandler(handler) }
            signals.forEach { $0.cancel() }
        }
        var eventTypes = [
            EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed)),
            EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyReleased)),
        ]
        let installed = InstallEventHandler(GetApplicationEventTarget(), { _, event, context in
            guard let context, let event else { return OSStatus(eventNotHandledErr) }
            return Unmanaged<VoiceSession>.fromOpaque(context).takeUnretainedValue().keyEvent(event)
        }, eventTypes.count, &eventTypes, Unmanaged.passUnretained(self).toOpaque(), &handler)
        guard installed == noErr,
              register(key: UInt32(kVK_Space), modifiers: UInt32(controlKey | shiftKey), id: 1, ref: &toggleHotkey) else {
            output.send(["type": "error", "code": "hotkey-unavailable"])
            return
        }
        _ = fcntl(STDIN_FILENO, F_SETFL, fcntl(STDIN_FILENO, F_GETFL) | O_NONBLOCK)
        output.send(["type": "ready"])
        while running && !output.failed {
            readCommands()
            samplePointer()
            drainAudio()
            if let deadline = captureDeadline, Date() >= deadline { fail("capture-failed") }
            var event: EventRef?
            if ReceiveNextEvent(eventTypes.count, &eventTypes, 0.01, true, &event) == noErr, let event {
                SendEventToEventTarget(event, GetApplicationEventTarget())
                ReleaseEvent(event)
            }
            RunLoop.current.run(until: Date().addingTimeInterval(0.001))
            output.flush()
        }
    }

    private func register(key: UInt32, modifiers: UInt32, id: UInt32, ref: inout EventHotKeyRef?) -> Bool {
        RegisterEventHotKey(key, modifiers, EventHotKeyID(signature: 0x4f534d45, id: id), GetApplicationEventTarget(), 0, &ref) == noErr && ref != nil
    }

    private func keyEvent(_ event: EventRef) -> OSStatus {
        var key = EventHotKeyID()
        guard GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), nil,
            MemoryLayout<EventHotKeyID>.size, nil, &key) == noErr, key.signature == 0x4f534d45 else { return OSStatus(eventNotHandledErr) }
        if GetEventKind(event) == UInt32(kEventHotKeyReleased) { down.remove(key.id); return noErr }
        guard down.insert(key.id).inserted else { return noErr }
        if key.id == 1 {
            if turnID != nil { pointerSampler.end() }
            output.send(["type": "toggle"])
        }
        else if key.id == 2, turnID != nil {
            // Stop locally immediately, then retain the identity until the
            // parent's cancel command can receive an explicit acknowledgment.
            waitingForPermission = false
            captureDeadline = nil
            pointerSampler.end()
            capture?.stop(discard: true)
            capture = nil
            output.send(["type": "cancel"])
        }
        return noErr
    }

    private func readCommands() {
        var bytes = [UInt8](repeating: 0, count: 4096)
        let count = Darwin.read(STDIN_FILENO, &bytes, bytes.count)
        if count == 0 { running = false; return }
        if count < 0 {
            if errno != EAGAIN && errno != EINTR { running = false }
            return
        }
        input.append(contentsOf: bytes.prefix(count))
        guard input.count <= 16_384 else { fail("invalid-command"); running = false; return }
        while let newline = input.firstIndex(of: 10), running {
            let line = Data(input[..<newline])
            input.removeSubrange(...newline)
            guard line.count <= 1024, let command = VoiceCommand.parse(line) else {
                fail("invalid-command"); running = false; return
            }
            process(command)
        }
    }

    private func process(_ command: VoiceCommand) {
        if command.type == "shutdown" { running = false; return }
        if command.type == "cancel", turnID == nil, let id = command.turnID {
            output.send(["type": "audio-stopped", "turnId": id])
            return
        }
        if command.type == "start" {
            guard turnID == nil else { fail("invalid-command"); return }
            turnID = command.turnID
            pointerSampler.begin()
            guard register(key: UInt32(kVK_Escape), modifiers: 0, id: 2, ref: &escapeHotkey) else {
                fail("hotkey-unavailable"); return
            }
            captureDeadline = Date().addingTimeInterval(120)
            if AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined {
                waitingForPermission = true
                let requestedTurn = turnID
                AVCaptureDevice.requestAccess(for: .audio) { [weak self] _ in
                    DispatchQueue.main.async {
                        guard let self, self.running, self.turnID == requestedTurn, self.waitingForPermission else { return }
                        self.waitingForPermission = false
                        self.startCapture()
                    }
                }
            } else { startCapture() }
        } else if command.turnID == turnID {
            switch command.type {
            case "stop":
                pointerSampler.end()
                waitingForPermission = false
                captureDeadline = nil
                capture?.stop(discard: false)
                drainAudio()
                capture = nil
                if let id = turnID { output.send(["type": "audio-stopped", "turnId": id]) }
            case "cancel":
                let id = turnID!
                clearTurn(discard: true)
                output.send(["type": "audio-stopped", "turnId": id])
            case "settled": clearTurn(discard: true)
            default: break
            }
        }
        // Stale completion/cancellation from a previous turn is harmless.
    }

    private func startCapture() {
        guard let id = turnID, AVCaptureDevice.authorizationStatus(for: .audio) == .authorized else {
            fail("microphone-unavailable"); return
        }
        let capture = VoiceCapture()
        self.capture = capture
        do {
            try capture.start()
            output.send(["type": "audio-started", "turnId": id])
        } catch { fail("capture-failed") }
    }

    private func drainAudio() {
        guard let capture, let id = turnID else { return }
        let result = capture.drain()
        if result.failed { fail("capture-failed"); return }
        for data in result.chunks { output.send(["type": "audio", "turnId": id, "data": data.base64EncodedString()]) }
    }

    private func samplePointer() {
        let now = ProcessInfo.processInfo.systemUptime
        guard let id = turnID, pointerSampler.isDue(at: now),
              let point = CGEvent(source: nil)?.location else { return }
        let display = displayAt(point)
        guard pointerSampler.sample(at: now, point: point, display: display) else { return }
        output.send(["type": "pointer", "turnId": id, "capturedAt": captureTimestamp(),
            "x": point.x, "y": point.y, "displayId": display.map { String($0) } as Any? ?? NSNull()])
    }

    private func fail(_ code: String) {
        var event = ["type": "error", "code": code]
        if let turnID { event["turnId"] = turnID }
        clearTurn(discard: true)
        output.send(event)
    }

    private func clearTurn(discard: Bool) {
        pointerSampler.end()
        waitingForPermission = false
        captureDeadline = nil
        capture?.stop(discard: discard)
        capture = nil
        turnID = nil
        if let escapeHotkey { UnregisterEventHotKey(escapeHotkey) }
        escapeHotkey = nil
        down.remove(2)
    }
}
