import Foundation

struct ApplicationProcessTarget: Equatable {
    let processID: Int32
    let started: UInt64
    var id: String { "mac-app:\(processID):\(started)" }

    init(processID: Int32, started: UInt64) {
        self.processID = processID
        self.started = started
    }

    init?(id: String) {
        let parts = id.split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count == 3, parts[0] == "mac-app", let pid = Int32(parts[1]), pid > 0,
              let start = UInt64(parts[2]), start > 0, start <= 9_999_999_999_999_999,
              String(pid) == parts[1], String(start) == parts[2] else { return nil }
        self.init(processID: pid, started: start)
    }
}

// Focused/main windows can be omitted from AXWindows, including while changing
// Spaces. Include them before a bounded enumeration and deduplicate by actual
// AX identity, not labels: identical titles must still be checked for ambiguity.
func mergeApplicationWindows<Element>(listed: [Element], focused: Element?, main: Element?,
                                      limit: Int = 128, same: (Element, Element) -> Bool)
    -> (windows: [Element], limited: Bool) {
    var windows: [Element] = []
    var limited = false
    for window in [focused, main].compactMap({ $0 }) + listed {
        if windows.contains(where: { same($0, window) }) { continue }
        if windows.count >= limit { limited = true; continue }
        windows.append(window)
    }
    return (windows, limited)
}

// A target that appears once in a truncated prefix is not known to be unique.
// Missing AXWindows can still use focused/main evidence; a known cap/deadline
// omission must instead be retried with a complete observation.
func uniqueApplicationWindow<Element>(windows: [Element], limited: Bool,
                                      matching: (Element) throws -> Bool) rethrows -> Element? {
    guard !limited else { return nil }
    var match: Element?
    for window in windows where try matching(window) {
        guard match == nil else { return nil }
        match = window
    }
    return match
}
