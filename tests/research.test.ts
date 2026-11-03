import { describe, expect, it, vi } from "vitest";
import { createGeminiProvider } from "../src/lib/research/gemini";
import { buildResearchInput } from "../src/lib/research/analyze";
import { parseResearchLimit, researchSchema, type ResearchInput } from "../src/lib/research/schema";

const input: ResearchInput = {
  stock: { exchange: "NSE", symbol: "EXAMPLE", name: "Example Limited" },
  announcement: { title: "Example - Results", description: "Results announced", url: "https://example.com/results", publishedAt: null, discoveredAt: "2026-11-03T03:15:00.000Z" },
  relevance: { status: "keep", reason: "POTENTIALLY_MATERIAL_CONTEXT", ruleVersion: "test" }, contentTruncated: false,
};
const assessment = {
  classification: "INVESTIGATE", summary: "The issuer announced results.",
  significance: "Read the filing to understand performance.",
  risks: ["The title does not establish earnings quality."],
  uncertainties: ["Full filing, current valuation, and publication date are unavailable."], evidenceIds: ["announcement"],
};
function response(output: unknown = assessment, finishReason = "STOP") {
  return new Response(JSON.stringify({ candidates: [{ finishReason, content: { parts: [{ text: JSON.stringify(output) }] } }], usageMetadata: { promptTokenCount: 125, candidatesTokenCount: 80 } }));
}

describe("structured announcement research", () => {
  it("requires a configured key without exposing credentials", () => {
    expect(() => createGeminiProvider({})).toThrow("missing_gemini_api_key");
    expect(() => createGeminiProvider({ GEMINI_API_KEY: "secret", GEMINI_MODEL: "../invalid" })).toThrow("invalid_gemini_model");
  });
  it("sends evidence as untrusted data and validates Gemini JSON and token usage", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response());
    const provider = createGeminiProvider({ GEMINI_API_KEY: "secret" }, fetcher);
    expect(await provider.analyze(input)).toEqual({ assessment, inputTokens: 125, outputTokens: 80 });
    const [url, options] = fetcher.mock.calls[0];
    expect(String(url)).not.toContain("secret");
    expect(options?.headers).toMatchObject({ "x-goog-api-key": "secret" });
    const request = JSON.parse(String(options?.body));
    expect(request.systemInstruction.parts[0].text).toContain("untrusted source");
    expect(request.generationConfig.responseMimeType).toBe("application/json");
    expect(JSON.parse(request.contents[0].parts[0].text)).toEqual(input);
  });
  it.each([
    { ...assessment, classification: "BUY" },
    { ...assessment, evidenceIds: ["made-up-source"] },
    { ...assessment, risks: [] }, { ...assessment, uncertainties: [] },
    { ...assessment, targetPrice: 100 }, { ...assessment, summary: "" },
  ])("rejects unsupported classifications, fabricated citations, and malformed output", async (output) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(output));
    await expect(createGeminiProvider({ GEMINI_API_KEY: "secret" }, fetcher).analyze(input)).rejects.toMatchObject({ code: "invalid_research_output" });
  });
  it("rejects truncated or blocked generations", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(assessment, "MAX_TOKENS"));
    await expect(createGeminiProvider({ GEMINI_API_KEY: "secret" }, fetcher).analyze(input)).rejects.toMatchObject({ code: "incomplete_provider_response" });
  });
  it("sanitizes HTTP and network failures and rejects invalid JSON", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("secret error", { status: 429 }));
    const provider = createGeminiProvider({ GEMINI_API_KEY: "secret" }, fetcher);
    await expect(provider.analyze(input)).rejects.toMatchObject({ code: "provider_http_error", httpStatus: 429 });
    fetcher.mockRejectedValue(new Error("credential=secret"));
    await expect(provider.analyze(input)).rejects.toThrow("provider_network_error");
    fetcher.mockResolvedValue(new Response("not JSON secret"));
    await expect(provider.analyze(input)).rejects.toMatchObject({ code: "invalid_provider_json" });
  });
  it("flags bounded input and preserves unknown timestamps without inventing facts", () => {
    const result = buildResearchInput({
      ...input.announcement, title: "x".repeat(2001), description: "y".repeat(20001),
      publishedAt: null, discoveredAt: new Date(input.announcement.discoveredAt),
      relevanceStatus: "review", relevanceReason: "CONTENT_TOO_LARGE_FOR_RULES", relevanceRuleVersion: "v1", instrument: input.stock,
    });
    expect(result.contentTruncated).toBe(true);
    expect(result.announcement.title).toHaveLength(2000);
    expect(result.announcement.description).toHaveLength(20000);
    expect(result.announcement.publishedAt).toBeNull();
    expect(researchSchema.safeParse(assessment).success).toBe(true);
  });
  it("limits manual API batches", () => {
    expect(parseResearchLimit([])).toBe(5);
    expect(parseResearchLimit(["--limit", "20"])).toBe(20);
    for (const args of [["--limit", "0"], ["--limit", "21"], ["--limit", "2.5"], ["--all"], ["--limit"]]) {
      expect(() => parseResearchLimit(args)).toThrow("invalid_arguments");
    }
  });
});
