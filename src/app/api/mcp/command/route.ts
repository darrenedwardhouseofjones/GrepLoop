import { NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";
import { findPrByIdOrNumber, findPrByBranch } from "@/src/lib/findPr";
import { runPrScan } from "@/reviewService";
import { authenticateMcpRequest } from "@/src/lib/mcpAuth";

async function resolvePr(body: any, cmdArg: string): Promise<any | null> {
  if (cmdArg) return findPrByIdOrNumber(cmdArg);
  if (body.repoId && body.branch) return findPrByBranch(body.repoId, body.branch);
  return null;
}

const TOOLS = [
  {
    name: "prcheck",
    description: "Review a pull request. Pass number=PR_ID, or repoId+branch for branch-based lookup. Returns rating 1-5 and findings.",
    inputSchema: {
      type: "object",
      properties: {
        number: { type: "string", description: "PR number (e.g. '2')" },
        repoId: { type: "string", description: "Repository ID" },
        branch: { type: "string", description: "Branch name (used with repoId)" },
      },
    },
  },
  {
    name: "prcomments",
    description: "Get persisted review findings for a pull request. Pass number=PR_ID, or repoId+branch.",
    inputSchema: {
      type: "object",
      properties: {
        number: { type: "string", description: "PR number" },
        repoId: { type: "string", description: "Repository ID" },
        branch: { type: "string", description: "Branch name (used with repoId)" },
      },
    },
  },
  {
    name: "prlist",
    description: "List all pull requests for a repository with their ratings. Pass repoId.",
    inputSchema: {
      type: "object",
      properties: {
        repoId: { type: "string", description: "Repository ID (required)" },
      },
      required: ["repoId"],
    },
  },
];

async function handlePrCheck(args: any): Promise<string> {
  const pr = args.number
    ? await findPrByIdOrNumber(args.number)
    : args.repoId && args.branch
      ? await findPrByBranch(args.repoId, args.branch)
      : null;
  if (!pr) return `PR not found. Provide "number" or "repoId"+"branch".`;

  const sr = await runPrScan(pr.id);
  const pass = sr.rating >= 4;
  let out = `## PR #${pr.id} — "${pr.title}"\n**Rating: ${sr.rating}/5** — ${pass ? "PASS" : "FAIL"}\n\n`;
  if (sr.findings.length === 0) {
    out += "No findings.\n";
  } else {
    for (const f of sr.findings) {
      out += `- [${f.category}|${f.severity}] ${f.filename}:${f.line} (confidence: ${((f.confidence ?? 0.5) * 100).toFixed(0)}%)\n  ${f.explanation}\n`;
    }
  }
  return out;
}

async function handlePrComments(args: any): Promise<string> {
  const pr = args.number
    ? await findPrByIdOrNumber(args.number)
    : args.repoId && args.branch
      ? await findPrByBranch(args.repoId, args.branch)
      : null;
  if (!pr) return `PR not found. Provide "number" or "repoId"+"branch".`;

  const findings = await prisma.reviewFinding.findMany({ where: { prId: pr.id } });
  if (findings.length === 0) return "No findings for this PR.";
  let out = `## Findings for PR #${pr.id}\n\n`;
  for (const f of findings) {
    out += `- [${f.category}|${f.severity}] ${f.filename}:${f.line}\n  ${f.explanation}\n`;
  }
  return out;
}

async function handlePrList(args: any): Promise<string> {
  if (!args.repoId) return 'Pass "repoId" to list PRs.';
  const prs = await prisma.pullRequest.findMany({
    where: { repoId: args.repoId },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  if (prs.length === 0) return "No PRs found for this repo.";
  let out = `## Pull Requests\n\n`;
  for (const p of prs) {
    out += `- **#${p.id.replace(/^pr-?/, "")}** — ${p.title} (${p.sourceBranch}) — ${p.rating != null ? `${p.rating}/5` : "Not scanned"}\n`;
  }
  return out;
}

const toolHandlers: Record<string, (args: any) => Promise<string>> = {
  prcheck: handlePrCheck,
  prcomments: handlePrComments,
  prlist: handlePrList,
};

// ── GET: health check (required by some MCP clients) ──
export function GET() {
  return NextResponse.json({ ok: true, message: "bughunter MCP server — use POST for JSON-RPC" });
}

// ── POST: JSON-RPC (Streamable HTTP) or legacy command format ──
export async function POST(req: Request) {
  const auth = await authenticateMcpRequest(req);
  if (!auth.ok) {
    return NextResponse.json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: auth.error } }, { status: 401 });
  }

  const clone = req.clone();
  const body = await clone.json().catch(() => null);

  // JSON-RPC auto-detect
  if (body && body.jsonrpc && body.method) {
    return handleJsonRpc(body);
  }

  return handleLegacyCommand(body);
}

