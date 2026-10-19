import Foundation
import Observation
import OSLog

private let log = Logger(subsystem: "com.claude.usage-tray", category: "model")

/// All dashboard state. The popover and the menu bar item observe it directly.
@MainActor
@Observable
final class AppModel {
    private(set) var usage: UsageSummary?
    private(set) var rateLimits: RateLimits?
    private(set) var rateLimitError: String?
    private(set) var fiveHourTokens: WindowTokens?
    private(set) var sevenDayTokens: WindowTokens?
    private(set) var plan: String?
    private(set) var isConnected = false
    /// Why the last Connect failed; shown in place of the "Not connected" hint.
    private(set) var connectError: String?
    private(set) var isRefreshing = false

    let appVersion = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""

    @ObservationIgnored private let credentials = CredentialStore()
    @ObservationIgnored private let store = UsageStore()
    @ObservationIgnored private var rateLimitFetch: Task<Void, Never>?
    @ObservationIgnored private var dataRefresh: Task<Void, Never>?

    /// Problems worth flagging. Being logged out is a deliberate state, not a fault.
    var errors: [String] {
        guard isConnected, let rateLimitError else { return [] }
        return ["Rate limits: \(rateLimitError)"]
    }

    init() {
        isConnected = credentials.isConnected
        loadCache()
    }

    func start() {
        Task { await refreshAll() }

        // Local usage every 60s; rate limits cost an API request, so every 15 minutes.
        Task { [weak self] in
            while true {
                try? await Task.sleep(for: .seconds(60))
                guard let self else { return }
                await self.refreshData()
                self.saveCache()
            }
        }
        Task { [weak self] in
            while true {
                try? await Task.sleep(for: .seconds(15 * 60))
                guard let self else { return }
                await self.refreshAll()
            }
        }
    }

    func refresh() async {
        isRefreshing = true
        defer { isRefreshing = false }
        await refreshAll()
    }

    func connect() async {
        connectError = nil
        do {
            let creds = try await credentials.login()
            plan = creds.subscriptionType
            isConnected = true
            await refreshAll()
        } catch {
            connectError = error.localizedDescription
            isConnected = credentials.isConnected
            rateLimits = nil
            await refreshData()
        }
    }

    func disconnect() async {
        await credentials.clear()
        isConnected = false
        connectError = nil
        rateLimits = nil
        rateLimitError = nil
        plan = nil
        await refreshData()
        saveCache()
    }

    private func refreshAll() async {
        await fetchRateLimits()
        await refreshData()
        saveCache()
    }

    // ─── Rate limits ────────────────────────────────────────────────────────────

    /// Concurrent callers (timers, Refresh, Connect) share one in-flight request.
    private func fetchRateLimits() async {
        if let rateLimitFetch { return await rateLimitFetch.value }
        let task = Task {
            await performRateLimitFetch(allowReimport: true)
            rateLimitFetch = nil
        }
        rateLimitFetch = task
        await task.value
    }

    private func performRateLimitFetch(allowReimport: Bool) async {
        // Re-imports from the keychain when the token has expired.
        guard let token = await credentials.validAccessToken() else {
            rateLimits = nil
            rateLimitError = "Not connected — click Connect to Claude Code"
            return
        }

        switch await RateLimitClient.fetch(accessToken: token) {
        case .limits(let limits):
            rateLimits = limits
            rateLimitError = nil
            if let subscription = await credentials.current?.subscriptionType {
                plan = subscription
            }
        case .unauthorized:
            log.info("API returned 401, re-importing from keychain")
            await credentials.clear()
            if allowReimport, await credentials.importFromKeychain() {
                return await performRateLimitFetch(allowReimport: false)
            }
            rateLimits = nil
            rateLimitError = "Auth expired — reconnect to Claude Code"
        case .failure(let message):
            rateLimits = nil
            rateLimitError = message
        }
        isConnected = credentials.isConnected
    }

    // ─── Local usage ────────────────────────────────────────────────────────────

    /// Concurrent callers share one in-flight scan, so overlapping runs cannot race
    /// each other's history writes.
    private func refreshData() async {
        if let dataRefresh { return await dataRefresh.value }
        let task = Task {
            let now = Date()
            let fiveHour = rateLimits?.fiveHourReset.map {
                TimeWindow(start: Date(timeIntervalSince1970: $0 - 5 * 3600), end: now)
            }
            let sevenDay = rateLimits?.sevenDayReset.map {
                TimeWindow(start: Date(timeIntervalSince1970: $0 - 7 * 24 * 3600), end: now)
            }
            let result = await store.load(fiveHour: fiveHour, sevenDay: sevenDay)
            usage = result.summary
            fiveHourTokens = result.fiveHourTokens
            sevenDayTokens = result.sevenDayTokens
            dataRefresh = nil
        }
        dataRefresh = task
        await task.value
    }

    // ─── Disk cache ─────────────────────────────────────────────────────────────

    /// Last known state, so the menu bar shows numbers immediately on launch.
    private struct Snapshot: Codable {
        var usage: UsageSummary?
        var rateLimits: RateLimits?
        var rateLimitError: String?
        var fiveHourTokens: WindowTokens?
        var sevenDayTokens: WindowTokens?
        var plan: String?
    }

    private func loadCache() {
        guard let data = try? Data(contentsOf: Paths.dashboardCache),
              let snapshot = try? JSONDecoder().decode(Snapshot.self, from: data)
        else { return }
        usage = snapshot.usage
        rateLimits = snapshot.rateLimits
        rateLimitError = snapshot.rateLimitError
        fiveHourTokens = snapshot.fiveHourTokens
        sevenDayTokens = snapshot.sevenDayTokens
        plan = snapshot.plan
    }

    func saveCache() {
        let snapshot = Snapshot(
            usage: usage,
            rateLimits: rateLimits,
            rateLimitError: rateLimitError,
            fiveHourTokens: fiveHourTokens,
            sevenDayTokens: sevenDayTokens,
            plan: plan
        )
        guard let data = try? JSONEncoder().encode(snapshot) else { return }
        try? data.write(to: Paths.dashboardCache, options: .atomic)
    }
}
