import { describe, expect, it } from "vitest";
import { matchAnnouncement } from "../src/lib/announcements/match";

const stocks = [
  { id: "tcs", symbol: "TCS", name: "Tata Consultancy Services Limited" },
  { id: "infy", symbol: "INFY", name: "Infosys Limited" },
  { id: "hdfc", symbol: "HDFCBANK", name: "HDFC Bank Limited" },
];

describe("announcement issuer matching", () => {
  it.each([
    "TCS - Financial results", "NSE:TCS: Board meeting",
    "tata consultancy services ltd. – Updates", "Tata Consultancy Services — Updates",
    "Tata Consultancy Services Limited", "TCS|Investor presentation",
  ])("matches a company heading: %s", (title) => {
    expect(matchAnnouncement(title, stocks)).toEqual({ status: "matched", instrumentId: "tcs" });
  });
  it.each([
    "Other Company - Contract with TCS", "TCSS - Results", "HDFC - Results",
    "Infosys Technologies - Results", "Market update: INFY and TCS", "", " - TCS",
  ])("does not guess an issuer: %s", (title) => {
    expect(matchAnnouncement(title, stocks)).toEqual({ status: "unmatched", instrumentId: null });
  });
  it("keeps shared company names ambiguous rather than selecting the first", () => {
    expect(matchAnnouncement("Infosys - Update", [
      ...stocks, { id: "another", symbol: "OTHER", name: "Infosys Ltd" },
    ])).toEqual({ status: "ambiguous", instrumentId: null });
  });
});
