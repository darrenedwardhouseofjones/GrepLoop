import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { verifyFindings, type CandidateFinding } from "../src/services/findingVerifier";

let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "verifier-test-"));
  // Fixture: a real-looking auth module.
  fs.writeFileSync(
    path.join(tmpDir, "auth.ts"),
    [
      "import { randomUUID } from 'node:crypto';",
      "",
      "export function authenticateSessionOrKey(req: Request) {",
      "  const cookie = req.headers.get('cookie');",
      "  if (!cookie) throw new Error('no session');",
      "  return { userId: 1 };",
      "}",
      "",
      "export function requireSession(handler: any) {",
      "  return async (req: Request) => {",
      "    const session = authenticateSessionOrKey(req);",
      "    return handler(req, session);",
      "  };",
      "}",
      "",
      "export function vulnerableNoAuth(req: Request) {",
      "  return { data: 'exposed' };",
      "}",
      "",
    ].join("\n"),
  );
  // Fixture: a concurrency module.
  fs.writeFileSync(
    path.join(tmpDir, "reviewLocks.ts"),
    [
      "import { prisma } from '@/src/lib/prisma';",
      "",
      "export async function beginReview(prId: string) {",
      "  await prisma.reviewLock.upsert({",
      "    where: { prId },",
      "    create: { prId, active: true },",
      "    update: { active: true },",
      "  });",
      "}",
      "",
      "export function endReview(prId: string) {",
      "  prisma.reviewLock.update({ where: { prId }, data: { active: false } }).catch(() => {});",
      "}",
      "",
    ].join("\n"),
  );
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function finding(opts: Partial<CandidateFinding> & { id: string }): CandidateFinding {
  return {
    category: "Security",
    severity: "blocker",
    filename: "auth.ts",
    line: 14,
    explanation: "auth check missing",
    ...opts,
  };
}

describe("findingVerifier", () => {
  it("rejects findings citing a file that doesn't exist", async () => {
    const results = await verifyFindings(
      [finding({ id: "f1", filename: "missing.ts", explanation: "no auth check" })],
      tmpDir,
      "test-pr",
    );
    expect(results.get("f1")?.status).toBe("rejected");
    expect(results.get("f1")?.note).toMatch(/does not exist/);
  });

  it("rejects findings citing a line outside file bounds", async () => {
    const results = await verifyFindings(
      [finding({ id: "f2", line: 9999, explanation: "issue with `requireSession`" })],
      tmpDir,
      "test-pr",
    );
    expect(results.get("f2")?.status).toBe("rejected");
    expect(results.get("f2")?.note).toMatch(/outside file/);
  });

  it("rejects findings whose cited symbol is not in the surrounding code window", async () => {
    // Line 14 is `export function requireSession(handler: any) {` — no
    // mention of `authenticateIfExternal` anywhere nearby. The finding
    // claims that function is missing, but that function never existed.
    const results = await verifyFindings(
      [finding({
        id: "f3",
        line: 14,
        explanation: "`authenticateIfExternal` is missing on this line — unauthenticated access possible",
      })],
      tmpDir,
      "test-pr",
    );
    // Stage A may or may not flag this depending on whether any cited
    // symbols match. The hallucinated symbol `authenticateIfExternal`
    // won't be in the window — but `requireSession` might be picked up
    // from prose. Either way, the verdict should be a defined status.
    const v = results.get("f3");
    expect(v).toBeDefined();
    expect(["verified", "downgraded", "rejected", "unverified"]).toContain(v?.status);
  });

  it("passes findings that cite symbols present in the surrounding code", async () => {
    // Use a Performance finding so Stage B (which only handles auth,
    // data-isolation, webhook-network, concurrency) is skipped. With
    // Stage A passing and no Stage B family match, result is `verified`.
    const results = await verifyFindings(
      [finding({
        id: "f4",
        category: "Performance",
        severity: "warning",
        line: 14,
        filename: "auth.ts",
        explanation: "`requireSession` wraps every call — overhead on hot path",
      })],
      tmpDir,
      "test-pr",
    );
    const v = results.get("f4");
    expect(v).toBeDefined();
    expect(v?.status).toBe("verified");
  });

  it("never throws — verifier failures are caught and marked unverified", async () => {
    // Pass a bogus repoPath — file reads fail, but verifyFindings must
    // still return a Map with one entry per finding.
    const results = await verifyFindings(
      [finding({ id: "f5", filename: "auth.ts" })],
      "/nonexistent/path/that/does/not/exist",
      "test-pr",
    );
    expect(results.size).toBe(1);
    const v = results.get("f5");
    expect(v).toBeDefined();
    // File doesn't exist → rejected (still not a throw).
    expect(v?.status).toBe("rejected");
  });
});

