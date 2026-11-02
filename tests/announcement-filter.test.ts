import { describe, expect, it } from "vitest";
import { classifyAnnouncementRelevance } from "../src/lib/announcements/filter";

const decide = (subject: string, description: string | null = null) => classifyAnnouncementRelevance({ title: `TCS - ${subject}`, description });

describe("conservative announcement relevance", () => {
  it.each([
    ["Trading Window", "ROUTINE_TRADING_WINDOW"],
    ["Closure of the Trading Window", "ROUTINE_TRADING_WINDOW"],
    ["trading window closure", "ROUTINE_TRADING_WINDOW"],
    ["Loss of Share Certificates", "ROUTINE_SHARE_CERTIFICATE_NOTICE"],
    ["Issue of Duplicate Share Certificate", "ROUTINE_SHARE_CERTIFICATE_NOTICE"],
    ["Loss of Share Certificates / Issuance of Duplicate Share Certificates", "ROUTINE_SHARE_CERTIFICATE_NOTICE"],
    ["Compliance Certificate under Regulation 74(5) of SEBI (Depositories and Participants) Regulations, 2018", "ROUTINE_DEPOSITORY_CERTIFICATE"],
  ])("recognizes only an explicit routine subject: %s", (subject, reason) => {
    expect(decide(subject)).toEqual({ status: "routine", reason });
  });
  it.each([
    "Financial Results", "Dividend", "Acquisition", "Board Meeting Intimation",
    "Credit Rating Downgrade", "Investor Presentation", "Trading Window Closure and Financial Results",
  ])("keeps potentially meaningful subjects: %s", (subject) => {
    expect(decide(subject).status).toBe("keep");
  });
  it("keeps a routine-looking title when the body discloses a material event", () => {
    expect(decide("Trading Window Closure", "The company reported a <b>default</b> on its obligations.")).toEqual({ status: "keep", reason: "POTENTIALLY_MATERIAL_CONTEXT" });
    expect(decide("Loss of Share Certificates", "An investigation into fraud has commenced.").status).toBe("keep");
  });
  it.each(["Update", "Shareholding Pattern", "Newspaper Publication", "Compliance Certificate", "Trading Window Closure - Revised Notice"])("retains unknown or broad subjects for review: %s", (subject) => {
    expect(decide(subject).status).toBe("review");
  });
  it("does not mistake company names for disclosure subjects", () => {
    expect(classifyAnnouncementRelevance({ title: "Trading Window", description: null }).status).toBe("review");
    expect(classifyAnnouncementRelevance({ title: "Board Meeting Limited - Trading Window", description: null }).status).toBe("routine");
    expect(classifyAnnouncementRelevance({ title: "NSE:TCS: Trading Window Closure", description: null }).status).toBe("routine");
  });
  it("reviews encoded or unexpected body content instead of silently hiding it", () => {
    expect(decide("Trading Window", "Material fr&#97;ud disclosure").status).toBe("review");
    expect(decide("Trading Window", "An unexpected corporate development was disclosed.")).toEqual({ status: "review", reason: "UNRECOGNIZED_ROUTINE_BODY" });
    expect(decide("Trading Window", "<b>Trading Window</b>").status).toBe("routine");
  });
  it("limits rule processing without truncating unknown source content into a routine classification", () => {
    expect(decide("Trading Window", "a".repeat(20001))).toEqual({ status: "review", reason: "CONTENT_TOO_LARGE_FOR_RULES" });
  });
});
