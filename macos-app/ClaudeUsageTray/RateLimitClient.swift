import Foundation

enum RateLimitResult: Sendable {
    case limits(RateLimits)
    case unauthorized
    case failure(String)
}

/// Reads utilisation from the `anthropic-ratelimit-unified-*` headers of a minimal
/// one-token request; the API has no endpoint that reports them directly.
enum RateLimitClient {
    private static let endpoint = URL(string: "https://api.anthropic.com/v1/messages")!
    private static let session = URLSession(configuration: .ephemeral)
    private static let body = Data(#"{"model":"claude-haiku-4-5-20251001","max_tokens":1,"messages":[{"role":"user","content":"hi"}]}"#.utf8)

    static func fetch(accessToken: String) async -> RateLimitResult {
        var request = URLRequest(url: endpoint, timeoutInterval: 10)
        request.httpMethod = "POST"
        request.httpBody = body
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "authorization")
        request.setValue("2023-06-01", forHTTPHeaderField: "anthropic-version")
        request.setValue("oauth-2025-04-20", forHTTPHeaderField: "anthropic-beta")

        let response: HTTPURLResponse
        do {
            let (_, urlResponse) = try await session.data(for: request)
            guard let http = urlResponse as? HTTPURLResponse else { return .failure("Unexpected response") }
            response = http
        } catch {
            return .failure(error.localizedDescription)
        }

        if response.statusCode == 401 { return .unauthorized }

        // Any non-2xx other than 429 carries no rate-limit headers. Reading it anyway
        // would publish a fabricated "0% used" and clear the error during an outage.
        if response.statusCode != 429 && !(200..<300).contains(response.statusCode) {
            return .failure("API error \(response.statusCode)")
        }

        func header(_ name: String) -> String? {
            response.value(forHTTPHeaderField: "anthropic-ratelimit-unified-\(name)")
        }

        // A 429 does carry the headers, but a response missing them entirely is not
        // something we can render as utilisation.
        if header("5h-utilization") == nil && header("status") == nil {
            return .failure("Rate limit headers missing from API response")
        }

        return .limits(RateLimits(
            status: header("status").flatMap { $0.isEmpty ? nil : $0 } ?? "unknown",
            fiveHourUtil: number(header("5h-utilization")) ?? 0,
            fiveHourReset: number(header("5h-reset")),
            sevenDayUtil: number(header("7d-utilization")) ?? 0,
            sevenDayReset: number(header("7d-reset")),
            overageUtil: number(header("overage-utilization")) ?? 0,
            fetchedAt: Date()
        ))
    }

    private static func number(_ value: String?) -> Double? {
        value.flatMap { Double($0.trimmingCharacters(in: .whitespaces)) }
    }
}