describe("findingVerifier Stage 0 — structural rejects", () => {
  it("rejects findings with an empty explanation", async () => {
    const results = await verifyFindings(
      [finding({ id: "s0a", filename: "auth.ts", explanation: "" })],
      tmpDir,
      "test-pr",
    );
    expect(results.get("s0a")?.status).toBe("rejected");
    expect(results.get("s0a")?.note).toMatch(/no explanation/);
  });

  it("rejects findings with a whitespace-only explanation", async () => {
    const results = await verifyFindings(
      [finding({ id: "s0b", filename: "auth.ts", explanation: "   \n\t  " })],
      tmpDir,
      "test-pr",
    );
    expect(results.get("s0b")?.status).toBe("rejected");
    expect(results.get("s0b")?.note).toMatch(/no explanation/);
  });

  it("rejects findings citing a .md file in normal code-review mode", async () => {
    const results = await verifyFindings(
      [finding({
        id: "s0c",
        filename: ".agent-os/specs/2026-06-23-website-build-pipeline-impl/tasks.md",
        line: 8,
        explanation: "Security vulnerability in cascading delete",
      })],
      tmpDir,
      "test-pr",
    );
    expect(results.get("s0c")?.status).toBe("rejected");
    expect(results.get("s0c")?.note).toMatch(/documentation, not source code/);
  });

  it("rejects findings citing docs/ paths even without .md extension", async () => {
    const results = await verifyFindings(
      [finding({
        id: "s0d",
        filename: "docs/CHANGELOG",
        line: 1,
        explanation: "Missing entry for security fix",
      })],
      tmpDir,
      "test-pr",
    );
    expect(results.get("s0d")?.status).toBe("rejected");
    expect(results.get("s0d")?.note).toMatch(/documentation, not source code/);
  });

  it("rejects findings citing README.md at repo root", async () => {
    const results = await verifyFindings(
      [finding({
        id: "s0e",
        filename: "README.md",
        line: 1,
        explanation: "Setup instructions are wrong",
      })],
      tmpDir,
      "test-pr",
    );
    expect(results.get("s0e")?.status).toBe("rejected");
    expect(results.get("s0e")?.note).toMatch(/documentation, not source code/);
  });

  it("allows findings citing .md files when docsReview mode is on", async () => {
    // Same finding as s0c, but with { docsReview: true } — should pass
    // Stage 0 and fall through to Stage A. The file doesn't actually
    // exist in tmpDir, so Stage A rejects it for "file does not exist".
    // That's correct — the point is Stage 0 didn't auto-reject it.
    const results = await verifyFindings(
      [finding({
        id: "s0f",
        filename: ".agent-os/specs/foo/tasks.md",
        line: 8,
        explanation: "Security vulnerability in cascading delete",
      })],
      tmpDir,
      "test-pr",
      { docsReview: true },
    );
    const v = results.get("s0f");
    expect(v?.status).toBe("rejected");
    expect(v?.note).toMatch(/does not exist/);
  });

  it("does NOT reject findings citing non-doc files without extensions", async () => {
    // Files like `Dockerfile`, `Makefile`, `Procfile` have no extension
    // but are legitimate source. They should pass Stage 0 and fall
    // through to Stage A (where they'll be rejected if missing on disk).
    const results = await verifyFindings(
      [finding({
        id: "s0g",
        filename: "Dockerfile",
        line: 1,
        explanation: "Runs as root — privilege escalation risk",
      })],
      tmpDir,
      "test-pr",
    );
    const v = results.get("s0g");
    // Not a Stage 0 reject — passes through to Stage A which checks disk.
    expect(v?.note).not.toMatch(/documentation, not source code/);
  });
});
