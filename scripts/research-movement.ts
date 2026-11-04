import "../src/lib/config/load-env";
import { researchMovement } from "../src/lib/research/movement";
import { createResearchProvider } from "../src/lib/research/provider";
import { ResearchError } from "../src/lib/research/schema";
import { getDatabase, closeDatabase } from "../src/lib/db";

async function main() {
  try {
    const [signalId, option, ...extra] = process.argv.slice(2);
    if (!signalId || extra.length || (option !== undefined && option !== "--analyze")) throw new ResearchError("invalid_arguments");
    const provider = option === "--analyze" ? createResearchProvider() : undefined;
    console.log(JSON.stringify({ event: "movement_researched", ...await researchMovement(getDatabase(), signalId, provider) }));
  } catch (error) {
    console.error(JSON.stringify({ event: "movement_research_failed", code: error instanceof ResearchError ? error.code : "MOVEMENT_RESEARCH_UNAVAILABLE", httpStatus: error instanceof ResearchError ? error.httpStatus : undefined }));
    process.exitCode = 1;
  } finally { await closeDatabase(); }
}
void main();
