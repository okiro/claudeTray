import Foundation

struct ModelPricing: Sendable {
    let input: Double
    let output: Double
    let cacheRead: Double
    let cacheWrite: Double
}

/// Prices per million tokens. Update manually when new Claude models launch.
enum Pricing {
    private static let fable = ModelPricing(input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5)
    private static let opus = ModelPricing(input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25)
    private static let sonnet5 = ModelPricing(input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5)
    private static let sonnet4 = ModelPricing(input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75)
    private static let haiku = ModelPricing(input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25)
    private static let haiku35 = ModelPricing(input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1)
    private static let unbilled = ModelPricing(input: 0, output: 0, cacheRead: 0, cacheWrite: 0)

    static let fallback = sonnet4

    static let table: [String: ModelPricing] = [
        // Claude Fable / Mythos
        "claude-fable-5": fable,
        "claude-mythos-5": fable,
        // Claude Opus
        "claude-opus-5": opus,
        "claude-opus-4-8": opus,
        "claude-opus-4-7": opus,
        "claude-opus-4-6": opus,
        "claude-opus-4-5": opus,
        // Claude Sonnet
        "claude-sonnet-5": sonnet5,
        "claude-sonnet-4-6": sonnet4,
        "claude-sonnet-4-5": sonnet4,
        "claude-sonnet-4-0": sonnet4,
        // Claude 3.5
        "claude-3-5-sonnet-20241022": sonnet4,
        "claude-3-5-sonnet-20240620": sonnet4,
        "claude-3-5-haiku-20241022": haiku35,
        // Claude Haiku
        "claude-haiku-4-5": haiku,
        // Bare aliases that appear in some JSONL entries
        "opus": opus,
        "fable": fable,
        "sonnet": sonnet5,
        "haiku": haiku,
        // Locally-generated messages are never billed
        "<synthetic>": unbilled,
    ]

    static func cost(model: String, input: Int, output: Int, cacheRead: Int, cacheWrite: Int) -> Double {
        let p = table[model] ?? table[strippingDateSuffix(model)] ?? fallback
        // input_tokens already EXCLUDES cache reads/writes — do not subtract them.
        return (Double(input) * p.input
            + Double(cacheRead) * p.cacheRead
            + Double(cacheWrite) * p.cacheWrite
            + Double(output) * p.output) / 1_000_000
    }

    /// "claude-sonnet-4-5-20250929" → "claude-sonnet-4-5"
    private static func strippingDateSuffix(_ model: String) -> String {
        let suffix = model.utf8.suffix(9)
        guard suffix.count == 9, suffix.first == UInt8(ascii: "-"),
              suffix.dropFirst().allSatisfy({ (UInt8(ascii: "0")...UInt8(ascii: "9")).contains($0) })
        else { return model }
        return String(model.dropLast(9))
    }
}
