import AppKit

/// A small typographic portrait. Runtime state selects the expression; no model
/// request, image asset or content interpretation is involved in drawing it.
final class FeedbackFaceView: NSView {
    static let preferredSize = NSSize(width: 160, height: 116)
    private(set) var expression: FeedbackExpression = .neutral
    private(set) var phase = 0
    private var active = false
    private var timer: Timer?
    private var motionObserver: NSObjectProtocol?
    private let reduceMotion: () -> Bool
    var isAnimating: Bool { timer != nil }
    override var isFlipped: Bool { true }

    init(frame: NSRect, reduceMotion: @escaping () -> Bool = { NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }) {
        self.reduceMotion = reduceMotion
        super.init(frame: frame)
        setAccessibilityHidden(true)
        motionObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.accessibilityDisplayOptionsDidChangeNotification, object: nil, queue: .main
        ) { [weak self] _ in self?.updateMotion() }
    }

    required init?(coder: NSCoder) { nil }
    deinit {
        timer?.invalidate()
        if let observer = motionObserver { NSWorkspace.shared.notificationCenter.removeObserver(observer) }
    }

    func configure(_ expression: FeedbackExpression, active: Bool) {
        if self.expression != expression { self.expression = expression; phase = 0 }
        self.active = active
        isHidden = !active
        updateMotion()
    }

    func updateMotion() {
        if reduceMotion() { phase = 0 }
        let moving = active && !reduceMotion() && [.listening, .thinking, .focused, .happy].contains(expression)
            && !(expression == .happy && phase >= 6)
        if moving && timer == nil {
            let scheduled = Timer.scheduledTimer(withTimeInterval: 0.55, repeats: true) { [weak self] _ in self?.advanceAnimation() }
            scheduled.tolerance = 0.1
            timer = scheduled
        } else if !moving { timer?.invalidate(); timer = nil }
        needsDisplay = true
    }

    func advanceAnimation() {
        guard active, !reduceMotion() else { updateMotion(); return }
        phase += 1
        if expression == .happy && phase >= 6 { timer?.invalidate(); timer = nil }
        needsDisplay = true
    }

    func clear() {
        active = false
        timer?.invalidate(); timer = nil
        phase = 0
        expression = .neutral
        isHidden = true
    }

    static func lines(_ expression: FeedbackExpression, phase: Int = 0) -> [String] {
        let blink = phase % 8 == 7
        var top = "                     "
        var brows = "   :   -     -   :   "
        var eyes = "   :   o     o   :   "
        var mouth = "    '.   ---   .'    "
        switch expression {
        case .neutral: break
        case .listening:
            brows = "   :   .     .   :   "
            eyes = blink ? " ( :   -     -   : ) " : " ( :   O     O   : ) "
            mouth = "    '.    o    .'    "
        case .thinking:
            // Build the trail from the head toward the outer edge.
            top = ["              .      ", "              . o    ", "              . o O  "][phase % 3]
            brows = "   :   -     ~   :   "
            eyes = blink ? "   :   -     -   :   " : "   :   o'    o'  :   "
            mouth = "    '.   ._.   .'    "
        case .focused:
            eyes = blink ? "   :   -     -   :   " : "   :   o     o   :   "
            mouth = "    '.   ._.   .'    "
        case .happy:
            top = phase < 6 ? (phase % 2 == 0 ? "  +             *    " : "     *            +  ") : "                     "
            brows = "   :             :   "
            eyes = "   :   ^     ^   :   "
            mouth = "    '.  \\___/  .'    "
        case .concerned:
            brows = "   :   /     \\   :   "
            mouth = "    '.   .-.   .'    "
        }
        return [top, "       .-===-.       ", "     .:       :.     ", brows, eyes,
                "   :      .      :   ", mouth, "       '-===-'       "]
    }

    override func draw(_ dirtyRect: NSRect) {
        let font = NSFont.monospacedSystemFont(ofSize: 11.5, weight: .medium)
        let lineHeight: CGFloat = 14
        let rows = Self.lines(expression, phase: reduceMotion() ? 0 : phase)
        // Every row shares one origin and the same 21-column grid. Centering
        // individual strings shifts the outline as expressions change.
        let cellWidth = (" " as NSString).size(withAttributes: [.font: font]).width
        let origin = NSPoint(x: (bounds.width - cellWidth * 21) / 2,
                             y: (bounds.height - CGFloat(rows.count) * lineHeight) / 2)
        let outline = NSColor(white: 0.42, alpha: 1)
        let features = NSColor(white: 0.12, alpha: 1)
        for (index, row) in rows.enumerated() {
            let text = NSAttributedString(string: row, attributes: [
                .font: font, .foregroundColor: index == 4 || index == 6 ? features : outline,
            ])
            text.draw(at: NSPoint(x: origin.x, y: origin.y + CGFloat(index) * lineHeight))
        }
    }
}
