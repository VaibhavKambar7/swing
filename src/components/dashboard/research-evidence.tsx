import { safeSourceUrl } from "@/lib/dashboard/queries";
export function ResearchEvidence({ value }: { value: unknown }) {
  if (!Array.isArray(value)) return null;
  const evidence = value.filter((v): v is Record<string, unknown> => Boolean(v && typeof v === "object" && !Array.isArray(v)));
  return <details><summary>Evidence retained with this assessment</summary>{evidence.map((entry, index) => {
    const url = safeSourceUrl(entry.url);
    return <p key={index}>{typeof entry.title === "string" ? entry.title : "Stored evidence"}{url && <> · <a href={url} rel="noopener noreferrer" target="_blank">Original source ↗</a></>}<br />{typeof entry.kind === "string" ? entry.kind.replaceAll("_", " ") : typeof entry.source === "string" ? entry.source : ""}{typeof entry.timing === "string" ? ` · ${entry.timing.replaceAll("_", " ")}` : ""}{entry.knownAtMove === false ? " · Not known to this system at the movement" : ""}</p>;
  })}</details>;
}
