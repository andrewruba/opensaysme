import ApplicationServices
import CryptoKit
import Foundation

struct WindowContentNode: Encodable {
    let parent: Int?
    let role: String
    let title: String?
    let description: String?
    let value: String?

    private enum CodingKeys: String, CodingKey { case parent, role, title, description, value }
    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(parent, forKey: .parent)
        try container.encode(role, forKey: .role)
        try container.encodeIfPresent(title, forKey: .title)
        try container.encodeIfPresent(description, forKey: .description)
        try container.encodeIfPresent(value, forKey: .value)
    }
}

struct WindowContent {
    let nodes: [WindowContentNode]
    let warnings: [String]
    // Completeness of this exposed AX tree, not proof that an application exposes
    // hidden/virtualized state or that the observation was atomic.
    let fullyTraversed: Bool
}

enum WindowContentFingerprintError: Error { case incomplete }

// Input may commit values outside the hit control (e.g. a Submit button). Bind the
// entire observed window's bounded content, and never hash a silently partial tree.
func windowContentFingerprint(_ content: WindowContent) throws -> String {
    guard content.fullyTraversed, !content.nodes.isEmpty else { throw WindowContentFingerprintError.incomplete }
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    return SHA256.hash(data: try encoder.encode(content.nodes)).map { String(format: "%02x", $0) }.joined()
}

// The injected reads keep the same bounded traversal testable without reading
// the user's desktop. Children reads must return at most the requested count.
func collectWindowContent<Element>(
    root: Element, deadline: TimeInterval,
    valueLimit: Int = 2048,
    now: () -> TimeInterval = { ProcessInfo.processInfo.systemUptime },
    same: (Element, Element) -> Bool,
    read: (Element, String) throws -> String?,
    children: (Element, Int) throws -> [Element]
) -> WindowContent {
    // Input revalidation needs the full permitted 4096-unit text value; public
    // inspection retains its smaller default and the same total content budget.
    precondition(valueLimit > 0 && valueLimit <= 4096)
    var pending: [(Element, Int?, Int)] = [(root, nil, 0)]
    var visited: [Element] = []
    var nodes: [WindowContentNode] = []
    var remaining = 16_384
    var limited = false
    var omitted = false
    var protected = false
    func clipped(_ text: String?, maximum: Int) -> String? {
        guard let text, !text.isEmpty else { return nil }
        let limit = min(remaining, maximum)
        let units = Array(text.utf16.prefix(limit + 1))
        if units.count > limit { limited = true }
        let value = String(decoding: units.prefix(limit), as: UTF16.self)
        remaining -= value.utf16.count
        return value.isEmpty ? nil : value
    }
    while let (element, parent, depth) = pending.popLast() {
        if now() >= deadline || visited.count >= 128 || remaining <= 128 { limited = true; break }
        if visited.contains(where: { same($0, element) }) { omitted = true; continue }
        visited.append(element)
        do {
            // Do not read labels, values, or descendants of protected fields.
            guard let role = try read(element, kAXRoleAttribute), !role.isEmpty else { omitted = true; continue }
            if try read(element, kAXSubroleAttribute) == kAXSecureTextFieldSubrole { protected = true; continue }
            guard let boundedRole = clipped(role, maximum: 128) else { limited = true; break }
            let title = clipped(try read(element, kAXTitleAttribute), maximum: 2048)
            let description = clipped(try read(element, kAXDescriptionAttribute), maximum: 2048)
            let value = clipped(try read(element, kAXValueAttribute), maximum: valueLimit)
            let index = nodes.count
            nodes.append(WindowContentNode(parent: parent, role: boundedRole, title: title, description: description, value: value))
            let capacity = max(0, 128 - visited.count - pending.count)
            let descendants = try children(element, depth < 8 ? capacity + 1 : 1)
            if depth >= 8 {
                if !descendants.isEmpty { limited = true }
                continue
            }
            if descendants.count > capacity { limited = true }
            for child in descendants.prefix(capacity).reversed() { pending.append((child, index, depth + 1)) }
        } catch { omitted = true }
    }
    var warnings = ["Accessibility content is a non-atomic observation and may omit hidden or virtualized content."]
    if limited { warnings.append("Content was limited by time, depth, node count, or text size; missing content does not establish absence.") }
    if omitted { warnings.append("Some inaccessible, changed, or repeated elements were omitted.") }
    if protected { warnings.append("Secure text fields and their descendants were omitted.") }
    return WindowContent(nodes: nodes, warnings: warnings, fullyTraversed: !limited && !omitted && !protected)
}
