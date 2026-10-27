import { describe, expect, it } from "vitest";
import { parseEnv } from "../src/lib/config/env";

const valid = { DATABASE_URL: "postgresql://swing:private-password@localhost:5434/swing" };

describe("server configuration", () => {
  it("accepts PostgreSQL settings and supplies local worker defaults", () => {
    expect(parseEnv(valid)).toMatchObject({ WORKER_PORT: 3001, WORKER_HEARTBEAT_MS: 10000 });
  });
  it.each(["https://example.com", "not-a-url", ""])("rejects an invalid database address: %s", (DATABASE_URL) => {
    expect(() => parseEnv({ DATABASE_URL })).toThrow("DATABASE_URL");
  });
  it.each(["0", "65536", "3001.5", "NaN"])("rejects invalid worker ports: %s", (WORKER_PORT) => {
    expect(() => parseEnv({ ...valid, WORKER_PORT })).toThrow("WORKER_PORT");
  });
  it("rejects excessively frequent or slow heartbeats", () => {
    expect(() => parseEnv({ ...valid, WORKER_HEARTBEAT_MS: "10" })).toThrow("WORKER_HEARTBEAT_MS");
    expect(() => parseEnv({ ...valid, WORKER_HEARTBEAT_MS: "999999" })).toThrow("WORKER_HEARTBEAT_MS");
  });
  it("never includes submitted credentials in validation errors", () => {
    const DATABASE_URL = "https://user:secret-token@example.com";
    try {
      parseEnv({ DATABASE_URL });
      expect.fail("Expected validation failure");
    } catch (error) {
      expect(String(error)).toContain("DATABASE_URL");
      expect(String(error)).not.toContain("secret-token");
      expect(String(error)).not.toContain(DATABASE_URL);
    }
  });
});
