import Foundation

enum Paths {
    static let claudeProjects = URL.homeDirectory.appending(path: ".claude/projects", directoryHint: .isDirectory)

    static let appSupport = URL.applicationSupportDirectory.appending(path: "Claude Usage Tray", directoryHint: .isDirectory)
    static let history = appSupport.appending(path: "usage-history.json")
    static let dashboardCache = appSupport.appending(path: "dashboard-cache.json")

    /// Data directory of the Electron build this app replaces.
    static let legacyAppSupport = URL.applicationSupportDirectory.appending(path: "claude-usage-tray", directoryHint: .isDirectory)
    static let legacyAuthFile = legacyAppSupport.appending(path: "auth.enc")

    /// Creates the data directory and, on first launch, seeds it with the Electron
    /// build's usage history so totals from deleted sessions carry over.
    static func prepare() {
        let fm = FileManager.default
        try? fm.createDirectory(at: appSupport, withIntermediateDirectories: true)
        let legacyHistory = legacyAppSupport.appending(path: "usage-history.json")
        if !fm.fileExists(atPath: history.path(percentEncoded: false)),
           fm.fileExists(atPath: legacyHistory.path(percentEncoded: false)) {
            try? fm.copyItem(at: legacyHistory, to: history)
        }
    }
}
