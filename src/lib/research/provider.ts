import { createGroqProvider } from "./groq";
import { createGeminiProvider } from "./gemini";
import { ResearchError, type ResearchProvider } from "./schema";
export function withFallback(primary: ResearchProvider, fallback?: ResearchProvider): ResearchProvider {
  return { name: primary.name, model: primary.model, identities: [primary, ...(fallback ? [fallback] : [])].map(({ name, model }) => ({ name, model })), async analyze(input, signal) {
    signal?.throwIfAborted();
    try { return { ...await primary.analyze(input, signal), provider: primary.name, model: primary.model }; }
    catch (error) {
      signal?.throwIfAborted();
      if (!fallback || !(error instanceof ResearchError)) throw error;
      return { ...await fallback.analyze(input, signal), provider: fallback.name, model: fallback.model };
    }
  } };
}
export function createResearchProvider(env: Record<string, string | undefined> = process.env, fetcher: typeof fetch = fetch): ResearchProvider {
  const primary = env.RESEARCH_PROVIDER ?? "gemini";
  const fallback = env.RESEARCH_FALLBACK_PROVIDER ?? "none";
  const create = (name: string) => name === "groq" ? createGroqProvider(env, fetcher) : name === "gemini" ? createGeminiProvider(env, fetcher) : (() => { throw new ResearchError("invalid_research_provider"); })();
  if (primary === fallback) throw new ResearchError("invalid_fallback_provider");
  return withFallback(create(primary), fallback === "none" ? undefined : create(fallback));
}
