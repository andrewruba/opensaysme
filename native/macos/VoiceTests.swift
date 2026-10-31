import AVFoundation
import AppKit
import Foundation

@main
struct VoiceTests {
    static func main() throws {
        precondition(visualCaptureFailure(CaptureExecutionError.timeout) == .timeout)
        precondition(visualCaptureFailure(CaptureExecutionError.displayUnavailable) == .unavailable)
        precondition(visualCaptureFailure(VisualCaptureError.permissionRequired) == .permissionRequired)
        precondition(visualCaptureFailure(NSError(domain: "Private native error", code: 1)) == .failed)
        // This suite creates synthetic buffers only; no microphone or hotkey.
        for sampleRate in [44_100.0, 48_000.0] {
            for channels: AVAudioChannelCount in [1, 2] {
                let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: sampleRate, channels: channels, interleaved: false)!
                let converter = VoicePCMConverter(inputFormat: format)!
                let inputFrames = AVAudioFrameCount(sampleRate / 100)
                let epoch = Date(timeIntervalSince1970: 100)
                var clock = VoiceAudioClock(wallTime: epoch, hostTime: AVAudioTime.hostTime(forSeconds: 1000))
                var pcm = Data()
                for index in 0..<20 {
                    let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: inputFrames)!
                    buffer.frameLength = inputFrames
                    for channel in 0..<Int(channels) {
                        for frame in 0..<Int(inputFrames) { buffer.floatChannelData![channel][frame] = 0.25 }
                    }
                    try clock.observeInput(frames: Int(inputFrames), sampleRate: sampleRate,
                        hostTime: AVAudioTime.hostTime(forSeconds: 1000 + Double(index) / 100),
                        observedHostTime: AVAudioTime.hostTime(forSeconds: 1010 + Double(index) / 100))
                    let converted = try converter.convert(buffer)
                    if !converted.isEmpty {
                        let chunk = try clock.stamp(converted)
                        precondition(chunk.startSample == Int64(pcm.count / 2))
                        precondition(chunk.timing == "device")
                        precondition(abs(chunk.capturedAt.timeIntervalSince(epoch) - Double(pcm.count) / 48_000) < 0.0001)
                        pcm.append(chunk.data)
                    }
                }
                let tail = try converter.convert(nil, end: true)
                if !tail.isEmpty {
                    let chunk = try clock.stamp(tail)
                    precondition(chunk.startSample == Int64(pcm.count / 2))
                    precondition(abs(chunk.capturedAt.timeIntervalSince(epoch) - Double(pcm.count) / 48_000) < 0.0001)
                    pcm.append(chunk.data)
                }
                // 200ms of mono 24k PCM16 must be 9,600 bytes. Allow the SRC's
                // tiny boundary rounding, but never a channel/rate mismatch.
                precondition(abs(pcm.count - 9600) <= 8, "Unexpected converted frame count: \(pcm.count)")
                let samples = pcm.withUnsafeBytes { bytes -> [Int16] in
                    stride(from: 0, to: bytes.count - 1, by: 2).map {
                        Int16(bitPattern: UInt16(bytes[$0]) | UInt16(bytes[$0 + 1]) << 8)
                    }
                }
                precondition(samples.dropFirst(100).dropLast(100).allSatisfy { abs(Int($0) - 8192) < 4 }, "PCM must be mono little-endian signed 16-bit samples")
            }
        }
        let epoch = Date(timeIntervalSince1970: 100)
        let host = AVAudioTime.hostTime(forSeconds: 1000)
        var estimated = VoiceAudioClock(wallTime: epoch, hostTime: host)
        try estimated.observeInput(frames: 480, sampleRate: 48_000, hostTime: nil,
            observedHostTime: AVAudioTime.hostTime(forSeconds: 1001.01))
        let first = try estimated.stamp(Data(repeating: 0, count: 480))
        precondition(first.startSample == 0 && first.timing == "estimated")
        precondition(abs(first.capturedAt.timeIntervalSince(epoch) - 1) < 0.0001)
        try estimated.observeInput(frames: 480, sampleRate: 48_000, hostTime: nil,
            observedHostTime: AVAudioTime.hostTime(forSeconds: 1001.03))
        let second = try estimated.stamp(Data(repeating: 0, count: 480))
        precondition(second.startSample == 240 && second.timing == "estimated")
        precondition(abs(second.capturedAt.timeIntervalSince(first.capturedAt) - 0.01) < 0.0001)
        var device = VoiceAudioClock(wallTime: epoch, hostTime: host)
        try device.observeInput(frames: 480, sampleRate: 48_000, hostTime: host)
        var rejectedGap = false
        do {
            try device.observeInput(frames: 480, sampleRate: 48_000,
                hostTime: AVAudioTime.hostTime(forSeconds: 1001))
        } catch { rejectedGap = true }
        precondition(rejectedGap, "A device clock gap must not silently become contiguous PCM")
        let restarted = try device.stamp(Data(repeating: 0, count: 480))
        precondition(restarted.startSample == 0, "A new turn resets the audio sample clock")
        func command(_ json: String) -> VoiceCommand? { VoiceCommand.parse(Data(json.utf8)) }
        precondition(command(#"{"type":"start","turnId":"turn-123"}"#)?.turnID == "turn-123")
        precondition(command(#"{"type":"shutdown"}"#)?.type == "shutdown")
        for invalid in [
            #"{"type":"start"}"#, #"{"type":"start","turnId":"bad id"}"#,
            #"{"type":"start","turnId":"trailing\n"}"#,
            #"{"type":"start","turnId":"ok","key":"secret"}"#, #"{"type":"shutdown","turnId":"ok"}"#,
            #"{"type":"exec","turnId":"ok"}"#, #"{"type":"stop","turnId":1}"#, "not-json",
        ] { precondition(command(invalid) == nil) }
        var sampler = PointerTrajectorySampler()
        let point = CGPoint(x: -300, y: 150)
        precondition(!sampler.sample(at: 0, point: point, display: 2))
        sampler.begin()
        precondition(sampler.sample(at: 0, point: point, display: 2))
        precondition(!sampler.sample(at: 0.01, point: CGPoint(x: -290, y: 150), display: 2))
        precondition(!sampler.sample(at: 0.06, point: point, display: 2))
        precondition(sampler.sample(at: 0.12, point: CGPoint(x: -290, y: 150), display: 2))
        precondition(sampler.sample(at: 0.18, point: CGPoint(x: -290, y: 150), display: 3))
        sampler.end()
        precondition(!sampler.sample(at: 10, point: point, display: 2))
        sampler.begin()
        precondition(sampler.sample(at: 11, point: point, display: nil))
        precondition(!sampler.sample(at: 12, point: CGPoint(x: CGFloat.infinity, y: 0), display: nil))

        // Only a generated image is encoded: no screen capture or permission call.
        let canvas = CGContext(data: nil, width: 3200, height: 1800, bitsPerComponent: 8,
            bytesPerRow: 3200 * 4, space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
        canvas.setFillColor(NSColor.red.cgColor)
        canvas.fill(CGRect(x: 0, y: 0, width: 1600, height: 1800))
        canvas.setFillColor(NSColor.blue.cgColor)
        canvas.fill(CGRect(x: 1600, y: 0, width: 1600, height: 1800))
        let frameImage = try encodeFrameImage(canvas.makeImage()!)
        let jpeg = Data(base64Encoded: frameImage.data)!
        precondition(frameImage.width == 1600 && frameImage.height == 900)
        precondition(jpeg.count <= 700_000 && Array(jpeg.prefix(2)) == [0xff, 0xd8])
        let decoded = NSBitmapImageRep(data: jpeg)!
        precondition(decoded.pixelsWide == 1600 && decoded.pixelsHigh == 900)
        precondition(decoded.colorAt(x: 100, y: 100)!.redComponent > 0.9)
        precondition(decoded.colorAt(x: 1500, y: 100)!.blueComponent > 0.9)
        precondition(boundedImageSize(width: 0, height: 900) == nil)
        let portrait = boundedImageSize(width: 900, height: 1800)!
        precondition(portrait.width == 800 && portrait.height == 1600)
        let frame = ScreenFrame(capturedAt: captureTimestamp(Date(timeIntervalSince1970: 0.123)),
            display: FrameDisplay(id: "2", bounds: FrameBounds(CGRect(x: -1920, y: -200, width: 1920, height: 1080))),
            image: frameImage, warnings: [])
        let encoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(frame)) as! [String: Any]
        precondition(encoded["capturedAt"] as? String == "1970-01-01T00:00:00.123Z")
        let display = encoded["display"] as! [String: Any]
        let bounds = display["bounds"] as! [String: Double]
        precondition(bounds["x"] == -1920 && bounds["y"] == -200)
        print("Passed synthetic PCM/timing, command, pointer trajectory, and bounded JPEG frame checks.")
    }
}
