import { NextRequest, NextResponse } from "next/server";
import { accessConfigured, authorize } from "./lib/auth/access";
// Every page, action, API and diagnostic passes through the same fail-closed gate.
export function proxy(request: NextRequest) {
  if (!accessConfigured()) return new NextResponse("Configure SWING_AUTH_USER and a SWING_AUTH_PASSWORD of at least 24 characters.", { status: 503 });
  if (!authorize(request.headers.get("authorization"))) return new NextResponse("Authentication required", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="Swing", charset="UTF-8"', "Cache-Control": "no-store" } });
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
    const origin = request.headers.get("origin");
    const expected = process.env.SWING_PUBLIC_ORIGIN ?? request.nextUrl.origin;
    if (!origin || origin !== expected) return new NextResponse("Same-origin request required", { status: 403 });
  }
  const response = NextResponse.next();
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "same-origin");
  response.headers.set("Content-Security-Policy", "frame-ancestors 'none'; object-src 'none'; base-uri 'self'");
  return response;
}
export const config = { matcher: "/:path*" };
