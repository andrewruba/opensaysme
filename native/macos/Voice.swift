import AppKit
import AVFoundation
import Carbon
import Foundation

struct ActivationHotkey {
    let keyCode: UInt32
    let modifiers: UInt32

    static let standard = ActivationHotkey(keyCode: UInt32(kVK_Space), modifiers: UInt32(controlKey | shiftKey))

    // Match the bounded shortcut vocabulary accepted by the TypeScript config.
    // Letter/digit keys refer to physical ANSI positions, as Carbon registration does.
    static func parse(_ shortcut: String) -> ActivationHotkey? {
        guard shortcut.utf8.count <= 64 else { return nil }
        let parts = shortcut.split(separator: "+", omittingEmptySubsequences: false).map(String.init)
        guard (2...5).contains(parts.count), let key = parts.last, let code = keyCodes[key] else { return nil }
        let modifierCodes = ["Ctrl": UInt32(controlKey), "Alt": UInt32(optionKey),
                             "Shift": UInt32(shiftKey), "Cmd": UInt32(cmdKey)]
        var modifiers: UInt32 = 0
        for name in parts.dropLast() {
            guard let bit = modifierCodes[name], modifiers & bit == 0 else { return nil }
            modifiers |= bit
        }
        guard modifiers & UInt32(controlKey | optionKey | cmdKey) != 0 else { return nil }
        // The terminal reserves Ctrl+C, including combinations with other modifiers.
        if key == "C", modifiers & UInt32(controlKey) != 0 { return nil }
        return ActivationHotkey(keyCode: UInt32(code), modifiers: modifiers)
    }

    private static let keyCodes: [String: Int] = [
        "Space": kVK_Space,
        "A": kVK_ANSI_A, "B": kVK_ANSI_B, "C": kVK_ANSI_C, "D": kVK_ANSI_D,
        "E": kVK_ANSI_E, "F": kVK_ANSI_F, "G": kVK_ANSI_G, "H": kVK_ANSI_H,
        "I": kVK_ANSI_I, "J": kVK_ANSI_J, "K": kVK_ANSI_K, "L": kVK_ANSI_L,
        "M": kVK_ANSI_M, "N": kVK_ANSI_N, "O": kVK_ANSI_O, "P": kVK_ANSI_P,
        "Q": kVK_ANSI_Q, "R": kVK_ANSI_R, "S": kVK_ANSI_S, "T": kVK_ANSI_T,
        "U": kVK_ANSI_U, "V": kVK_ANSI_V, "W": kVK_ANSI_W, "X": kVK_ANSI_X,
        "Y": kVK_ANSI_Y, "Z": kVK_ANSI_Z,
        "0": kVK_ANSI_0, "1": kVK_ANSI_1, "2": kVK_ANSI_2, "3": kVK_ANSI_3,
        "4": kVK_ANSI_4, "5": kVK_ANSI_5, "6": kVK_ANSI_6, "7": kVK_ANSI_7,
        "8": kVK_ANSI_8, "9": kVK_ANSI_9,
        "F1": kVK_F1, "F2": kVK_F2, "F3": kVK_F3, "F4": kVK_F4,
        "F5": kVK_F5, "F6": kVK_F6, "F7": kVK_F7, "F8": kVK_F8,
        "F9": kVK_F9, "F10": kVK_F10, "F11": kVK_F11, "F12": kVK_F12,
    ]
}

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

struct VoiceAudioChunk {
    let data: Data
    let capturedAt: Date
    let startSample: Int64
    let timing: String
}

// Keep acquisition time separate from conversion, queueing, and pipe delivery.
// AVAudioTime.hostTime identifies the first input sample. Converter output can
// lag that input, so map its cumulative 24 kHz offset through the input clock.
struct VoiceAudioClock {
    private let wallEpoch: Date
    private let hostEpoch: TimeInterval
    private var anchorDate: Date?
    private var anchorSample = 0.0
    private var inputSamples = 0.0
    private var outputSamples: Int64 = 0
    private var timing = "estimated"

    init(wallTime: Date = Date(), hostTime: UInt64 = mach_absolute_time()) {
        wallEpoch = wallTime
        hostEpoch = AVAudioTime.seconds(forHostTime: hostTime)
    }

