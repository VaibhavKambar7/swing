import { describe, expect, it, vi } from "vitest";
import { createResearchProvider, withFallback } from "../src/lib/research/provider";
import { ResearchError, type ResearchInput, type ResearchProvider } from "../src/lib/research/schema";
const input: ResearchInput = { stock: { exchange: "NSE", symbol: "TEST", name: "Synthetic" }, announcement: { title: "Synthetic", description: null, url: "https://example.com", publishedAt: null, discoveredAt: "2026-11-04T00:00:00Z" }, relevance: { status: "review", reason: null, ruleVersion: "test" }, contentTruncated: false };
const assessment = { classification: "WATCH" as const, summary: "Unverified announcement", significance: "Review source", risks: ["Unknown details"], uncertainties: ["Source not verified"], evidenceIds: ["announcement"] };
const env = { RESEARCH_PROVIDER: "groq", RESEARCH_FALLBACK_PROVIDER: "gemini", GROQ_API_KEY: "synthetic-secret", GEMINI_API_KEY: "synthetic-secret" };
describe("Groq primary and Gemini fallback", () => {
  it("calls Groq first, validates output, and records actual provider/model", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(assessment) } }], usage: { prompt_tokens: 12, completion_tokens: 34 } })));
    const result = await createResearchProvider(env, fetcher).analyze(input);
    expect(result).toMatchObject({ provider: "groq", model: "llama-3.3-70b-versatile", inputTokens: 12, outputTokens: 34 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe("https://api.groq.com/openai/v1/chat/completions");
  });
  it("falls back after provider failure without mislabelling Gemini output", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response("rate limit", { status: 429 })).mockResolvedValueOnce(new Response(JSON.stringify({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(assessment) }] } }] })));
    const result = await createResearchProvider(env, fetcher).analyze(input);
    expect(result.provider).toBe("gemini"); expect(result.model).toBe("gemini-2.5-flash");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("never starts fallback after cancellation", async () => {
    const controller = new AbortController();
    const primary: ResearchProvider = { name: "groq", model: "test", analyze: async () => { controller.abort(); throw new ResearchError("provider_network_error"); } };
    const analyze = vi.fn<ResearchProvider["analyze"]>();
    await expect(withFallback(primary, { name: "gemini", model: "test", analyze }).analyze(input, controller.signal)).rejects.toThrow();
    expect(analyze).not.toHaveBeenCalled();
  });
  it("rejects malformed model responses instead of accepting invented evidence", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ ...assessment, evidenceIds: ["invented"] }) } }] })));
    await expect(createResearchProvider({ ...env, RESEARCH_FALLBACK_PROVIDER: "none" }, fetcher).analyze(input)).rejects.toMatchObject({ code: "invalid_research_output" });
  });
});
