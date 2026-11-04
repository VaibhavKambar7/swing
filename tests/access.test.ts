import { describe, it, expect } from "vitest";
import { authorize, workerAuthorized } from "../src/lib/auth/access";
describe("personal access", () => {
  const env = { SWING_AUTH_USER: "owner", SWING_AUTH_PASSWORD: "a".repeat(32), WORKER_ACCESS_TOKEN: "b".repeat(32) };
  it("fails closed without configuration or invalid credentials", () => {
    expect(authorize(null, env)).toBe(false);
    expect(authorize("Basic " + Buffer.from("owner:wrong").toString("base64"), env)).toBe(false);
    expect(authorize("Basic x", {})).toBe(false);
  });
  it("validates both web credentials and separate worker bearer", () => {
    expect(authorize("Basic " + Buffer.from(`owner:${env.SWING_AUTH_PASSWORD}`).toString("base64"), env)).toBe(true);
    expect(workerAuthorized(`Bearer ${env.WORKER_ACCESS_TOKEN}`, env)).toBe(true);
    expect(workerAuthorized(undefined, env)).toBe(false);
  });
});

describe("web route gate", () => {
  it("protects pages, APIs and action posts and rejects cross-origin mutations", async () => {
    const { vi } = await import("vitest");
    const { NextRequest } = await import("next/server");
    const { proxy } = await import("../src/proxy");
    vi.stubEnv("SWING_AUTH_USER", "owner"); vi.stubEnv("SWING_AUTH_PASSWORD", "s".repeat(32)); vi.stubEnv("SWING_PUBLIC_ORIGIN", "https://swing.example.com");
    try {
      const authorization = "Basic " + Buffer.from(`owner:${"s".repeat(32)}`).toString("base64");
      for (const path of ["/", "/system/controls", "/api/workspace/activity", "/api/health/ready"]) expect(proxy(new NextRequest(`https://swing.example.com${path}`)).status).toBe(401);
      expect(proxy(new NextRequest("https://swing.example.com/", { headers: { authorization } })).status).toBe(200);
      expect(proxy(new NextRequest("https://swing.example.com/", { method: "POST", headers: { authorization, origin: "https://attacker.example.com" } })).status).toBe(403);
      expect(proxy(new NextRequest("https://swing.example.com/", { method: "POST", headers: { authorization, origin: "https://swing.example.com" } })).status).toBe(200);
      vi.stubEnv("SWING_AUTH_PASSWORD", "");
      expect(proxy(new NextRequest("https://swing.example.com/", { headers: { authorization } })).status).toBe(503);
    } finally { vi.unstubAllEnvs(); }
  });
});