    mutating func observeInput(frames: Int, sampleRate: Double, hostTime: UInt64?,
                              observedHostTime: UInt64 = mach_absolute_time()) throws {
        guard frames > 0, sampleRate.isFinite, sampleRate > 0 else {
            throw NSError(domain: "VoiceCapture", code: 4)
        }
        let duration = Double(frames) / sampleRate
        if let hostTime {
            let date = wallEpoch.addingTimeInterval(AVAudioTime.seconds(forHostTime: hostTime) - hostEpoch)
            if let anchorDate,
               abs(date.timeIntervalSince(anchorDate) - (inputSamples - anchorSample) / 24_000) > 0.05 {
                // A discontinuity cannot be represented as contiguous provider
                // PCM without inventing silence or losing alignment.
                throw NSError(domain: "VoiceCapture", code: 5)
            }
            anchorDate = date
            anchorSample = inputSamples
            timing = "device"
        } else {
            let observedDate = wallEpoch.addingTimeInterval(AVAudioTime.seconds(forHostTime: observedHostTime) - hostEpoch)
            if anchorDate == nil {
                anchorDate = observedDate.addingTimeInterval(-duration)
                anchorSample = inputSamples
            } else if let anchorDate,
                      abs(observedDate.timeIntervalSince(anchorDate) - (inputSamples - anchorSample) / 24_000 - duration) > 0.5 {
                throw NSError(domain: "VoiceCapture", code: 5)
            }
            timing = "estimated"
        }
        inputSamples += duration * 24_000
    }

    mutating func stamp(_ data: Data) throws -> VoiceAudioChunk {
        guard let anchorDate, !data.isEmpty, data.count % 2 == 0 else {
            throw NSError(domain: "VoiceCapture", code: 6)
        }
        let result = VoiceAudioChunk(data: data,
            capturedAt: anchorDate.addingTimeInterval((Double(outputSamples) - anchorSample) / 24_000),
            startSample: outputSamples, timing: timing)
        outputSamples += Int64(data.count / 2)
        return result
    }
}

final class VoiceCapture {
    private let engine = AVAudioEngine()
    private let lock = NSLock()
    private var chunks: [VoiceAudioChunk] = []
    private var queuedBytes = 0
    private var failed = false
    private var accepting = true
    private var tapped = false
    private var converter: VoicePCMConverter?
    private var clock = VoiceAudioClock()

    func start() throws {
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard let converter = VoicePCMConverter(inputFormat: format) else {
            throw NSError(domain: "VoiceCapture", code: 3)
        }
        self.converter = converter
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, time in
            let observedHostTime = mach_absolute_time()
            guard let self else { return }
            self.lock.lock()
            defer { self.lock.unlock() }
            guard self.accepting, !self.failed else { return }
            do {
                try self.clock.observeInput(frames: Int(buffer.frameLength), sampleRate: buffer.format.sampleRate,
                    hostTime: time.isHostTimeValid ? time.hostTime : nil, observedHostTime: observedHostTime)
                try self.enqueue(converter.convert(buffer))
            }
            catch { self.failed = true }
        }
        tapped = true
        try engine.start()
    }

    // Called only with the lock held. A stalled parent never grows memory or
    // makes the real-time callback wait for a pipe write.
    private func enqueue(_ data: Data) throws {
        guard !data.isEmpty else { return }
        if data.count > 65_536 || queuedBytes + data.count > 256 * 1024 {
            failed = true
            return
        }
        chunks.append(try clock.stamp(data))
        queuedBytes += data.count
    }

    func drain() -> (chunks: [VoiceAudioChunk], failed: Bool) {
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
            do { try enqueue(converter.convert(nil, end: true)) }
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
    private let activationHotkey: ActivationHotkey
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

    init(activationHotkey: ActivationHotkey = .standard) {
        self.activationHotkey = activationHotkey
    }

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
              register(key: activationHotkey.keyCode, modifiers: activationHotkey.modifiers, id: 1, ref: &toggleHotkey) else {
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
        guard let id = turnID else { return }
        guard AVCaptureDevice.authorizationStatus(for: .audio) == .authorized else {
            fail("microphone-permission-required"); return
        }
        guard AVCaptureDevice.default(for: .audio) != nil else { fail("microphone-unavailable"); return }
        let capture = VoiceCapture()
        self.capture = capture
        do {
            try capture.start()
            output.send(["type": "audio-started", "turnId": id])
        } catch { fail("microphone-unavailable") }
    }

    private func drainAudio() {
        guard let capture, let id = turnID else { return }
        let result = capture.drain()
        if result.failed { fail("capture-failed"); return }
        for chunk in result.chunks {
            output.send(["type": "audio", "turnId": id, "data": chunk.data.base64EncodedString(),
                "capturedAt": captureTimestamp(chunk.capturedAt), "startSample": chunk.startSample, "timing": chunk.timing])
        }
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
