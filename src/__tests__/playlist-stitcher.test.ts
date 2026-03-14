import { describe, it, expect } from "vitest";
import { buildPartList } from "../playlist-stitcher.js";

describe("buildPartList", () => {
  it("returns single recording part for a stream that was never paused", () => {
    const parts = buildPartList([], 1);
    expect(parts).toEqual([{ type: "recording", number: 1 }]);
  });

  it("returns recording + pause + recording for one pause cycle", () => {
    const parts = buildPartList([1], 2);
    expect(parts).toEqual([
      { type: "recording", number: 1 },
      { type: "pause", number: 1 },
      { type: "recording", number: 2 },
    ]);
  });

  it("handles multiple pause cycles", () => {
    const parts = buildPartList([1, 2], 3);
    expect(parts).toEqual([
      { type: "recording", number: 1 },
      { type: "pause", number: 1 },
      { type: "recording", number: 2 },
      { type: "pause", number: 2 },
      { type: "recording", number: 3 },
    ]);
  });

  it("does not duplicate current part if already in completedParts", () => {
    // Edge case: completedParts already includes the current part number
    const parts = buildPartList([1, 2, 3], 3);
    expect(parts).toEqual([
      { type: "recording", number: 1 },
      { type: "pause", number: 1 },
      { type: "recording", number: 2 },
      { type: "pause", number: 2 },
      { type: "recording", number: 3 },
    ]);
  });

  it("sorts parts numerically even if completedParts is unsorted", () => {
    const parts = buildPartList([3, 1], 4);
    expect(parts).toEqual([
      { type: "recording", number: 1 },
      { type: "pause", number: 1 },
      { type: "recording", number: 3 },
      { type: "pause", number: 3 },
      { type: "recording", number: 4 },
    ]);
  });
});
