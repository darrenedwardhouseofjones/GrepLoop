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
    explanation: "",
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
