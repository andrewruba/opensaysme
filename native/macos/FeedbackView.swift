import AppKit

private enum ConservatoryPalette {
    static let top = NSColor(srgbRed: 0.105, green: 0.175, blue: 0.145, alpha: 1)
    static let bottom = NSColor(srgbRed: 0.055, green: 0.105, blue: 0.085, alpha: 1)
    static let brass = NSColor(srgbRed: 0.70, green: 0.62, blue: 0.42, alpha: 1)
    static let ivory = NSColor(srgbRed: 0.94, green: 0.92, blue: 0.85, alpha: 1)
    static let muted = NSColor(srgbRed: 0.68, green: 0.73, blue: 0.66, alpha: 1)
}

private final class FeedbackCloseButton: NSButton {
    override var acceptsFirstResponder: Bool { false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func draw(_ dirtyRect: NSRect) {
        if isHighlighted {
            ConservatoryPalette.brass.withAlphaComponent(0.16).setFill()
            NSBezierPath(roundedRect: bounds.insetBy(dx: 2, dy: 2), xRadius: 4, yRadius: 4).fill()
        }
        ConservatoryPalette.brass.setStroke()
        let path = NSBezierPath()
        path.lineWidth = 1
        path.move(to: NSPoint(x: bounds.midX - 4, y: bounds.midY - 4))
        path.line(to: NSPoint(x: bounds.midX + 4, y: bounds.midY + 4))
        path.move(to: NSPoint(x: bounds.midX + 4, y: bounds.midY - 4))
        path.line(to: NSPoint(x: bounds.midX - 4, y: bounds.midY + 4))
        path.stroke()
    }
}

/// A fixed-width reading surface. TextKit measures the same text container that
/// draws the answer, so wrapping and document height cannot disagree.
final class FeedbackView: NSView {
    private let brand = NSTextField(labelWithString: "")
    private let heading = NSTextField(wrappingLabelWithString: "")
    private let detail = NSTextField(wrappingLabelWithString: "")
    private let scrollHint = NSTextField(labelWithString: "SCROLL TO READ")
    private let closeButton = FeedbackCloseButton()
    let scrollView = NSScrollView()
    let messageView: NSTextView
    var onDismiss: (() -> Void)?
    private var ruleY: CGFloat = 0
    private(set) var hasOverflow = false
    override var isFlipped: Bool { true }

    override init(frame: NSRect) {
        let storage = NSTextStorage()
        let manager = NSLayoutManager()
        let container = NSTextContainer(containerSize: NSSize(width: 1, height: CGFloat.greatestFiniteMagnitude))
        storage.addLayoutManager(manager)
        manager.addTextContainer(container)
        messageView = NSTextView(frame: .zero, textContainer: container)
        super.init(frame: frame)
        appearance = NSAppearance(named: .darkAqua)
        wantsLayer = true
        layer?.cornerRadius = 10
        layer?.masksToBounds = true

        let brandFont = NSFont(name: "Baskerville", size: 12) ?? .systemFont(ofSize: 11, weight: .medium)
        brand.attributedStringValue = NSAttributedString(string: "OPENSAYSME", attributes: [
            .font: brandFont, .foregroundColor: ConservatoryPalette.brass, .kern: 2.3,
        ])
        heading.font = NSFont(name: "Baskerville", size: 24) ?? .systemFont(ofSize: 22, weight: .regular)
        heading.textColor = ConservatoryPalette.ivory
        detail.font = .systemFont(ofSize: 11.5)
        detail.textColor = ConservatoryPalette.muted
        for label in [heading, detail] {
            label.maximumNumberOfLines = 0
            label.lineBreakMode = .byWordWrapping
            if let cell = label.cell as? NSTextFieldCell {
                cell.wraps = true
                cell.isScrollable = false
                cell.usesSingleLineMode = false
            }
        }
        scrollHint.font = .systemFont(ofSize: 9, weight: .medium)
        scrollHint.textColor = ConservatoryPalette.brass

        closeButton.isBordered = false
        closeButton.title = ""
        closeButton.target = self
        closeButton.action = #selector(dismiss)
        closeButton.toolTip = "Dismiss response"
        closeButton.setAccessibilityLabel("Dismiss response")

        messageView.isEditable = false
        messageView.isSelectable = false
        messageView.isRichText = false
        messageView.drawsBackground = false
        messageView.textContainerInset = .zero
        messageView.isHorizontallyResizable = false
        messageView.isVerticallyResizable = true
        container.lineFragmentPadding = 0
        container.widthTracksTextView = false
        container.heightTracksTextView = false
        scrollView.borderType = .noBorder
        scrollView.drawsBackground = false
        scrollView.hasVerticalScroller = true
        scrollView.hasHorizontalScroller = false
        scrollView.autohidesScrollers = true
        scrollView.scrollerStyle = .overlay
        scrollView.scrollerKnobStyle = .light
        scrollView.verticalScrollElasticity = .none
        scrollView.horizontalScrollElasticity = .none
        scrollView.automaticallyAdjustsContentInsets = false
        scrollView.documentView = messageView
        for view in [brand, heading, scrollView, detail, scrollHint, closeButton] { addSubview(view) }
    }

