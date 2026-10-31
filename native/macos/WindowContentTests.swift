import ApplicationServices
import Foundation

@main
struct WindowContentTests {
    static func main() throws {
        var reads: [(Int, String)] = []
        let attributes: [Int: [String: String]] = [
            0: [kAXRoleAttribute: "AXWindow", kAXTitleAttribute: "Project"],
            1: [kAXRoleAttribute: "AXTextArea", kAXValueAttribute: "frontend/App.tsx"],
            2: [kAXRoleAttribute: "AXTextField", kAXSubroleAttribute: kAXSecureTextFieldSubrole,
                kAXTitleAttribute: "private label", kAXValueAttribute: "private password"],
            3: [kAXRoleAttribute: "AXStaticText", kAXValueAttribute: "private child"],
        ]
        let graph = [0: [1, 2], 2: [3]]
        var childReads: [Int] = []
        let content = collectWindowContent(root: 0, deadline: 10, now: { 0 }, same: ==,
            read: { node, attribute in reads.append((node, attribute)); return attributes[node]?[attribute] },
            children: { node, limit in childReads.append(node); return Array((graph[node] ?? []).prefix(limit)) })
        precondition(content.nodes.count == 2 && content.nodes[1].parent == 0)
        precondition(content.nodes[1].value == "frontend/App.tsx")
        precondition(content.warnings.contains { $0.contains("Secure") })
        precondition(!reads.contains { $0.0 == 2 && [kAXTitleAttribute, kAXValueAttribute].contains($0.1) })
        precondition(!reads.contains { $0.0 == 3 } && !childReads.contains(2))
        let encoded = String(data: try JSONEncoder().encode(content.nodes), encoding: .utf8)!
        precondition(encoded.contains("\"parent\":null") && !encoded.contains("private"))

        let wideChildren: (Int, Int) -> [Int] = { node, limit in
            if node != 0 { return [] }
            return Array(1...min(1000, limit))
        }
        let large = collectWindowContent(root: 0, deadline: 10, now: { 0 }, same: { (a: Int, b: Int) in a == b },
            read: { (_, attribute) -> String? in
                if attribute == kAXRoleAttribute { return "AXTextArea" }
                if attribute == kAXValueAttribute { return String(repeating: "😀", count: 3000) }
                return nil
            }, children: wideChildren)
        precondition(large.nodes.allSatisfy { ($0.value?.utf16.count ?? 0) <= 2048 })
        let textSize = large.nodes.reduce(0) { (total: Int, node: WindowContentNode) in
            total + node.role.utf16.count + (node.value?.utf16.count ?? 0)
        }
        precondition(textSize <= 16_384)
        precondition(large.warnings.contains { $0.contains("limited") })

        let wide = collectWindowContent(root: 0, deadline: 10, now: { 0 }, same: { (a: Int, b: Int) in a == b },
            read: { _, attribute in attribute == kAXRoleAttribute ? "AXButton" : nil },
            children: wideChildren)
        precondition(wide.nodes.count == 128 && wide.warnings.contains { $0.contains("limited") })
        let deep = collectWindowContent(root: 0, deadline: 10, now: { 0 }, same: ==,
            read: { _, attribute in attribute == kAXRoleAttribute ? "AXGroup" : nil },
            children: { node, _ in [node + 1] })
        precondition(deep.nodes.count == 128 && deep.warnings.contains { $0.contains("limited") })
        // The captured ChatGPT window had seven wrappers before AXWebArea at
        // depth eight. Inspect its contents instead of stopping at the page.
        let embeddedPage = collectWindowContent(root: 0, deadline: 10, now: { 0 }, same: ==,
            read: { node, attribute in
                if attribute == kAXRoleAttribute {
                    return node == 0 ? "AXWindow" : node == 8 ? "AXWebArea" : node == 12 ? "AXTextArea" : "AXGroup"
                }
                if node == 12 && attribute == kAXDescriptionAttribute { return "Message" }
                return nil
            }, children: { node, _ in node < 12 ? [node + 1] : [] })
        precondition(embeddedPage.nodes.last?.role == "AXTextArea" && embeddedPage.nodes.last?.description == "Message")
        precondition(embeddedPage.nodes.last?.parent == 11 && !embeddedPage.warnings.contains { $0.contains("limited") })
        let cycle = collectWindowContent(root: 0, deadline: 10, now: { 0 }, same: ==,
            read: { _, attribute in attribute == kAXRoleAttribute ? "AXGroup" : nil }, children: { _, _ in [0] })
        precondition(cycle.nodes.count == 1 && cycle.warnings.contains { $0.contains("repeated") })

        var clock = 0.0
        let timed = collectWindowContent(root: 0, deadline: 1, now: { clock }, same: ==,
            read: { _, attribute in attribute == kAXRoleAttribute ? "AXWindow" : nil },
            children: { _, _ in clock = 2; return [1] })
        precondition(timed.nodes.count == 1 && timed.warnings.contains { $0.contains("limited") })
        struct Inaccessible: Error {}
        let inaccessible = collectWindowContent(root: 0, deadline: 10, now: { 0 }, same: ==,
            read: { _, attribute in
                if attribute == kAXSubroleAttribute { throw Inaccessible() }
                precondition(attribute != kAXValueAttribute, "Do not read values when protection cannot be checked")
                return "AXTextField"
            }, children: { _, _ in preconditionFailure("Do not descend through inaccessible protection metadata") })
        precondition(inaccessible.nodes.isEmpty && inaccessible.warnings.contains { $0.contains("inaccessible") })

        print("Window content checks passed (target text, protected subtrees, bounds, cycles, deadlines and inaccessible elements).")
    }
}
