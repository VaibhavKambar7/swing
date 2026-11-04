import { z } from "zod";
import { systemInstruction } from "./gemini";
import { ResearchError, researchSchemaFor, type ResearchProvider } from "./schema";
export function createGroqProvider(env: Record<string, string | undefined> = process.env, fetcher: typeof fetch = fetch): ResearchProvider {
  const key = env.GROQ_API_KEY?.trim();
  if (!key) throw new ResearchError("missing_groq_api_key");
  const model = env.GROQ_MODEL ?? "llama-3.3-70b-versatile";
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,150}$/.test(model)) throw new ResearchError("invalid_groq_model");
  return { name: "groq", model, async analyze(input, signal) {
    const ids = "movement" in input ? input.evidence.map((e) => e.id) : ["announcement"];
    const schema = researchSchemaFor(ids, "movement" in input ? "movement" : undefined);
    try {
      signal?.throwIfAborted();
      const response = await fetcher("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST", redirect: "error", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000),
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, temperature: 0.1, max_completion_tokens: 4096, response_format: { type: "json_object" }, messages: [
          { role: "system", content: `${systemInstruction}\nReturn one JSON object with exactly classification (INVESTIGATE/WATCH/IGNORE), summary, significance, risks (1–6 strings), uncertainties (1–6 strings), evidenceIds (1–6 unique IDs). Allowed evidence IDs: ${JSON.stringify(ids)}.` },
          { role: "user", content: JSON.stringify(input) },
        ] }),
      });
      if (!response.ok) { await response.body?.cancel(); throw new ResearchError("provider_http_error", response.status); }
      const reader = response.body?.getReader(); if (!reader) throw new ResearchError("invalid_provider_response");
      const chunks: Uint8Array[] = []; let bytes = 0;
      try { while (true) { const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength; if (bytes > 256 * 1024) throw new ResearchError("provider_response_too_large"); chunks.push(part.value); } } finally { await reader.cancel().catch(() => undefined); }
      const parsed = z.object({ choices: z.array(z.object({ finish_reason: z.literal("stop"), message: z.object({ content: z.string() }) })).length(1), usage: z.object({ prompt_tokens: z.number().int().nonnegative().max(2147483647).optional(), completion_tokens: z.number().int().nonnegative().max(2147483647).optional() }).optional() }).safeParse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      if (!parsed.success) throw new ResearchError("invalid_provider_response");
      const result = schema.safeParse(JSON.parse(parsed.data.choices[0].message.content));
      if (!result.success) throw new ResearchError("invalid_research_output");
      return { assessment: result.data, inputTokens: parsed.data.usage?.prompt_tokens ?? null, outputTokens: parsed.data.usage?.completion_tokens ?? null };
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof ResearchError) throw error;
      throw new ResearchError(error instanceof SyntaxError ? "invalid_provider_json" : "provider_network_error");
    }
  } };
}
