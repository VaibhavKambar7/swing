import { describe, expect, it } from "vitest";
import { retryDelayMs } from "../src/lib/jobs/queue";
import { validateJobPayload } from "../src/lib/jobs/handlers";
import { parseEnv } from "../src/lib/config/env";

describe("job runner settings", () => {
  it("backs off exponentially with a five-minute cap", () => {
    expect([1, 2, 3, 10, 100000].map(retryDelayMs)).toEqual([5000, 10000, 20000, 300000, 300000]);
  });
  it("validates supported kinds and payloads", () => {
    expect(validateJobPayload("database.check", {})).toEqual({});
    expect(validateJobPayload("announcements.analyze", {})).toEqual({ limit: 1 });
    expect(() => validateJobPayload("__proto__", {})).toThrow("UNSUPPORTED_JOB_KIND");
    expect(() => validateJobPayload("database.check", { secret: "ignored?" })).toThrow("INVALID_JOB_PAYLOAD");
    expect(() => validateJobPayload("announcements.analyze", { limit: 21 })).toThrow("INVALID_JOB_PAYLOAD");
  });
  it("bounds worker polling frequency", () => {
    const base = { DATABASE_URL: "postgresql://localhost/swing" };
    expect(parseEnv(base).WORKER_JOB_POLL_MS).toBe(2000);
    for (const value of ["0", "100", "60001", "NaN"]) {
      expect(() => parseEnv({ ...base, WORKER_JOB_POLL_MS: value })).toThrow("WORKER_JOB_POLL_MS");
    }
  });
});
