import Foundation

/// Turns Claude Code's JSONL transcripts in ~/.claude/projects into cost and token
/// totals, merged with a persisted history so usage from deleted sessions survives.
///
/// Parsed entries are cached per file, keyed by modification date and size, so a
/// refresh only re-reads transcripts that changed since the previous one.
actor UsageStore {
    /// Bumped whenever a parser bug made previously-persisted numbers untrustworthy.
    /// A history file with a different version is discarded, which resets the
    /// high-water marks instead of preserving bad values forever.
    /// v2: dedupe streamed assistant entries, fix cache-token double-subtraction,
    ///     correct/extend model pricing, local-time day keys.
    /// v3: price Opus 5.5, Fable 5.1, Haiku 5.5 and the other 5.x models v2 billed at
    ///     the fallback rate. A v2 file is corrected instead of discarded, because it
    ///     also holds usage whose transcripts are gone (see HistoryV2Correction).
    static let historyVersion = 3

    struct Result: Sendable {
        var summary: UsageSummary
        var fiveHourTokens: WindowTokens?
        var sevenDayTokens: WindowTokens?
    }

    private let projectsDir: URL
    private let historyURL: URL
    private var parsedFiles: [String: ParsedFile] = [:]
    private var resolvedPaths: [String: String] = [:]

    init(projectsDir: URL = Paths.claudeProjects, historyURL: URL = Paths.history) {
        self.projectsDir = projectsDir
        self.historyURL = historyURL
    }

    /// Scans every project, merges the result into the persisted history (values
    /// only ever go up) and saves it. Token counts are also summed for the given
    /// rate-limit windows, which the API reports only as percentages.
    func load(fiveHour: TimeWindow?, sevenDay: TimeWindow?) -> Result {
        let fm = FileManager.default
        let now = Date()
        var days = DayKeys(calendar: .current)
        let today = days.key(for: now)
        let month = String(today.prefix(7))

        var fiveHourWindow = fiveHour.map { WindowAccumulator(window: $0) }
        var sevenDayWindow = sevenDay.map { WindowAccumulator(window: $0) }

        guard let topLevel = try? fm.contentsOfDirectory(atPath: projectsDir.path(percentEncoded: false)) else {
            return Result(summary: UsageSummary(), fiveHourTokens: fiveHourWindow?.tokens, sevenDayTokens: sevenDayWindow?.tokens)
        }

        var history = loadHistory()
        var historyV2Correction = history.version == 2 ? HistoryV2Correction() : nil

        var projects: [String: Project] = [:]
        var order: [String] = []
        var dailyUsage: [String: Double] = [:]
        var globalModelBreakdown: [String: Double] = [:]
        // Shared across every project and file so cross-file duplicates from resumed
        // sessions are counted once. Whichever project is scanned first owns a
        // duplicated entry, so the scan order is sorted: unstable attribution would
        // let the high-water-mark merge credit the same cost to two projects across
        // successive runs, re-inflating exactly what this dedup removes.
        var seen = Set<String>()
        var livePaths = Set<String>()

        let projectDirs = topLevel.filter { isDirectory(projectsDir.appending(path: $0).path(percentEncoded: false)) }.sorted()

        for dir in projectDirs {
            let projectDir = projectsDir.appending(path: dir, directoryHint: .isDirectory)
            guard let names = try? fm.contentsOfDirectory(atPath: projectDir.path(percentEncoded: false)) else { continue }

            let resolvedPath = resolveProjectPath(dir)
            var project = Project(name: Self.shortName(resolvedPath), fullPath: resolvedPath)
            var sessions = Set<String>()
            // Claude Code records the real working directory on its entries. That is
            // the only unambiguous source for the project path — the directory name
            // encodes "/" as "-", so "beply.io-vps" and "beply.io/vps" are identical
            // once encoded.
            var recordedCwd: String?

            for name in names.filter({ $0.hasSuffix(".jsonl") }).sorted() {
                let path = projectDir.appending(path: name).path(percentEncoded: false)
                guard let file = parsedFile(at: path) else { continue }
                livePaths.insert(path)
                if recordedCwd == nil { recordedCwd = file.cwd }

                for entry in file.entries {
                    fiveHourWindow?.add(entry, fileModified: file.modified)
                    sevenDayWindow?.add(entry, fileModified: file.modified)

                    if let key = entry.dedupeKey, !seen.insert(key).inserted { continue }

                    // project.cost is recomputed from dailyCost after the history merge,
                    // so every entry's cost must land in a dailyCost bucket.
                    project.inputTokens += entry.input
                    project.outputTokens += entry.output
                    project.cacheRead += entry.cacheRead
                    project.cacheWrite += entry.cacheWrite
                    if let sessionId = entry.sessionId { sessions.insert(sessionId) }

                    if let ts = entry.timestamp {
                        if project.firstSeen.map({ ts < $0 }) ?? true { project.firstSeen = ts }
                        if project.lastSeen.map({ ts > $0 }) ?? true { project.lastSeen = ts }
                        let day = days.key(for: ts)
                        project.dailyCost[day, default: 0] += entry.cost
                        dailyUsage[day, default: 0] += entry.cost
                    } else {
                        // No usable timestamp: keep the cost in the project total under a
                        // key that can never match a today/month prefix filter.
                        project.dailyCost["unknown", default: 0] += entry.cost
                    }

                    project.modelBreakdown[entry.model, default: 0] += entry.cost
                    globalModelBreakdown[entry.model, default: 0] += entry.cost

                    if entry.historyV2Cost != entry.cost {
                        historyV2Correction?.add(
                            entry.historyV2Cost - entry.cost, project: dir, model: entry.model,
                            day: entry.timestamp.map { days.key(for: $0) }
                        )
                    }
                }
            }

            project.sessions = sessions.count
            if let recordedCwd {
                project.fullPath = recordedCwd
                project.name = Self.shortName(recordedCwd)
            }
            projects[dir] = project
            order.append(dir)
        }

        parsedFiles = parsedFiles.filter { livePaths.contains($0.key) }

        // ─── Merge with persisted history ───────────────────────────────────────
        historyV2Correction?.apply(to: &history)
        Self.mergeMax(&dailyUsage, history.dailyUsage)
        Self.mergeMax(&globalModelBreakdown, history.globalModelBreakdown)

        for dir in history.projects.keys.sorted() {
            let saved = history.projects[dir]!
            if var project = projects[dir] {
                Self.mergeMax(&project.dailyCost, saved.dailyCost)
                Self.mergeMax(&project.modelBreakdown, saved.modelBreakdown)
                project.inputTokens = max(project.inputTokens, saved.inputTokens)
                project.outputTokens = max(project.outputTokens, saved.outputTokens)
                project.cacheRead = max(project.cacheRead, saved.cacheRead)
                project.cacheWrite = max(project.cacheWrite, saved.cacheWrite)
                project.sessions = max(project.sessions, saved.sessionCount)
                if let first = saved.firstSeen.flatMap(Self.parseDate), project.firstSeen.map({ first < $0 }) ?? true {
                    project.firstSeen = first
                }
                if let last = saved.lastSeen.flatMap(Self.parseDate), project.lastSeen.map({ last > $0 }) ?? true {
                    project.lastSeen = last
                }
                projects[dir] = project
            } else {
                // Every transcript of this project was deleted — restore it from history.
                projects[dir] = Project(restoring: saved, dir: dir)
                order.append(dir)
            }
        }
        for dir in order {
            projects[dir]!.cost = projects[dir]!.dailyCost.values.reduce(0, +)
        }

        var updated = History()
        updated.lastUpdated = Self.formatDate(now)
        updated.dailyUsage = dailyUsage
        updated.globalModelBreakdown = globalModelBreakdown
        for (dir, project) in projects {
            updated.projects[dir] = HistoryProject(project)
        }
        saveHistory(updated)

        // ─── Summary ────────────────────────────────────────────────────────────
        var totals = UsageTotals()
        for project in projects.values {
            totals.cost += project.cost
            totals.inputTokens += project.inputTokens
            totals.outputTokens += project.outputTokens
            totals.cacheRead += project.cacheRead
            totals.cacheWrite += project.cacheWrite
            totals.sessions += project.sessions
        }
        totals.todayCost = dailyUsage[today] ?? 0
        totals.monthCost = dailyUsage.filter { $0.key.hasPrefix(month) }.values.reduce(0, +)

        let all = order.map { (dir: $0, project: projects[$0]!) }
        let recent = all
            .filter { $0.project.lastSeen != nil }
            .sorted { $0.project.lastSeen! > $1.project.lastSeen! }
            .prefix(3)
        let top = all
            .sorted { $0.project.cost > $1.project.cost }
            .prefix(3)

        return Result(
            summary: UsageSummary(
                totals: totals,
                recentProjects: recent.map { $0.project.summary(id: $0.dir) },
                topProjects: top.map { $0.project.summary(id: $0.dir) }
            ),
            fiveHourTokens: fiveHourWindow?.tokens,
            sevenDayTokens: sevenDayWindow?.tokens
        )
    }

    // ─── Transcript parsing ─────────────────────────────────────────────────────

    private func parsedFile(at path: String) -> ParsedFile? {
        guard let attributes = try? FileManager.default.attributesOfItem(atPath: path),
              let modified = attributes[.modificationDate] as? Date,
              let size = (attributes[.size] as? NSNumber)?.intValue
        else { return nil }
        if let cached = parsedFiles[path], cached.modified == modified, cached.size == size {
            return cached
        }
        guard let data = FileManager.default.contents(atPath: path) else { return nil }
        let parsed = Self.parse(data, modified: modified, size: size)
        parsedFiles[path] = parsed
        return parsed
    }

    private static let assistantNeedle = Array(#""assistant""#.utf8)
    private static let cwdNeedle = Array(#""cwd""#.utf8)

    private static func parse(_ data: Data, modified: Date, size: Int) -> ParsedFile {
        var entries: [Entry] = []
        var cwd: String?

        data.withUnsafeBytes { (buffer: UnsafeRawBufferPointer) in
            guard let base = buffer.baseAddress else { return }
            var offset = 0
            while offset < buffer.count {
                let lineStart = base + offset
                let remaining = buffer.count - offset
                let length = memchr(lineStart, 0x0A, remaining).map { UnsafeRawPointer($0) - lineStart } ?? remaining
                offset += length + 1
                guard length > 0 else { continue }

                // Most lines are user turns and tool results. Only decode the ones that
                // can hold an assistant entry, or a cwd while the file's is still unknown.
                let mayBeAssistant = contains(assistantNeedle, in: lineStart, length: length)
                let mayHaveCwd = cwd == nil && contains(cwdNeedle, in: lineStart, length: length)
                guard mayBeAssistant || mayHaveCwd else { continue }

                let line = Data(bytes: lineStart, count: length)
                guard let object = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any] else { continue }
                if cwd == nil, let value = object["cwd"] as? String, value.hasPrefix("/") {
                    cwd = value
                }
                if let entry = Entry(object) {
                    entries.append(entry)
                }
            }
        }

        return ParsedFile(modified: modified, size: size, entries: entries, cwd: cwd)
    }

    private static func contains(_ needle: [UInt8], in bytes: UnsafeRawPointer, length: Int) -> Bool {
        needle.withUnsafeBytes { memmem(bytes, length, $0.baseAddress, $0.count) != nil }
    }

    // ─── Project paths ──────────────────────────────────────────────────────────

    /// The directory name replaces every "/" with "-", so "Birja-IO" and "Birja/IO"
    /// encode identically. Recover the real path by walking the filesystem, preferring
    /// the longest segment that exists at each level, and fall back to the naive
    /// decode for directories that are gone.
    private func resolveProjectPath(_ dirName: String) -> String {
        if let cached = resolvedPaths[dirName] { return cached }

        let trimmed = dirName.hasPrefix("-") ? String(dirName.dropFirst()) : dirName
        let parts = trimmed.split(separator: "-", omittingEmptySubsequences: false).map(String.init)
        var base = "/"
        var index = 0
        var resolved = true

        while index < parts.count {
            var matched = 0
            for take in stride(from: parts.count - index, through: 1, by: -1) {
                let segment = parts[index..<(index + take)].joined(separator: "-")
                let candidate = (base as NSString).appendingPathComponent(segment)
                if isDirectory(candidate) {
                    base = candidate
                    matched = take
                    break
                }
            }
            if matched == 0 {
                resolved = false
                break
            }
            index += matched
        }

        let result = resolved ? base : dirName.replacingOccurrences(of: "-", with: "/")
        resolvedPaths[dirName] = result
        return result
    }

    private func isDirectory(_ path: String) -> Bool {
        var isDir: ObjCBool = false
        return FileManager.default.fileExists(atPath: path, isDirectory: &isDir) && isDir.boolValue
    }

    private static func shortName(_ fullPath: String) -> String {
        fullPath.split(separator: "/").last.map(String.init) ?? fullPath
    }

    // ─── History persistence ────────────────────────────────────────────────────

    private func loadHistory() -> History {
        guard let data = try? Data(contentsOf: historyURL),
              let history = try? JSONDecoder().decode(History.self, from: data),
              history.version == Self.historyVersion || history.version == 2
        else { return History() }
        return history
    }

    private func saveHistory(_ history: History) {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        guard let data = try? encoder.encode(history) else { return }
        try? data.write(to: historyURL, options: .atomic)
    }

    private static func mergeMax(_ target: inout [String: Double], _ source: [String: Double]) {
        for (key, value) in source {
            target[key] = max(target[key] ?? 0, value)
        }
    }

    // ─── Dates ──────────────────────────────────────────────────────────────────

    private static let isoFractional = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
    private static let isoPlain = Date.ISO8601FormatStyle()

    fileprivate static func parseDate(_ string: String) -> Date? {
        (try? isoFractional.parse(string)) ?? (try? isoPlain.parse(string))
    }

    /// "2026-10-19T09:01:02.123Z". Rounds to whole milliseconds itself: the format
    /// style truncates, and a date parsed from ".772" is stored as ".77199…", so it
    /// would be written back as ".771" and firstSeen would creep earlier on every save.
    fileprivate static func formatDate(_ date: Date) -> String {
        let ms = Int64((date.timeIntervalSince1970 * 1000).rounded())
        let (seconds, millis) = ms.quotientAndRemainder(dividingBy: 1000)
        let whole = isoPlain.format(Date(timeIntervalSince1970: TimeInterval(seconds)))
        return "\(whole.dropLast()).\(String(1000 + millis).dropFirst())Z"
    }
}

// ─── Types ──────────────────────────────────────────────────────────────────────

/// One billed assistant response.
private struct Entry {
    let dedupeKey: String?
    let timestamp: Date?
    let model: String
    let cost: Double
    /// What history v2 recorded for this entry; differs for models it did not price.
    let historyV2Cost: Double
    let input: Int
    let output: Int
    let cacheRead: Int
    let cacheWrite: Int
    let sessionId: String?

    init?(_ object: [String: Any]) {
        guard object["type"] as? String == "assistant" else { return nil }
        let message = object["message"] as? [String: Any]
        let usage = (message?["usage"] as? [String: Any]) ?? (object["usage"] as? [String: Any]) ?? [:]

        // Claude Code writes one line per content block of a streamed response, each
        // repeating the same message id, request id and full usage object, so summing
        // them multiplies cost by the number of blocks. Resumed sessions also copy
        // entries into a new file. An entry with neither id cannot be a known duplicate.
        let messageId = Self.string(message?["id"])
        let requestId = Self.string(object["requestId"]) ?? Self.string(object["request_id"])
        if let messageId {
            dedupeKey = "\(messageId):\(requestId ?? "")"
        } else if let requestId {
            dedupeKey = "req:\(requestId)"
        } else {
            dedupeKey = nil
        }

        input = Self.int(usage["input_tokens"])
        output = Self.int(usage["output_tokens"])
        cacheRead = Self.int(usage["cache_read_input_tokens"])
        cacheWrite = Self.int(usage["cache_creation_input_tokens"])
        model = Self.string(message?["model"]) ?? Self.string(object["model"]) ?? "unknown"
        if let reported = (object["costUSD"] as? NSNumber)?.doubleValue, reported != 0 {
            cost = reported
            historyV2Cost = reported
        } else {
            cost = Pricing.cost(model: model, input: input, output: output, cacheRead: cacheRead, cacheWrite: cacheWrite)
            historyV2Cost = Pricing.historyV2Cost(model: model, input: input, output: output, cacheRead: cacheRead, cacheWrite: cacheWrite)
        }
        sessionId = Self.string(object["sessionId"])
        timestamp = Self.string(object["timestamp"]).flatMap(UsageStore.parseDate)
    }

    private static func string(_ value: Any?) -> String? {
        guard let string = value as? String, !string.isEmpty else { return nil }
        return string
    }

    private static func int(_ value: Any?) -> Int {
        (value as? NSNumber)?.intValue ?? 0
    }
}

private struct ParsedFile {
    let modified: Date
    let size: Int
    let entries: [Entry]
    /// First absolute working directory recorded in the file.
    let cwd: String?
}

private struct WindowAccumulator {
    let window: TimeWindow
    var tokens = WindowTokens()
    var seen = Set<String>()

    mutating func add(_ entry: Entry, fileModified: Date) {
        // A file last written before the window opened cannot contain entries inside it.
        guard fileModified >= window.start,
              let ts = entry.timestamp, window.contains(ts)
        else { return }
        if let key = entry.dedupeKey, !seen.insert(key).inserted { return }
        tokens.input += entry.input
        tokens.output += entry.output
        tokens.cacheRead += entry.cacheRead
        tokens.cacheWrite += entry.cacheWrite
    }
}

/// Re-prices a v2 history. Its high-water marks hold fallback-rate costs for models
/// v2 could not price, and the max-merge would keep any of those that exceed the
/// correct value forever. For each such entry still on disk, the difference is taken
/// out of every total it was recorded in; the correct cost then comes back through
/// the merge. Entries whose transcripts are gone keep their fallback-rate cost.
private struct HistoryV2Correction {
    private var daily: [String: Double] = [:]
    private var models: [String: Double] = [:]
    private var projectDaily: [String: [String: Double]] = [:]
    private var projectModels: [String: [String: Double]] = [:]

    /// `delta` is the v2 cost minus the correct cost; nil `day` means no timestamp.
    mutating func add(_ delta: Double, project: String, model: String, day: String?) {
        if let day { daily[day, default: 0] += delta }
        models[model, default: 0] += delta
        projectDaily[project, default: [:]][day ?? "unknown", default: 0] += delta
        projectModels[project, default: [:]][model, default: 0] += delta
    }

    func apply(to history: inout History) {
        Self.subtract(daily, from: &history.dailyUsage)
        Self.subtract(models, from: &history.globalModelBreakdown)
        for (dir, deltas) in projectDaily where history.projects[dir] != nil {
            Self.subtract(deltas, from: &history.projects[dir]!.dailyCost)
        }
        for (dir, deltas) in projectModels where history.projects[dir] != nil {
            Self.subtract(deltas, from: &history.projects[dir]!.modelBreakdown)
        }
    }

    private static func subtract(_ deltas: [String: Double], from totals: inout [String: Double]) {
        for (key, delta) in deltas {
            if let total = totals[key] {
                totals[key] = max(0, total - delta)
            }
        }
    }
}

/// Day keys in the user's local time zone. Consecutive entries usually fall on the
/// same day, so the last day's interval is reused instead of asking the calendar.
private struct DayKeys {
    let calendar: Calendar
    private var current: (start: Date, end: Date, key: String)?

    init(calendar: Calendar) {
        self.calendar = calendar
    }

    mutating func key(for date: Date) -> String {
        if let current, date >= current.start, date < current.end {
            return current.key
        }
        let c = calendar.dateComponents([.year, .month, .day], from: date)
        let key = "\(c.year!)-\(Self.pad(c.month!))-\(Self.pad(c.day!))"
        if let interval = calendar.dateInterval(of: .day, for: date) {
            current = (interval.start, interval.end, key)
        }
        return key
    }

    private static func pad(_ n: Int) -> String { n < 10 ? "0\(n)" : "\(n)" }
}

private struct Project {
    var name: String
    var fullPath: String
    var cost = 0.0
    var inputTokens = 0
    var outputTokens = 0
    var cacheRead = 0
    var cacheWrite = 0
    var sessions = 0
    var firstSeen: Date?
    var lastSeen: Date?
    var dailyCost: [String: Double] = [:]
    var modelBreakdown: [String: Double] = [:]

    init(name: String, fullPath: String) {
        self.name = name
        self.fullPath = fullPath
    }

    init(restoring saved: HistoryProject, dir: String) {
        name = saved.name ?? dir
        fullPath = saved.fullPath ?? dir
        inputTokens = saved.inputTokens
        outputTokens = saved.outputTokens
        cacheRead = saved.cacheRead
        cacheWrite = saved.cacheWrite
        sessions = saved.sessionCount
        firstSeen = saved.firstSeen.flatMap(UsageStore.parseDate)
        lastSeen = saved.lastSeen.flatMap(UsageStore.parseDate)
        dailyCost = saved.dailyCost
        modelBreakdown = saved.modelBreakdown
    }

    func summary(id: String) -> ProjectSummary {
        ProjectSummary(id: id, name: name, cost: cost, firstSeen: firstSeen, lastSeen: lastSeen, totalTokens: inputTokens + outputTokens)
    }
}

/// On-disk history. Same layout as the former Electron app's usage-history.json,
/// which is where v2 files come from.
private struct History: Codable {
    var version = UsageStore.historyVersion
    var lastUpdated: String?
    var dailyUsage: [String: Double] = [:]
    var projects: [String: HistoryProject] = [:]
    var globalModelBreakdown: [String: Double] = [:]

    init() {}

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        version = try c.decode(Int.self, forKey: .version)
        lastUpdated = try? c.decodeIfPresent(String.self, forKey: .lastUpdated)
        dailyUsage = c.numberMap(.dailyUsage)
        projects = (try? c.decodeIfPresent([String: HistoryProject].self, forKey: .projects)) ?? [:]
        globalModelBreakdown = c.numberMap(.globalModelBreakdown)
    }
}

