"use client";
import { useState } from "react";
import { submitJob } from "@/app/(workspace)/system/controls/actions";
import { SubmitButton } from "./submit-button";
const operations = [
  ["announcements.pipeline", "Collect, match and filter all enabled sources"],
  ["sources.collect", "Collect and process one source"],
  ["announcements.fetch", "Collect NSE announcements"],
  ["announcements.match", "Retry unmatched issuer matching"],
  ["announcements.filter", "Filter stored announcements"],
  ["announcements.analyze", "Research eligible announcements with AI"],
  ["prices.collect", "Collect one stock or index price"],
  ["movements.research", "Link movement evidence / optional AI research"],
  ["briefings.morning", "Generate morning briefing"],
  ["briefings.closing", "Generate preliminary closing summary"],
  ["briefings.reassess", "Reassess the morning watchlist"],
  ["research.followups", "Update observational research follow-ups"],
  ["database.check", "Check database connectivity"],
];
export function OperationForm({ requestId, date, stocks, sources, movements }: {
  requestId: string; date: string; stocks: { symbol: string; name: string }[];
  sources: { id: string; name: string }[]; movements: { id: string; label: string }[];
}) {
  const [kind, setKind] = useState("announcements.pipeline");
  const optionalAI = ["announcements.pipeline", "movements.research"].includes(kind);
  return <form action={submitJob}><input type="hidden" name="requestId" value={requestId} />
    <label>Operation <select name="kind" value={kind} onChange={(e) => setKind(e.target.value)}>{operations.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
    {kind === "prices.collect" && <><label>Instrument <select name="symbol" required><option value="">Choose an instrument</option>{stocks.map((s) => <option key={s.symbol} value={s.symbol}>{s.symbol} · {s.name}</option>)}</select></label><label>History in calendar days <input name="days" type="number" min={1} max={365} defaultValue={7} required /></label></>}
    {kind === "sources.collect" && <label>Enabled source <select name="sourceId" required><option value="">Choose a source</option>{sources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>}
    {kind === "movements.research" && <label>Movement <select name="signalId" required><option value="">Choose a stored movement</option>{movements.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</select></label>}
    {kind.startsWith("briefings.") && <label>Trading date (IST) <input type="date" name="sessionDate" defaultValue={date} required /></label>}
    {optionalAI && <label><input type="checkbox" name="analyze" value="yes" /> Also run AI research (uses your configured provider quota)</label>}
    {["announcements.analyze", "announcements.pipeline", "research.followups"].includes(kind) && <label>Maximum items this run <input type="number" name="limit" min={1} max={kind === "research.followups" ? 100 : 20} defaultValue={1} required /></label>}
    <p>Collection uses configured providers; it does not place trades. Reports and follow-ups use stored data. Historical report generation retains cutoffs and labels late generation. Post-open reassessment requires its current observation window.</p>
    <label><input type="checkbox" name="confirm" value="yes" required /> Queue this operation. AI research, when selected, can consume quota.</label><SubmitButton>Queue operation</SubmitButton>
  </form>;
}