async function handleJsonRpc(body: any) {
  const { method, id, params } = body;

  if (id === undefined || id === null) {
    return new Response(null, { status: 202 });
  }

  if (method === "initialize") {
    return NextResponse.json({
      jsonrpc: "2.0", id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "bughunter", version: "1.0.0" },
      },
    });
  }

  if (method === "tools/list") {
    return NextResponse.json({
      jsonrpc: "2.0", id,
      result: { tools: TOOLS },
    });
  }

  if (method === "tools/call") {
    const toolName = params?.name;
    const args = params?.arguments ?? {};
    if (!toolName || !toolHandlers[toolName]) {
      return NextResponse.json({
        jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown tool: ${toolName}` },
      });
    }
    const result = await toolHandlers[toolName](args);
    return NextResponse.json({
      jsonrpc: "2.0", id,
      result: { content: [{ type: "text", text: result }] },
    });
  }

  return NextResponse.json({
    jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown method: ${method}` },
  });
}

// ── Legacy command format ──
async function handleLegacyCommand(body: any) {
  const { command } = body || {};
  if (!command || typeof command !== "string") {
    return NextResponse.json({
      status: "Error",
      message: "Send a command. Examples:\n- '/prcheck 2'\n- '/prcheck' with { repoId: 'my-repo', branch: 'feature/xyz' }"
    }, { status: 400 });
  }

  const parts = command.trim().split(/\s+/);
  const cmdName = parts[0];
  const argVal = parts.slice(1).join(" ");

  try {
    if (cmdName.endsWith("prcheck") || cmdName.endsWith("checkpr")) {
      const pr = await resolvePr(body, argVal);
      if (!pr) return NextResponse.json({ status: "Error", message: "PR not found." });
      const sr = await runPrScan(pr.id);
      return NextResponse.json({
        status: "Success", type: "check", rating: `${sr.rating}/5`,
        productionGrade: sr.rating >= 4 ? "YES" : "NO",
        findingsCount: sr.findings.length,
        findings: sr.findings.map((f: any) =>
          `[${f.category} | ${f.severity}] ${f.filename}:${f.line} - ${f.explanation}`
        ),
      });
    }

    if (cmdName.endsWith("prcomments") || cmdName.endsWith("comments")) {
      const pr = await resolvePr(body, argVal);
      if (!pr) return NextResponse.json({ status: "Error", message: "PR not found." });
      const findings = await prisma.reviewFinding.findMany({ where: { prId: pr.id } });
      return NextResponse.json({
        status: "Success", type: "comments",
        productionScore: pr.rating ? `${pr.rating}/5` : "Not Scanned Yet",
        comments: findings.map((f: any) =>
          `[${f.category} | ${f.severity}] ${f.filename}:${f.line} - ${f.explanation}`
        ),
      });
    }

    if (cmdName.endsWith("prlist") || cmdName.endsWith("list")) {
      if (!body.repoId) return NextResponse.json({ status: "Error", message: "Pass { repoId }." }, { status: 400 });
      const prs = await prisma.pullRequest.findMany({
        where: { repoId: body.repoId }, orderBy: { createdAt: "desc" }, take: 20,
      });
      return NextResponse.json({
        status: "Success", type: "list", repoId: body.repoId,
        pullRequests: prs.map(p => ({
          number: p.id.replace(/^pr-?/, ""), id: p.id, title: p.title,
          branch: p.sourceBranch, rating: p.rating != null ? `${p.rating}/5` : "Not scanned",
        })),
      });
    }

    return NextResponse.json({ status: "Error", message: `Unknown command: ${cmdName}` }, { status: 400 });
  } catch (err: any) {
    console.error("[MCP error]:", err);
    return NextResponse.json({ status: "Error", message: err.message }, { status: 500 });
  }
}
