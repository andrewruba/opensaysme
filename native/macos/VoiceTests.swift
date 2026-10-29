import AVFoundation
import Foundation

@main
struct VoiceTests {
    static func main() throws {
        // This suite creates synthetic buffers only; no microphone or hotkey.
        for sampleRate in [44_100.0, 48_000.0] {
            for channels: AVAudioChannelCount in [1, 2] {
                let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: sampleRate, channels: channels, interleaved: false)!
                let converter = VoicePCMConverter(inputFormat: format)!
                let inputFrames = AVAudioFrameCount(sampleRate / 100)
                var pcm = Data()
                for _ in 0..<20 {
                    let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: inputFrames)!
                    buffer.frameLength = inputFrames
                    for channel in 0..<Int(channels) {
                        for frame in 0..<Int(inputFrames) { buffer.floatChannelData![channel][frame] = 0.25 }
                    }
                    pcm.append(try converter.convert(buffer))
                }
                pcm.append(try converter.convert(nil, end: true))
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
        func command(_ json: String) -> VoiceCommand? { VoiceCommand.parse(Data(json.utf8)) }
        precondition(command(#"{"type":"start","turnId":"turn-123"}"#)?.turnID == "turn-123")
        precondition(command(#"{"type":"shutdown"}"#)?.type == "shutdown")
        for invalid in [
            #"{"type":"start"}"#, #"{"type":"start","turnId":"bad id"}"#,
            #"{"type":"start","turnId":"trailing\n"}"#,
            #"{"type":"start","turnId":"ok","key":"secret"}"#, #"{"type":"shutdown","turnId":"ok"}"#,
            #"{"type":"exec","turnId":"ok"}"#, #"{"type":"stop","turnId":1}"#, "not-json",
        ] { precondition(command(invalid) == nil) }
        print("Passed synthetic PCM conversion and strict voice-command parsing checks.")
    }
}
