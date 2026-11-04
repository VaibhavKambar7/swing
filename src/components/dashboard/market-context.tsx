import { Panel, Note } from "./components";
function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
export function MarketContextView({ value }: { value: unknown }) {
  const context = object(value);
  return <Panel title="Market comparisons" subtitle="Context saved when this movement was detected">{[ ["benchmark", "Benchmark"], ["sector", "Sector index"], ["usualVolatility", "Usual five-minute volatility"], ["relativeVolume", "Relative volume"] ].map(([key, label]) => {
    const row = object(context[key]);
    return <article key={key}><h3>{label}</h3>{row.status === "observed" ? <p>{typeof row.symbol === "string" ? row.symbol : "Historical intraday sample"} · {typeof row.changePct === "string" ? `${row.changePct}% index change` : `${row.sampleCount} pairs across ${row.sessions} sessions`}<br />{typeof row.excessChangePercentagePoints === "string" ? `${row.excessChangePercentagePoints} percentage points stock minus index` : typeof row.standardDeviationsFromMean === "string" ? `${row.standardDeviationsFromMean} standard deviations from prior mean` : ""}</p> : <p>Unavailable · {typeof row.reason === "string" ? row.reason.replaceAll("_", " ") : "Not captured in this detector version"}</p>}</article>;
  })}<Note>Unverified provider-native changes. Missing indexes, aligned quotes or sufficient prior intraday history remain unavailable. These comparisons are not verified investment returns.</Note></Panel>;
}
