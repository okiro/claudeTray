import AppKit

/// The menu bar gauge: a rounded outline that fills from the bottom with the 5-hour
/// utilisation. A template image, so it follows the menu bar's appearance.
enum GaugeIcon {
    static func image(fill: Double) -> NSImage {
        // Overage utilisation can exceed 1.0; clamp so the fill cannot paint over the
        // border, and guard against NaN from a malformed header.
        let level = fill.isFinite ? min(1, max(0, fill)) : 0

        let image = NSImage(size: NSSize(width: 16, height: 22), flipped: false) { _ in
            NSColor.black.setFill()
            let outline = NSBezierPath(roundedRect: NSRect(x: 2, y: 1, width: 12, height: 20), xRadius: 1.5, yRadius: 1.5)
            outline.append(NSBezierPath(rect: NSRect(x: 3, y: 2, width: 10, height: 18)))
            outline.windingRule = .evenOdd
            outline.fill()

            // The fill zone is 16pt tall; snap its height to whole Retina pixels.
            let height = (level * 32).rounded() / 2
            if height > 0 {
                NSRect(x: 4, y: 3, width: 8, height: height).fill()
            }
            return true
        }
        image.isTemplate = true
        return image
    }
}
