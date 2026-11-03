import "../src/lib/config/load-env";
import { analyzeStoredAnnouncements } from "../src/lib/research/analyze";
import { createGeminiProvider } from "../src/lib/research/gemini";
import { parseResearchLimit, ResearchError } from "../src/lib/research/schema";
import { getDatabase, closeDatabase } from "../src/lib/db";

async function main() {
  try {
    const limit = parseResearchLimit(process.argv.slice(2));
    const provider = createGeminiProvider();
    const result = await analyzeStoredAnnouncements(getDatabase(), provider, limit);
    console.log(JSON.stringify({ event: "announcements_analyzed", provider: provider.name, model: provider.model, ...result }));
    if (result.failed) process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({ event: "announcement_analysis_failed", code: error instanceof ResearchError ? error.code : "research_storage_failed" }));
    process.exitCode = 1;
  } finally {
    await closeDatabase();
  }
}
void main();
