import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function spillDir(): string {
  return process.env.FAST_JEV_SPILL_DIR?.trim() || join(homedir(), ".pi", "jev-spill");
}

export function isSpillNotice(text: string): boolean {
  return text.includes("fast-jev-compaction-pi spilled");
}

/**
 * Parks a dropped tool payload on disk and returns a short recoverable note.
 * Identical payloads share one file. Throws on I/O failure (other than the
 * file already existing) so the caller can fall back to the inline note.
 */
export function spillPayload(
  text: string,
  dir: string = spillDir(),
): { hash: string; path: string; notice: string } {
  const hash = createHash("sha256").update(text).digest("hex").slice(0, 16);
  const path = join(dir, `${hash}.txt`);
  mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(path, text, { flag: "wx" });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
  }
  return {
    hash,
    path,
    notice: `[fast-jev-compaction-pi spilled ${text.length} chars → ${path}; read it back instead of re-running the tool]`,
  };
}
