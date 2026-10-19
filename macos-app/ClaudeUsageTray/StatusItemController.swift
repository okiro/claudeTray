import AppKit
import SwiftUI

/// The menu bar item: gauge icon and 5-hour percentage, the dashboard popover on
/// left click and a small menu on right click.
@MainActor
final class StatusItemController: NSObject {
    private let model: AppModel
    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let popover = NSPopover()
    private var outsideClickMonitor: Any?
    private var escapeKeyMonitor: Any?

    init(model: AppModel) {
        self.model = model
        super.init()

        let content = NSHostingController(rootView: PopoverView(model: model))
        content.sizingOptions = .preferredContentSize
        popover.contentViewController = content
        // Dismissal (outside click, app deactivation, Esc) is handled here so that a
        // click on the menu bar item itself always toggles the popover.
        popover.behavior = .applicationDefined

        if let button = statusItem.button {
            button.target = self
            button.action = #selector(statusItemClicked)
            button.sendAction(on: [.leftMouseDown, .rightMouseDown])
            button.imagePosition = .imageLeft
            button.font = NSFont.monospacedDigitSystemFont(ofSize: NSFont.menuBarFont(ofSize: 0).pointSize, weight: .regular)
            button.toolTip = "Claude Code Usage"
        }

        NotificationCenter.default.addObserver(
            self, selector: #selector(closePopover),
            name: NSApplication.didResignActiveNotification, object: nil
        )

        observeRateLimits()
    }

    private func observeRateLimits() {
        withObservationTracking {
            updateButton()
        } onChange: { [weak self] in
            Task { @MainActor in self?.observeRateLimits() }
        }
    }

    private func updateButton() {
        guard let button = statusItem.button else { return }
        let utilization = model.rateLimits.map { $0.fiveHourUtil.isFinite ? $0.fiveHourUtil : 0 }
        button.image = GaugeIcon.image(fill: utilization ?? 0)
        button.title = utilization.map { " \(Int(($0 * 100).rounded()))%" } ?? " —"
    }

    // ─── Clicks ─────────────────────────────────────────────────────────────────

    @objc private func statusItemClicked() {
        // No current event when pressed through accessibility (e.g. VoiceOver);
        // treat that as a left click.
        let event = NSApp.currentEvent
        if event?.type == .rightMouseDown || event?.modifierFlags.contains(.control) == true {
            showMenu()
        } else if popover.isShown {
            closePopover()
        } else {
            showPopover()
        }
    }

    private func showPopover() {
        guard let button = statusItem.button else { return }
        // Not the cooperative `activate()`: the frontmost app does not yield to a menu
        // bar click, so the app stayed inactive — no Esc, no ⌘R/⌘Q, and no
        // resign-active notification to dismiss the popover on app switch.
        NSApp.activate(ignoringOtherApps: true)
        popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
        popover.contentViewController?.view.window?.makeKey()
        // The button clears its highlight when its click tracking ends, after this
        // mouse-down action. Tracking runs in the event-tracking run loop mode, so
        // highlight once the run loop is back in the default mode.
        RunLoop.main.perform(inModes: [.default]) { [weak self] in
            MainActor.assumeIsolated {
                guard let self, self.popover.isShown else { return }
                self.statusItem.button?.highlight(true)
            }
        }

        // Clicks in other apps (including other menu bar items) never reach this one,
        // so a global monitor is what notices them.
        outsideClickMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
            Task { @MainActor in self?.closePopover() }
        }
        escapeKeyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard event.keyCode == 53 else { return event } // Esc
            MainActor.assumeIsolated { self?.closePopover() }
            return nil
        }
    }

    @objc private func closePopover() {
        if popover.isShown {
            popover.performClose(nil)
        }
        statusItem.button?.highlight(false)
        if let outsideClickMonitor {
            NSEvent.removeMonitor(outsideClickMonitor)
            self.outsideClickMonitor = nil
        }
        if let escapeKeyMonitor {
            NSEvent.removeMonitor(escapeKeyMonitor)
            self.escapeKeyMonitor = nil
        }
    }

    private func showMenu() {
        closePopover()
        let menu = NSMenu()
        menu.addItem(withTitle: "Refresh", action: #selector(refreshFromMenu), keyEquivalent: "r").target = self
        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        // Attached only for this click so a left click still opens the popover.
        statusItem.menu = menu
        statusItem.button?.performClick(nil)
        statusItem.menu = nil
    }

    @objc private func refreshFromMenu() {
        Task { await model.refresh() }
    }
}
