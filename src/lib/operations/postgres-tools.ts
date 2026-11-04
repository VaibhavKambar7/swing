import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

export class BackupError extends Error {
  constructor(public readonly code: string) { super(code); }
}
export function postgresConnection(value: string | undefined) {
  const url = value ? URL.parse(value) : null;
  if (!url || !["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || url.hash) throw new BackupError("INVALID_DATABASE_CONNECTION");
  let database: string, username: string, password: string;
  try { database = decodeURIComponent(url.pathname.slice(1)); username = decodeURIComponent(url.username); password = decodeURIComponent(url.password); }
  catch { throw new BackupError("INVALID_DATABASE_CONNECTION"); }
  if (!/^[A-Za-z0-9_.-]{1,63}$/.test(database)) throw new BackupError("UNSUPPORTED_DATABASE_NAME");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const port = url.port || "5432";
  // Never place the credential-bearing URL on a subprocess command line.
  const env: NodeJS.ProcessEnv = { ...process.env, PGHOSTADDR: undefined, PGSERVICE: undefined, PGSERVICEFILE: undefined, PGHOST: host, PGPORT: port, PGDATABASE: database, PGUSER: username || undefined, PGPASSWORD: password || undefined, PGCONNECT_TIMEOUT: "15" };
  const libpqOptions: Record<string, string> = {
    sslmode: "PGSSLMODE", sslrootcert: "PGSSLROOTCERT", sslcert: "PGSSLCERT", sslkey: "PGSSLKEY", sslpassword: "PGSSLPASSWORD",
    channel_binding: "PGCHANNELBINDING", connect_timeout: "PGCONNECT_TIMEOUT", application_name: "PGAPPNAME", options: "PGOPTIONS",
    ssl_min_protocol_version: "PGSSLMINPROTOCOLVERSION", ssl_max_protocol_version: "PGSSLMAXPROTOCOLVERSION",
  };
  const prismaOptions = new Set(["schema", "connection_limit", "pool_timeout", "socket_timeout", "pgbouncer", "statement_cache_size"]);
  for (const [key, entry] of url.searchParams) {
    if (libpqOptions[key]) env[libpqOptions[key]] = entry;
    else if (!prismaOptions.has(key)) throw new BackupError("UNSUPPORTED_CONNECTION_OPTION");
  }
  // Identity ignores credentials and options so changing a password cannot bypass
  // the restore guard for the same host/port/database.
  return { env, database, identity: JSON.stringify([host.toLowerCase(), port, database]) };
}

export function runPostgresTool(command: "pg_dump" | "pg_restore" | "psql", args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    let exceeded = false;
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      child.kill("SIGTERM");
      if (!killTimer) killTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, 10 * 60000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (data: string) => {
      if (output.length + data.length > 1024 * 1024) { exceeded = true; stop(); }
      else output += data;
    });
    child.once("error", () => { clearTimeout(timer); if (killTimer) clearTimeout(killTimer); reject(new BackupError("POSTGRES_TOOL_UNAVAILABLE")); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (timedOut) { reject(new BackupError("POSTGRES_TOOL_TIMEOUT")); return; }
      if (exceeded || code !== 0) reject(new BackupError(exceeded ? "POSTGRES_TOOL_OUTPUT_TOO_LARGE" : "POSTGRES_TOOL_FAILED"));
      else resolve(output);
    });
  });
}
export async function fileSha256(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
