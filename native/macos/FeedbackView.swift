import AppKit

private enum FeedbackPalette {
    static let background = NSColor.white
    static let text = NSColor(white: 0.10, alpha: 1)
    static let secondary = NSColor(white: 0.42, alpha: 1)
    static let border = NSColor(white: 0, alpha: 0.12)
}

private final class FeedbackCloseButton: NSButton {
    override var acceptsFirstResponder: Bool { false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func draw(_ dirtyRect: NSRect) {
        if isHighlighted {
            NSColor.black.withAlphaComponent(0.06).setFill()
            NSBezierPath(roundedRect: bounds.insetBy(dx: 2, dy: 2), xRadius: 4, yRadius: 4).fill()
        }
        FeedbackPalette.secondary.setStroke()
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
    let faceView = FeedbackFaceView(frame: .zero)
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
        appearance = NSAppearance(named: .aqua)
        wantsLayer = true
        layer?.cornerRadius = 10
        layer?.masksToBounds = true

        brand.attributedStringValue = NSAttributedString(string: "OpenSaysMe", attributes: [
            .font: NSFont.systemFont(ofSize: 12, weight: .medium), .foregroundColor: FeedbackPalette.secondary,
        ])
        heading.font = .systemFont(ofSize: 23, weight: .medium)
        heading.textColor = FeedbackPalette.text
        detail.font = .systemFont(ofSize: 11.5)
        detail.textColor = FeedbackPalette.secondary
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
        scrollHint.textColor = FeedbackPalette.secondary

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
        scrollView.scrollerKnobStyle = .dark
        scrollView.verticalScrollElasticity = .none
        scrollView.horizontalScrollElasticity = .none
        scrollView.automaticallyAdjustsContentInsets = false
        scrollView.documentView = messageView
        for view in [brand, heading, scrollView, detail, scrollHint, faceView, closeButton] { addSubview(view) }
    }

    required init?(coder: NSCoder) { nil }

    @objc private func dismiss() { faceView.clear(); onDismiss?() }

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
        // Keep the portrait out of the answer column and the close button. On
        // compact displays the words take priority over decorative feedback.
        let showFace = width >= 400 && maximumHeight >= 260
        let portraitSize = FeedbackFaceView.preferredSize
        let titleWidth = showFace ? max(1, textWidth - portraitSize.width - 48) : textWidth
        let titleHeight = labelHeight(heading, text: command.title, width: titleWidth)
        let detailHeight = labelHeight(detail, text: command.detail, width: textWidth)
        let headerBottom = max(52 + titleHeight, showFace ? 24 + portraitSize.height + 4 : 0)
        let bodyTop = headerBottom + (command.message.isEmpty ? 0 : 16)
        let footerHeight = command.detail.isEmpty ? 26 : detailHeight + 38

        let paragraph = NSMutableParagraphStyle()
        paragraph.lineBreakMode = .byWordWrapping
        paragraph.lineSpacing = 4
        paragraph.paragraphSpacing = 8
        messageView.textStorage?.setAttributedString(NSAttributedString(string: command.message, attributes: [
            .font: NSFont.systemFont(ofSize: 14.5), .foregroundColor: FeedbackPalette.text,
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
        heading.frame = NSRect(x: inset - 2, y: 52, width: titleWidth + 4, height: titleHeight)
        faceView.frame = NSRect(x: width - inset - portraitSize.width - 28, y: 24,
                               width: portraitSize.width, height: portraitSize.height)
        faceView.configure(command.expression, active: showFace)
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
        faceView.clear()
    }

    override func draw(_ dirtyRect: NSRect) {
        let outline = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: 10, yRadius: 10)
        FeedbackPalette.background.setFill()
        outline.fill()
        FeedbackPalette.border.setStroke()
        outline.lineWidth = 0.75
        outline.stroke()
        if !detail.isHidden {
            let rule = NSBezierPath()
            rule.move(to: NSPoint(x: 26, y: ruleY))
            rule.line(to: NSPoint(x: bounds.width - 26, y: ruleY))
            rule.lineWidth = 0.5
            rule.stroke()
        }
    }
}
