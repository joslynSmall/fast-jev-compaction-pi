import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isSpillNotice, spillPayload } from "../src/spill.js";

describe("spill", () => {
  it("parks identical payloads in one file and names it in the notice", () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-spill-"));
    const text = "FAIL src/auth.test.ts\nExpected: 401\nReceived: 200\n".repeat(50);
    const first = spillPayload(text, dir);
    const second = spillPayload(text, dir);
    expect(first.hash).toBe(second.hash);
    expect(first.path).toBe(second.path);
    expect(first.notice).toContain(first.path);
    expect(readFileSync(first.path, "utf8")).toBe(text);
    expect(isSpillNotice(first.notice)).toBe(true);
  });

  it("does not mistake ordinary output for a spill notice", () => {
    expect(isSpillNotice("FAIL expected 401")).toBe(false);
  });
});
