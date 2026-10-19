import SwiftUI

struct PopoverView: View {
    let model: AppModel
    @State private var showsErrors = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
            Divider()
            VStack(alignment: .leading, spacing: 16) {
                costs
                limits
                projectList("Recent Projects", model.usage?.recentProjects, date: \.lastSeen)
                projectList("Top Projects", model.usage?.topProjects, date: \.firstSeen)
            }
            .padding(16)
            if !model.errors.isEmpty {
                Divider()
                errorList
                    .padding(.horizontal, 16)
                    .padding(.vertical, 8)
            }
            Divider()
            footer
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
        }
        .frame(width: 320)
    }

    // ─── Header ─────────────────────────────────────────────────────────────────

    private var header: some View {
        HStack(spacing: 10) {
            Image(nsImage: NSApp.applicationIconImage)
                .resizable()
                .frame(width: 30, height: 30)
            VStack(alignment: .leading, spacing: 1) {
                HStack(alignment: .firstTextBaseline, spacing: 5) {
                    Text("Claude Code")
                        .font(.headline)
                    if !model.appVersion.isEmpty {
                        Text("v\(model.appVersion)")
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                    }
                }
                Text(model.plan.map { "\($0.capitalized) plan" } ?? "Usage monitor")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            StatusDot(status: model.rateLimits?.status)
                .frame(width: 8, height: 8)
        }
    }

    // ─── Costs ──────────────────────────────────────────────────────────────────

    private var costs: some View {
        HStack(spacing: 0) {
            costCell("Today", model.usage?.totals.todayCost, highlighted: true)
            Divider().frame(height: 28)
            costCell("Month", model.usage?.totals.monthCost)
            Divider().frame(height: 28)
            costCell("All Time", model.usage?.totals.cost)
        }
        .padding(.vertical, 10)
        .background(.fill.quaternary, in: .rect(cornerRadius: 8))
    }

    private func costCell(_ title: String, _ value: Double?, highlighted: Bool = false) -> some View {
        VStack(spacing: 2) {
            Text(title)
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(Format.cost(value))
                .font(.title3.weight(.semibold))
                .monospacedDigit()
                .foregroundStyle(highlighted ? Color.accentColor : Color.primary)
        }
        .frame(maxWidth: .infinity)
    }

    // ─── Usage limits ───────────────────────────────────────────────────────────

    private var limits: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    sectionTitle("Usage Limits")
                    Spacer()
                    let peak = PeakHours.status(at: context.date)
                    Text(peak.text)
                        .font(.caption2)
                        .foregroundStyle(peak.isActive ? Color.orange : Color.secondary)
                }
                limitsBody(now: context.date)
            }
        }
    }

    @ViewBuilder
    private func limitsBody(now: Date) -> some View {
        if !model.isConnected {
            if let connectError = model.connectError {
                message(Text(verbatim: connectError), isError: true)
            } else {
                message(Text("Not connected — click **Connect to Claude Code** to get started"))
            }
        } else if let rateLimitError = model.rateLimitError {
            message(Text(verbatim: rateLimitError), isError: true)
        } else if let limits = model.rateLimits {
            VStack(alignment: .leading, spacing: 6) {
                RateRow(
                    label: "5h", fraction: limits.fiveHourUtil, tokens: model.fiveHourTokens?.total,
                    reset: Format.countdown(to: limits.fiveHourReset, now: now)
                )
                RateRow(
                    label: "7d", fraction: limits.sevenDayUtil, tokens: model.sevenDayTokens?.total,
                    reset: Format.countdown(to: limits.sevenDayReset, now: now)
                )
                if limits.overageUtil != 0 {
                    HStack(spacing: 6) {
                        Text("OVERAGE")
                            .font(.system(size: 9, weight: .semibold))
                            .foregroundStyle(.orange)
                            .padding(.horizontal, 5)
                            .padding(.vertical, 1)
                            .background(.orange.opacity(0.15), in: .capsule)
                        Text("\(Format.percent(limits.overageUtil)) used")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
                HStack(spacing: 6) {
                    StatusDot(status: limits.status)
                        .frame(width: 6, height: 6)
                    Text("\(StatusDot.label(for: limits.status)) · \(Format.ago(limits.fetchedAt, now: now))")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                .padding(.top, 2)
            }
        } else {
            message(Text("Loading…"))
        }
    }

    // ─── Projects ───────────────────────────────────────────────────────────────

    private func projectList(_ title: String, _ projects: [ProjectSummary]?, date: KeyPath<ProjectSummary, Date?>) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            sectionTitle(title)
            if let projects, !projects.isEmpty {
                ForEach(projects) { project in
                    ProjectRow(project: project, date: project[keyPath: date] ?? project.lastSeen ?? project.firstSeen)
                }
            } else {
                message(Text(model.usage == nil ? "—" : "No projects found"))
            }
        }
    }

    // ─── Errors and footer ──────────────────────────────────────────────────────

    private var errorList: some View {
        DisclosureGroup(isExpanded: $showsErrors) {
            VStack(alignment: .leading, spacing: 4) {
                ForEach(model.errors, id: \.self) { error in
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, 4)
        } label: {
            Label(
                model.errors.count == 1 ? "1 issue detected" : "\(model.errors.count) issues detected",
                systemImage: "exclamationmark.triangle.fill"
            )
            .font(.caption.weight(.medium))
            .foregroundStyle(.red)
        }
    }

    private var footer: some View {
        HStack(spacing: 8) {
            Button {
                Task { await model.refresh() }
            } label: {
                Label("Refresh", systemImage: "arrow.clockwise")
            }
            .keyboardShortcut("r")
            .disabled(model.isRefreshing)
            if model.isRefreshing {
                ProgressView()
                    .controlSize(.small)
            }
            Spacer()
            Button(model.isConnected ? "Disconnect" : "Connect to Claude Code") {
                Task {
                    if model.isConnected {
                        await model.disconnect()
                    } else {
                        await model.connect()
                    }
                }
            }
            Button("Quit") {
                NSApp.terminate(nil)
            }
            .keyboardShortcut("q")
        }
    }

    // ─── Pieces ─────────────────────────────────────────────────────────────────

    private func sectionTitle(_ title: String) -> some View {
        Text(title)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(.secondary)
    }

    private func message(_ text: Text, isError: Bool = false) -> some View {
        text
            .font(.caption)
            .foregroundStyle(isError ? Color.red : Color.secondary)
            .fixedSize(horizontal: false, vertical: true)
    }
}

private struct RateRow: View {
    let label: String
    let fraction: Double
    let tokens: Int?
    let reset: String?

    var body: some View {
        // Utilisation can exceed 1.0 (overage) or be NaN from a garbage header.
        let clamped = fraction.isFinite ? min(1, max(0, fraction)) : 0
        HStack(spacing: 8) {
            Text(label)
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
                .frame(width: 18, alignment: .leading)
            ProgressView(value: clamped)
                .progressViewStyle(.linear)
                .controlSize(.small)
                .tint(clamped < 0.5 ? .green : clamped < 0.8 ? .orange : .red)
            Text(Format.percent(fraction))
                .font(.caption)
                .monospacedDigit()
                .frame(width: 40, alignment: .trailing)
            Text(Format.tokens(tokens) ?? "")
                .font(.caption2)
                .monospacedDigit()
                .foregroundStyle(.tertiary)
                .frame(width: 32, alignment: .trailing)
                .help("Tokens used in this window (local count)")
            HStack(spacing: 2) {
                if let reset {
                    Image(systemName: "arrow.clockwise")
                        .imageScale(.small)
                    Text(reset)
                        .monospacedDigit()
                }
            }
            .font(.caption2)
            .foregroundStyle(.secondary)
            .frame(width: 52, alignment: .trailing)
        }
    }
}

private struct ProjectRow: View {
    let project: ProjectSummary
    let date: Date?

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "diamond.fill")
                .font(.system(size: 6))
                .foregroundStyle(.tint)
            Text(project.name)
                .font(.callout)
                .lineLimit(1)
                .truncationMode(.tail)
            Spacer(minLength: 4)
            if let tokens = Format.tokens(project.totalTokens) {
                Text(tokens)
                    .font(.caption2)
                    .monospacedDigit()
                    .foregroundStyle(.tertiary)
            }
            if let date = Format.shortDate(date) {
                Text(date)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            Text(Format.cost(project.cost))
                .font(.caption.weight(.medium))
                .monospacedDigit()
                .frame(minWidth: 42, alignment: .trailing)
        }
    }
}

private struct StatusDot: View {
    let status: String?

    var body: some View {
        Circle()
            .fill(color)
            .accessibilityLabel(status.map(Self.label(for:)) ?? "No data")
    }

    private var color: Color {
        switch status {
        case nil: .gray
        case "allowed_warning": .yellow
        case "rejected": .red
        default: .green
        }
    }

    static func label(for status: String) -> String {
        switch status {
        case "allowed": "Within limits"
        case "allowed_warning": "Approaching limit"
        case "rejected": "Rate limited"
        default: status
        }
    }
}
