import Foundation

struct ModelPricing: Sendable {
    let input: Double
    let output: Double
    let cacheRead: Double
    let cacheWrite: Double
}

/// Prices per million tokens; cache writes are the 5-minute rate. Update manually
/// when new Claude models launch.
enum Pricing {
    private static let fable = ModelPricing(input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5)
    private static let fable51 = ModelPricing(input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5)
    private static let opus55 = ModelPricing(input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5)
    private static let opus = ModelPricing(input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25)
    private static let sonnet5 = ModelPricing(input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5)
    private static let sonnet4 = ModelPricing(input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75)
    private static let haiku55 = ModelPricing(input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125)
    private static let haiku55LongPrompt = ModelPricing(input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625)
    private static let haiku = ModelPricing(input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25)
    private static let haiku35 = ModelPricing(input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1)
    private static let unbilled = ModelPricing(input: 0, output: 0, cacheRead: 0, cacheWrite: 0)

    static let fallback = sonnet4

    static let table: [String: ModelPricing] = [
        // Claude Fable / Mythos
        "claude-fable-5-1": fable51,
        "claude-mythos-5-1": fable51,
        "claude-fable-5": fable,
        "claude-mythos-5": fable,
        // Claude Opus
        "claude-opus-5-5": opus55,
        "claude-opus-5": opus,
        "claude-opus-4-8": opus,
        "claude-opus-4-7": opus,
        "claude-opus-4-6": opus,
        "claude-opus-4-5": opus,
        // Claude Sonnet
        "claude-sonnet-5-5": sonnet5,
        "claude-sonnet-5": sonnet5,
        "claude-sonnet-4-6": sonnet4,
        "claude-sonnet-4-5": sonnet4,
        "claude-sonnet-4-0": sonnet4,
        // Claude 3.5
        "claude-3-5-sonnet-20241022": sonnet4,
        "claude-3-5-sonnet-20240620": sonnet4,
        "claude-3-5-haiku-20241022": haiku35,
        // Claude Haiku
        "claude-haiku-5-5": haiku55,
        "claude-haiku-4-5": haiku,
        // Bare aliases that appear in some JSONL entries
        "opus": opus,
        "fable": fable,
        "sonnet": sonnet5,
        "haiku": haiku,
        // Locally-generated messages are never billed
        "<synthetic>": unbilled,
    ]

    /// Models billed at a higher rate when the whole prompt (input, cache reads and
    /// cache writes) exceeds the threshold in tokens.
    private static let longPromptTable: [String: (threshold: Int, pricing: ModelPricing)] = [
        "claude-haiku-5-5": (100_000, haiku55LongPrompt),
    ]

    /// Models that history v2 billed at `fallback` because the table above lacked them.
    private static let addedInHistoryV3: Set<String> = [
        "claude-fable-5-1", "claude-mythos-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5",
    ]

    static func cost(model: String, input: Int, output: Int, cacheRead: Int, cacheWrite: Int) -> Double {
        let key = table[model] != nil ? model : strippingDateSuffix(model)
        var p = table[key] ?? fallback
        if let long = longPromptTable[key], input + cacheRead + cacheWrite > long.threshold {
            p = long.pricing
        }
        return cost(p, input: input, output: output, cacheRead: cacheRead, cacheWrite: cacheWrite)
    }

    /// What a history v2 run recorded for this usage: the fallback rate for models
    /// it did not price yet.
    static func historyV2Cost(model: String, input: Int, output: Int, cacheRead: Int, cacheWrite: Int) -> Double {
        let key = table[model] != nil ? model : strippingDateSuffix(model)
        guard addedInHistoryV3.contains(key) else {
            return cost(model: model, input: input, output: output, cacheRead: cacheRead, cacheWrite: cacheWrite)
        }
        return cost(fallback, input: input, output: output, cacheRead: cacheRead, cacheWrite: cacheWrite)
    }

    private static func cost(_ p: ModelPricing, input: Int, output: Int, cacheRead: Int, cacheWrite: Int) -> Double {
        // input_tokens already EXCLUDES cache reads/writes — do not subtract them.
        (Double(input) * p.input
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
