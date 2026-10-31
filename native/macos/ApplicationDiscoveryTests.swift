import Foundation

@main
struct ApplicationDiscoveryTests {
    static func main() {
        let target = ApplicationProcessTarget(processID: 123, started: 1_700_000_000_000_123)
        precondition(ApplicationProcessTarget(id: target.id) == target)
        precondition(ApplicationProcessTarget(id: "mac-app:123:1700000000000124") != target)
        for invalid in ["mac:123:1700000000000123", "mac-app:0:1", "mac-app:-1:1",
                        "mac-app:2147483648:1", "mac-app:123:0", "mac-app:123:-1",
                        "mac-app:123:10000000000000000", "mac-app:0123:1", "mac-app:123:01",
                        "mac-app:123:1:extra", "mac-app:123:1:", "mac-app::123:1"] {
            precondition(ApplicationProcessTarget(id: invalid) == nil)
        }

        // The current full-screen window may be absent from a nonempty list.
        let supplemented = mergeApplicationWindows(listed: ["other", "other"], focused: "current", main: "current", same: ==)
        precondition(supplemented.windows == ["current", "other"] && !supplemented.limited)
        let fallback = mergeApplicationWindows(listed: [String](), focused: nil, main: "main", same: ==)
        precondition(fallback.windows == ["main"] && !fallback.limited)
        let absent = mergeApplicationWindows(listed: [String](), focused: nil, main: nil, same: ==)
        precondition(absent.windows.isEmpty && !absent.limited)
        let bounded = mergeApplicationWindows(listed: ["a", "b", "c"], focused: "current", main: "a", limit: 2, same: ==)
        precondition(bounded.windows == ["current", "a"] && bounded.limited)
        // Equal labels are not equal native elements. Keep both for the caller's
        // target-ID collision check; silently merging them could select either.
        struct Window { let identity: Int; let title: String }
        let first = Window(identity: 1, title: "Project"), second = Window(identity: 2, title: "Project")
        let duplicateLabels = mergeApplicationWindows(listed: [first, second], focused: first, main: nil,
                                                       same: { $0.identity == $1.identity })
        precondition(duplicateLabels.windows.count == 2)
        precondition(uniqueApplicationWindow(windows: duplicateLabels.windows, limited: false,
                                             matching: { $0.title == "Project" }) == nil)
        let overCap = [first] + (3...129).map { Window(identity: $0, title: "Other \($0)") } + [second]
        let partial = mergeApplicationWindows(listed: overCap, focused: first, main: nil,
                                               same: { $0.identity == $1.identity })
        precondition(partial.windows.count == 128 && partial.limited)
        precondition(partial.windows.filter { $0.title == "Project" }.count == 1)
        precondition(uniqueApplicationWindow(windows: partial.windows, limited: partial.limited,
                                             matching: { $0.title == "Project" }) == nil,
                     "A duplicate beyond the cap must not make a truncated target look unique")
        precondition(uniqueApplicationWindow(windows: [first], limited: true, matching: { _ in true }) == nil,
                     "Deadline-limited observations cannot establish uniqueness")
        precondition(uniqueApplicationWindow(windows: fallback.windows, limited: fallback.limited,
                                             matching: { $0 == "main" }) == "main",
                     "Focused/main fallback remains usable without a known truncation")
        print("Application discovery checks passed (process targets, focused/main fallback, identity deduplication and bounded discovery). No desktop access used.")
    }
}