    required init?(coder: NSCoder) { nil }

    @objc private func dismiss() { onDismiss?() }

    private func labelHeight(_ label: NSTextField, text: String, width: CGFloat, spacing: CGFloat = 2) -> CGFloat {
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineBreakMode = .byWordWrapping
        paragraph.lineSpacing = spacing
        label.preferredMaxLayoutWidth = width
        label.attributedStringValue = NSAttributedString(string: text, attributes: [
            .font: label.font!, .foregroundColor: label.textColor!, .paragraphStyle: paragraph,
        ])
        guard !text.isEmpty else { return 0 }
        return ceil(label.attributedStringValue.boundingRect(with: NSSize(width: max(1, width - 4), height: CGFloat.greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin, .usesFontLeading]).height) + 4
    }

    @discardableResult
    func configure(_ command: FeedbackCommand, width: CGFloat, maximumHeight: CGFloat) -> CGFloat {
        let inset: CGFloat = 26
        let textWidth = max(1, width - inset * 2)
        let titleHeight = labelHeight(heading, text: command.title, width: textWidth)
        let detailHeight = labelHeight(detail, text: command.detail, width: textWidth)
        let bodyTop = 52 + titleHeight + (command.message.isEmpty ? 0 : 16)
        let footerHeight = command.detail.isEmpty ? 26 : detailHeight + 38

        let paragraph = NSMutableParagraphStyle()
        paragraph.lineBreakMode = .byWordWrapping
        paragraph.lineSpacing = 4
        paragraph.paragraphSpacing = 8
        messageView.textStorage?.setAttributedString(NSAttributedString(string: command.message, attributes: [
            .font: NSFont.systemFont(ofSize: 14.5), .foregroundColor: ConservatoryPalette.ivory,
            .paragraphStyle: paragraph,
        ]))
        // Reserve a little space for the overlay scroller, without covering text.
        let container = messageView.textContainer!
        container.containerSize = NSSize(width: max(1, textWidth - 12), height: CGFloat.greatestFiniteMagnitude)
        let manager = messageView.layoutManager!
        manager.ensureLayout(for: container)
        let documentHeight = command.message.isEmpty ? 0 : ceil(manager.usedRect(for: container).height) + 4
        hasOverflow = bodyTop + documentHeight + footerHeight > maximumHeight
        let hintHeight: CGFloat = hasOverflow ? 22 : 0
        let height = min(maximumHeight, bodyTop + documentHeight + footerHeight + hintHeight)
        let viewportHeight = max(0, height - bodyTop - footerHeight - hintHeight)
        setFrameSize(NSSize(width: width, height: height))
        brand.frame = NSRect(x: inset, y: 23, width: max(1, textWidth - 35), height: 18)
        closeButton.frame = NSRect(x: width - inset - 23, y: 17, width: 28, height: 28)
        closeButton.isHidden = !command.persistent
        heading.frame = NSRect(x: inset - 2, y: 52, width: textWidth + 4, height: titleHeight)
        scrollView.isHidden = command.message.isEmpty
        scrollView.frame = NSRect(x: inset, y: bodyTop, width: textWidth, height: viewportHeight)
        messageView.setFrameSize(NSSize(width: textWidth, height: max(documentHeight, viewportHeight)))
        scrollView.contentView.scroll(to: .zero)
        scrollView.reflectScrolledClipView(scrollView.contentView)
        scrollHint.isHidden = !hasOverflow
        scrollHint.frame = NSRect(x: inset, y: bodyTop + viewportHeight + 7, width: textWidth, height: 14)
        ruleY = height - footerHeight + 10
        detail.isHidden = command.detail.isEmpty
        detail.frame = NSRect(x: inset - 2, y: height - footerHeight + 22, width: textWidth + 4, height: detailHeight)
        needsDisplay = true
        return height
    }

    func clear() {
        heading.stringValue = ""
        detail.stringValue = ""
        messageView.string = ""
        hasOverflow = false
    }

    override func draw(_ dirtyRect: NSRect) {
        let outline = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: 10, yRadius: 10)
        NSGradient(starting: ConservatoryPalette.top, ending: ConservatoryPalette.bottom)?.draw(in: outline, angle: 90)
        ConservatoryPalette.brass.withAlphaComponent(0.65).setStroke()
        outline.lineWidth = 0.75
        outline.stroke()
        let inner = NSBezierPath(roundedRect: bounds.insetBy(dx: 6.5, dy: 6.5), xRadius: 5, yRadius: 5)
        ConservatoryPalette.brass.withAlphaComponent(0.18).setStroke()
        inner.lineWidth = 0.5
        inner.stroke()
        if !detail.isHidden {
            let rule = NSBezierPath()
            rule.move(to: NSPoint(x: 26, y: ruleY))
            rule.line(to: NSPoint(x: bounds.width - 26, y: ruleY))
            rule.lineWidth = 0.5
            rule.stroke()
        }
    }
}
