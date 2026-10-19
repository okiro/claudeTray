import Foundation

enum Format {
    private static let usLocale = Locale(identifier: "en_US")

    /// "$7.42", "$12.4", "$1,940"
    static func cost(_ value: Double?) -> String {
        guard let value, value.isFinite else { return "—" }
        let digits = value >= 100 ? 0 : value >= 10 ? 1 : 2
        return value.formatted(.currency(code: "USD").locale(usLocale).precision(.fractionLength(digits)))
    }

    /// "1.2m", "340k"; nil for zero so empty counts stay hidden.
    static func tokens(_ value: Int?) -> String? {
        guard let value, value > 0 else { return nil }
        let n = Double(value)
        if n >= 1e6 { return String(format: "%.1fm", n / 1e6) }
        if n >= 1e3 { return String(format: "%.0fk", n / 1e3) }
        return String(value)
    }

    /// "41.0%"; utilisation can exceed 100% while in overage.
    static func percent(_ fraction: Double) -> String {
        fraction.isFinite ? String(format: "%.1f%%", fraction * 100) : "—"
    }

    /// "Oct 19"
    static func shortDate(_ date: Date?) -> String? {
        date?.formatted(.dateTime.month(.abbreviated).day())
    }

    /// Time left until a window resets: "4d 16h", "2h 3m", "45m" or "now".
    static func countdown(to epoch: Double?, now: Date) -> String? {
        guard let epoch, epoch.isFinite else { return nil }
        let seconds = epoch - now.timeIntervalSince1970
        if seconds <= 0 { return "now" }
        let minutes = Int(seconds / 60)
        let hours = minutes / 60
        if hours >= 24 { return "\(hours / 24)d \(hours % 24)h" }
        if hours > 0 { return "\(hours)h \(minutes % 60)m" }
        return "\(minutes)m"
    }

    /// "12s ago", "3m ago"
    static func ago(_ date: Date, now: Date) -> String {
        let seconds = max(0, Int(now.timeIntervalSince(date).rounded()))
        return seconds < 60 ? "\(seconds)s ago" : "\(Int((Double(seconds) / 60).rounded()))m ago"
    }
}

/// Peak hours run 05:00–11:00 Pacific time.
enum PeakHours {
    private static let pacific: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/Los_Angeles")!
        return calendar
    }()

    static func status(at now: Date) -> (isActive: Bool, text: String) {
        let parts = pacific.dateComponents([.hour, .minute], from: now)
        let minutes = (parts.hour ?? 0) * 60 + (parts.minute ?? 0)
        let start = 5 * 60
        let end = 11 * 60
        if minutes >= start && minutes < end {
            return (true, "Peak hours end in \(span(end - minutes))")
        }
        let until = minutes < start ? start - minutes : 24 * 60 - minutes + start
        return (false, "\(span(until)) till peak hours")
    }

    private static func span(_ minutes: Int) -> String {
        minutes >= 60 ? "\(minutes / 60)h \(minutes % 60)m" : "\(minutes)m"
    }
}
