import Foundation

/// Utilisation read from the `anthropic-ratelimit-unified-*` response headers.
struct RateLimits: Codable, Equatable, Sendable {
    var status: String
    var fiveHourUtil: Double
    /// Epoch seconds at which the 5-hour window resets.
    var fiveHourReset: Double?
    var sevenDayUtil: Double
    /// Epoch seconds at which the 7-day window resets.
    var sevenDayReset: Double?
    var overageUtil: Double
    var fetchedAt: Date
}

/// Tokens summed from local JSONL entries inside one rate-limit window.
struct WindowTokens: Codable, Equatable, Sendable {
    var input = 0
    var output = 0
    var cacheRead = 0
    var cacheWrite = 0

    var total: Int { input + output }
}

struct TimeWindow: Sendable {
    var start: Date
    var end: Date

    func contains(_ date: Date) -> Bool { date >= start && date <= end }
}

struct UsageTotals: Codable, Equatable, Sendable {
    var cost = 0.0
    var inputTokens = 0
    var outputTokens = 0
    var cacheRead = 0
    var cacheWrite = 0
    var sessions = 0
    var todayCost = 0.0
    var monthCost = 0.0
}

struct ProjectSummary: Codable, Equatable, Identifiable, Sendable {
    /// The encoded directory name under ~/.claude/projects.
    var id: String
    var name: String
    var cost: Double
    var firstSeen: Date?
    var lastSeen: Date?
    var totalTokens: Int
}

struct UsageSummary: Codable, Equatable, Sendable {
    var totals = UsageTotals()
    var recentProjects: [ProjectSummary] = []
    var topProjects: [ProjectSummary] = []
}
