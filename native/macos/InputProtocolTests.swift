import Foundation

@main
struct InputProtocolTests {
    static func main() throws {
        let target: [String: Any] = ["windowId": "mac:123:1700000000000:" + String(repeating: "a", count: 64),
            "bounds": ["x": -1200, "y": -100, "width": 800, "height": 600], "point": ["x": -1100, "y": 0]]
        func data(_ action: [String: Any], targetOverride: [String: Any]? = nil, fingerprint: Any = NSNull()) throws -> Data {
            try JSONSerialization.data(withJSONObject: ["target": targetOverride ?? target, "action": action, "fingerprint": fingerprint])
        }
        func reject(_ data: Data, execute: Bool = false) {
            do { _ = try parseInputCommand(data, execute: execute); preconditionFailure("Invalid input accepted") }
            catch { }
        }
        let parsed = try parseInputCommand(data(["kind": "type_text", "text": "Literal $(text) 🌱"]), execute: false)
        precondition(parsed.target.point.x == -1100 && parsed.action.text == "Literal $(text) 🌱")
        for action: [String: Any] in [["kind": "move_pointer"], ["kind": "click"], ["kind": "scroll", "deltaY": -600],
                                     ["kind": "type_text", "text": ""]] {
            _ = try parseInputCommand(data(action), execute: false)
            _ = try parseInputCommand(data(action, fingerprint: String(repeating: "a", count: 64)), execute: true)
            reject(try data(action), execute: true)
        }
        for action: [String: Any] in [["kind": "shell", "text": "command"], ["kind": "click", "approved": true],
                                     ["kind": "click", "text": "extra"], ["kind": "press_key", "key": "Command+Enter"],
                                     ["kind": "scroll", "deltaY": 601], ["kind": "scroll", "deltaY": Int.min],
                                     ["kind": "scroll", "deltaY": 0], ["kind": "scroll", "deltaY": 1.5]] {
            reject(try data(action))
        }
        let multiline = "Error: café e\u{301} 🌱\r\n\tfile.ts:12\n\nExplanation\rTrailing\u{85}next\u{2028}line\u{2029}paragraph\n"
        for text in [multiline, "\t", "\n", "\r", "\r\n", "\u{85}", "\u{2028}", "\u{2029}", String(repeating: "🌱", count: 32768)] {
            let decoded = try parseInputCommand(data(["kind": "type_text", "text": text]), execute: false)
            precondition(decoded.action.text!.utf16.elementsEqual(text.utf16), "Literal text changed in the native protocol")
        }
        for scalar in (0..<32).filter({ ![9, 10, 13].contains($0) }) + [127] {
            reject(try data(["kind": "type_text", "text": "before" + String(UnicodeScalar(scalar)!) + "after"]))
        }
        for text in [String(repeating: "x", count: 65537), String(repeating: "🌱", count: 32768) + "x"] {
            reject(try data(["kind": "type_text", "text": text]))
        }

        // An AXTextField is never a multiline destination, even when its value
        // is settable. Literal separators and tabs require a writable text area.
        for text in [multiline, "\t", "\n", "\r", "\u{85}", "\u{2028}", "\u{2029}"] {
            precondition(inputTextRequiresTextArea(text))
            for (role, editable) in [("AXTextField", true), ("AXButton", true), ("AXTextArea", false)] {
                let result = replaceInputText(text, role: role, editable: editable,
                    write: { _ in preconditionFailure("Unsupported target reached a text write") },
                    read: { preconditionFailure("Unsupported target reached verification") })
                precondition(result.status == "not-issued" && result.reason == .unsupportedTextTarget)
            }
        }
        for text in [multiline, "", "Literal $(text) 🌱"] {
            var writes: [String] = []
            let result = replaceInputText(text, role: "AXTextArea", editable: true,
                write: { writes.append($0); return true }, read: { writes.last })
            precondition(result.status == "verified" && result.reason == nil && writes.count == 1 && writes[0].utf16.elementsEqual(text.utf16))
        }
        precondition(replaceInputText("single line", role: "AXTextField", editable: true,
            write: { $0 == "single line" }, read: { "single line" }).status == "verified")
        for actual: String? in [nil, "", multiline.replacingOccurrences(of: "\r\n", with: "\n"), String(multiline.dropLast())] {
            var writes = 0
            let result = replaceInputText(multiline, role: "AXTextArea", editable: true,
                wait: {},
                write: { _ in writes += 1; return true }, read: { actual })
            precondition(result.status == "uncertain" && result.reason == (actual == nil ? .textReadUnavailable : .textValueMismatch) && writes == 1,
                "Unavailable and mismatched readback must remain distinct without retrying the write")
        }
        precondition(replaceInputText("", role: "AXTextArea", editable: true,
            wait: {},
            write: { _ in true }, read: { nil }).status == "uncertain")
        precondition(replaceInputText(multiline, role: "AXTextArea", editable: true,
            write: { _ in false }, read: { preconditionFailure("A failed setter cannot verify success") }).status == "uncertain")
        // Swift string equality is canonically equivalent, which is weaker than
        // exact replacement. A control that normalizes Unicode is uncertain.
        precondition("e\u{301}" == "é")
        precondition(replaceInputText("e\u{301}", role: "AXTextArea", editable: true,
            wait: {},
            write: { _ in true }, read: { "é" }).status == "uncertain")
        let failedWrite = replaceInputText("private typed value", role: "AXTextArea", editable: true,
            write: { _ in false }, read: { preconditionFailure("A failed write cannot verify success") })
        let encodedFailure = try JSONSerialization.jsonObject(with: JSONEncoder().encode(failedWrite)) as! [String: String]
        precondition(encodedFailure == ["status": "uncertain", "reason": "text-write-failed"],
            "Diagnostics must contain only status and a finite reason, never typed or captured text")

        var clock = 0.0, reads = 0, writes = 0
        let settled = replaceInputText(multiline, role: "AXTextArea", editable: true,
            now: { clock }, wait: { clock += 0.025 }, write: { _ in writes += 1; return true },
            read: { reads += 1; return reads == 1 ? nil : reads == 2 ? "old value" : multiline })
        precondition(settled.status == "verified" && reads == 3 && writes == 1 && clock == 0.05,
            "Asynchronous readback must settle after one literal write")
        clock = 0; reads = 0; writes = 0
        let expired = replaceInputText(multiline, role: "AXTextArea", editable: true,
            now: { clock }, wait: { clock += 0.2 }, write: { _ in writes += 1; return true },
            read: { reads += 1; return "different" })
        precondition(expired.reason == .textValueMismatch && reads == 2 && writes == 1,
            "Readback polling must stop at the deadline without rewriting")
        let longDraft = String(repeating: "Synthetic context\n", count: 400)
        clock = 0; reads = 0; writes = 0
        let delayedLong = replaceInputText(longDraft, role: "AXTextArea", editable: true,
            now: { clock }, wait: { clock += 1 }, write: { _ in writes += 1; return true },
            read: { reads += 1; return clock < 4 ? nil : longDraft })
        precondition(delayedLong.status == "verified" && reads == 5 && writes == 1 && clock == 4,
            "A long web-backed replacement may settle after seconds; verification must remain read-only")
        clock = 0; reads = 0; writes = 0
        let normalizedLong = replaceInputText(longDraft, role: "AXTextArea", editable: true,
            now: { clock }, wait: { clock += 1 }, write: { _ in writes += 1; return true },
            read: { reads += 1; return clock < 4 ? nil : longDraft + "\n" })
        precondition(normalizedLong.status == "uncertain" && normalizedLong.reason == .textValueMismatch
            && reads == 5 && writes == 1 && clock == 5,
            "A late normalized value must remain a mismatch, with no read started after the five-second budget")
        clock = 0; reads = 0; writes = 0
        let cancelledLong = replaceInputText(longDraft, role: "AXTextArea", editable: true,
            cancelled: { clock >= 2 }, now: { clock }, wait: { clock += 1 },
            write: { _ in writes += 1; return true }, read: { reads += 1; return nil })
        precondition(cancelledLong.status == "uncertain" && cancelledLong.reason == .cancelled && reads == 2 && writes == 1,
            "Cancellation during long verification must prevent further reads or writes")
        reads = 0; writes = 0
        let boundedLong = replaceInputText(longDraft, role: "AXTextArea", editable: true,
            now: { 0 }, wait: {}, write: { _ in writes += 1; return true }, read: { reads += 1; return nil })
        precondition(boundedLong.reason == .textReadUnavailable && reads == 201 && writes == 1,
            "The independent attempt budget must bound polling even when the injected clock does not advance")
        for cancelAt in ["before-write", "after-write", "during-read", "during-wait"] {
            var cancelled = cancelAt == "before-write", reads = 0, writes = 0
            let result = replaceInputText(multiline, role: "AXTextArea", editable: true,
                cancelled: { cancelled }, wait: { cancelled = true }, write: { _ in
                    writes += 1; if cancelAt == "after-write" { cancelled = true }; return true
                }, read: {
                    reads += 1; if cancelAt == "during-read" { cancelled = true }; return nil
                })
            precondition(result.reason == .cancelled && writes == (cancelAt == "before-write" ? 0 : 1))
            precondition(result.status == (cancelAt == "before-write" ? "not-issued" : "uncertain"))
            precondition(reads == (["during-read", "during-wait"].contains(cancelAt) ? 1 : 0))
        }

        // ChatGPT's composer has 33 ancestors, with its application just beyond
        // the old 32-node cap. Check protection before any captured value read.
        var visited: [Int] = []
        try validateInputAncestry(0, deadline: 1, now: { 0 }, same: ==,
            describe: { node in visited.append(node); return (node == 32 ? "AXApplication" : "AXGroup", "") },
            parent: { $0 + 1 })
        precondition(visited == Array(0...32))
        for failure in ["secure", "cycle", "missing-parent", "limit", "timeout", "missing-role"] {
            var clock = 0.0, count = 0
            do {
                try validateInputAncestry(0, deadline: 1, now: { clock }, same: ==,
                    describe: { node in
                        count += 1
                        if failure == "timeout" && node == 5 { clock = 2 }
                        return (failure == "missing-role" ? "" : "AXGroup", failure == "secure" && node == 32 ? "AXSecureTextField" : "")
                    }, parent: { node in
                        if failure == "missing-parent" { throw InputError.unavailable }
                        return failure == "cycle" && node == 5 ? 0 : node + 1
                    })
                preconditionFailure("Incomplete or protected ancestry accepted")
            } catch {
                precondition(count <= 64)
                if failure == "secure" { precondition((error as? InputFailureReason) == .secureField && count == 33) }
                else { precondition((error as? InputError) == .unavailable) }
            }
        }
        for source in ["", multiline, String(repeating: "x", count: 65536), "🌱" + String(repeating: "x", count: 65535),
                       String(repeating: "x", count: 65535) + "🌱", String(repeating: "🌱", count: 40000)] {
            let tail = focusedTextTail(source)
            precondition(tail.text.utf16.count <= 65536 && tail.start + tail.text.utf16.count == tail.totalLength)
            precondition(tail.totalLength == source.utf16.count && !tail.text.contains("\u{FFFD}"))
            precondition(Array(source.utf16.dropFirst(tail.start)) == Array(tail.text.utf16), "Source tails must preserve exact code units")
        }
        let split = focusedTextTail("🌱" + String(repeating: "x", count: 65535))
        precondition(split.start == 2 && split.text.utf16.count == 65535, "Never split a surrogate at the retained tail boundary")

        // Pointer actions use one complete batch. Cancellation during a mouse
        // down must not skip its up event or the final delivery drain.
        for batch in [["mouse-down", "mouse-up"], ["scroll"]] {
            var events: [String] = [], cancelled = false
            let result = dispatchInputBatches(count: 1, cancelled: { cancelled }, validate: { nil }, batch: { _ in
                for event in batch { events.append(event); cancelled = true }
                return true
            }, drain: { precondition(events == batch); events.append("drain") })
            precondition(result.status == "issued" && events == batch + ["drain"],
                "A posted pointer batch must complete and drain exactly once before returning")
        }
        let rejected = dispatchInputBatches(count: 1, cancelled: { false }, validate: { .focusChanged },
            batch: { _ in preconditionFailure("Rejected pointer input was posted") },
            drain: { preconditionFailure("No posted events to drain") })
        precondition(rejected.status == "not-issued" && rejected.reason == .focusChanged)
        for failurePoint in ["validation", "protected-posting"] {
            for alreadyPosted in 0...1 {
                var cancelled = false, posted = 0, drains = 0
                let result = dispatchInputBatches(count: 2, cancelled: { cancelled }, validate: {
                    if failurePoint == "validation" && posted == alreadyPosted { cancelled = true }
                    return nil
                }, batch: { _ in
                    precondition(!cancelled, "Cancellation during validation must stop before the posting boundary")
                    if failurePoint == "protected-posting" && posted == alreadyPosted { return false }
                    posted += 1; return true
                }, drain: { drains += 1 })
                precondition(posted == alreadyPosted && drains == alreadyPosted && result.reason == .cancelled)
                precondition(result.status == (alreadyPosted == 0 ? "not-issued" : "uncertain"),
                    "Cancellation before any event and after a posted batch must retain different outcomes")
            }
        }
        var outside = target; outside["point"] = ["x": -400, "y": 0]
        reject(try data(["kind": "click"], targetOverride: outside))
        var invalid = target; invalid["bounds"] = ["x": 0, "y": 0, "width": 0, "height": 10]
        reject(try data(["kind": "click"], targetOverride: invalid))
        reject(Data(repeating: 32, count: 1_048_577))

        func targetState(_ values: [String: String]) -> InputFingerprintState {
            InputFingerprintState(windowId: target["windowId"] as! String,
                windowBounds: InputBounds(CGRect(x: -1200, y: -100, width: 800, height: 600)),
                role: "AXTextArea", title: "Message", description: "Agent input", value: values["input"]!,
                identifier: "composer", bounds: InputBounds(CGRect(x: -1150, y: -50, width: 700, height: 400)),
                focused: true, editable: true, pointer: InputPoint(x: -1100, y: 0), interaction: [1, 2, 3, 4, 5])
        }
        let state = targetState(["input": multiline, "badge": "9"])
        let digest = try inputFingerprint(state)
        let unrelatedChange = try inputFingerprint(targetState(["input": multiline, "badge": "10", "timer": "00:42"]))
        precondition(digest == unrelatedChange, "Unrelated live window content must not invalidate the target")
        func changed(_ update: (inout InputFingerprintState) -> Void) throws {
            var current = state; update(&current)
            let currentDigest = try inputFingerprint(current)
            precondition(currentDigest != digest, "Target or user-intervention changes must invalidate input")
        }
        try changed { $0.value = "different request" }
        try changed { $0.identifier = "other-composer" }
        try changed { $0.windowId = "mac:123:1700000000001:" + String(repeating: "a", count: 64) }
        try changed { $0.windowBounds = InputBounds(CGRect(x: -1200, y: -50, width: 800, height: 600)) }
        try changed { $0.bounds = InputBounds(CGRect(x: -1150, y: 0, width: 700, height: 400)) }
        try changed { $0.focused = false }
        try changed { $0.editable = false }
        try changed { $0.role = "AXButton" }
        try changed { $0.pointer = InputPoint(x: -1000, y: 0) }
        try changed { $0.interaction[3] += 1 }
        let longText = String(repeating: "x", count: 65535) + "a"
        let longDigest = try inputFingerprint(targetState(["input": longText]))
        let tailDigest = try inputFingerprint(targetState(["input": String(longText.dropLast()) + "b"]))
        precondition(longDigest != tailDigest, "The full target value, including its tail, remains revalidated")
        print("Input protocol checks passed (typed actions, literal multiline text, exact read-back, target freshness and user intervention). No desktop input issued.")
    }
}