private struct HistoryProject: Codable {
    var name: String?
    var fullPath: String?
    var dailyCost: [String: Double] = [:]
    var modelBreakdown: [String: Double] = [:]
    var inputTokens = 0
    var outputTokens = 0
    var cacheRead = 0
    var cacheWrite = 0
    var sessionCount = 0
    var firstSeen: String?
    var lastSeen: String?

    init(_ project: Project) {
        name = project.name
        fullPath = project.fullPath
        dailyCost = project.dailyCost
        modelBreakdown = project.modelBreakdown
        inputTokens = project.inputTokens
        outputTokens = project.outputTokens
        cacheRead = project.cacheRead
        cacheWrite = project.cacheWrite
        sessionCount = project.sessions
        firstSeen = project.firstSeen.map(UsageStore.formatDate)
        lastSeen = project.lastSeen.map(UsageStore.formatDate)
    }

    // Lenient: a missing or malformed field falls back to its default, as the
    // JavaScript reader treated it.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try? c.decodeIfPresent(String.self, forKey: .name)
        fullPath = try? c.decodeIfPresent(String.self, forKey: .fullPath)
        dailyCost = c.numberMap(.dailyCost)
        modelBreakdown = c.numberMap(.modelBreakdown)
        inputTokens = c.integer(.inputTokens)
        outputTokens = c.integer(.outputTokens)
        cacheRead = c.integer(.cacheRead)
        cacheWrite = c.integer(.cacheWrite)
        sessionCount = c.integer(.sessionCount)
        firstSeen = try? c.decodeIfPresent(String.self, forKey: .firstSeen)
        lastSeen = try? c.decodeIfPresent(String.self, forKey: .lastSeen)
    }
}

private extension KeyedDecodingContainer {
    func numberMap(_ key: Key) -> [String: Double] {
        let map = (try? decodeIfPresent([String: Double?].self, forKey: key)) ?? nil
        return map?.compactMapValues { $0 } ?? [:]
    }

    func integer(_ key: Key) -> Int {
        if let value = try? decodeIfPresent(Int.self, forKey: key) { return value }
        if let value = try? decodeIfPresent(Double.self, forKey: key), value.isFinite { return Int(value) }
        return 0
    }
}
