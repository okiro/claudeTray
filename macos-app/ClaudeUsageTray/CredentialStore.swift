import Foundation
import OSLog

struct Credentials: Sendable {
    let accessToken: String
    let expiresAt: Date
    let subscriptionType: String?
}

enum AuthError: LocalizedError {
    case credentialsNotFound

    var errorDescription: String? {
        "Could not find Claude Code credentials in keychain — make sure Claude Code is logged in"
    }
}

/// Provides Claude Code's OAuth token, read from Claude Code's own keychain entry.
///
/// The token is never refreshed here: an expired one is re-imported, so Claude Code
/// remains the single owner of the token lifecycle. It is held in memory only; the
/// one thing persisted is whether the user chose to connect.
actor CredentialStore {
    private static let connectedKey = "connected"
    private static let log = Logger(subsystem: "com.claude.usage-tray", category: "auth")

    private var cached: Credentials?

    init() {
        // First launch after the Electron build: stay connected if it was.
        let defaults = UserDefaults.standard
        if defaults.object(forKey: Self.connectedKey) == nil {
            let wasConnected = FileManager.default.fileExists(atPath: Paths.legacyAuthFile.path(percentEncoded: false))
            defaults.set(wasConnected, forKey: Self.connectedKey)
        }
    }

    nonisolated var isConnected: Bool {
        UserDefaults.standard.bool(forKey: Self.connectedKey)
    }

    var current: Credentials? { cached }

    func clear() {
        cached = nil
        UserDefaults.standard.set(false, forKey: Self.connectedKey)
    }

    func importFromKeychain() async -> Bool {
        // Try the user-account entry first (active Claude Code), fall back to generic.
        var raw = await ClaudeKeychain.read(account: NSUserName())
        if raw == nil {
            raw = await ClaudeKeychain.read(account: "Claude Code")
        }
        guard let data = raw?.data(using: .utf8),
              let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let oauth = root["claudeAiOauth"] as? [String: Any],
              let token = oauth["accessToken"] as? String, !token.isEmpty
        else { return false }

        let expiresAtMs = (oauth["expiresAt"] as? NSNumber)?.doubleValue ?? 0
        cached = Credentials(
            accessToken: token,
            expiresAt: Date(timeIntervalSince1970: expiresAtMs / 1000),
            subscriptionType: oauth["subscriptionType"] as? String
        )
        UserDefaults.standard.set(true, forKey: Self.connectedKey)
        return true
    }

    func validAccessToken() async -> String? {
        guard isConnected else { return nil }
        // Still valid with a 5-minute buffer — use it.
        if let cached, cached.expiresAt > Date().addingTimeInterval(300) {
            return cached.accessToken
        }
        Self.log.info("Token expired or not loaded, importing from keychain")
        cached = nil
        guard await importFromKeychain() else {
            Self.log.error("Keychain import failed")
            return nil
        }
        return cached?.accessToken
    }

    func login() async throws -> Credentials {
        clear()
        guard await importFromKeychain(), let cached else {
            throw AuthError.credentialsNotFound
        }
        return cached
    }
}

/// Reads through the `security` tool rather than SecItem: Claude Code's item trusts
/// that tool, so the read does not raise a keychain access prompt for this app.
enum ClaudeKeychain {
    static func read(account: String) async -> String? {
        await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .utility).async {
                continuation.resume(returning: run(account: account))
            }
        }
    }

    private static func run(account: String) -> String? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/security")
        process.arguments = ["find-generic-password", "-s", "Claude Code-credentials", "-a", account, "-w"]
        let stdout = Pipe()
        process.standardOutput = stdout
        process.standardError = FileHandle.nullDevice
        let exited = DispatchSemaphore(value: 0)
        process.terminationHandler = { _ in exited.signal() }

        do {
            try process.run()
        } catch {
            return nil
        }
        // An unanswered keychain prompt must not stall refreshes indefinitely.
        guard exited.wait(timeout: .now() + 5) == .success else {
            process.terminate()
            return nil
        }
        guard process.terminationStatus == 0 else { return nil }
        let data = stdout.fileHandleForReading.readDataToEndOfFile()
        return String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
