import { prisma } from "./src/lib/prisma";
import { getChatChain } from "./src/lib/llmClient";
import { randomUUID } from "node:crypto";

export interface ScanResult {
  success: boolean;
  rating: number | null;
  findings: any[];
  usedModel: string;
  systemWarn?: string | null;
}

async function logReview(prId: string, message: string, level: string = "info") {
  try {
    await prisma.reviewLog.create({
      data: { id: randomUUID(), prId, message, level },
    });
  } catch {
    // Best-effort — never break the review for a log write failure.
  }
}

/**
 * The responseSchema is reused as the parameters for the submitReview tool
 * (model returns its final review by calling the tool with the full
 * finding/rating shape). Plain JSON Schema — no `strict: true`, since the
 * schema has optional `diffSuggestion` and `evidenceChain` fields that
 * strict mode would reject.
 */
const reviewResponseSchema = {
  type: "object",
  properties: {
    rating: {
      type: "integer",
      description: "The overall code quality rating of this PR, from 1 to 10. Grade 8+ is production grade, 1-7 requires improvements.",
    },
    summary: {
      type: "string",
      description: "A short, descriptive summary of the code changes, overall assessment, and key bugs noticed.",
    },
    findings: {
      type: "array",
      description: "The list of code inspections and issues found in the PR files.",
      items: {
        type: "object",
        properties: {
          category: {
            type: "string",
            description: "Strict category of the finding.",
            enum: ["Correctness", "Security", "Performance", "Accessibility", "Style"],
          },
          severity: {
            type: "string",
            description: "Severity level of the finding.",
            enum: ["blocker", "warning", "suggestion"],
          },
          filename: {
            type: "string",
            description: "The name of the inspected file where the finding originates.",
          },
          line: {
            type: "integer",
            description: "The 1-indexed approximate line number where the finding is located in the file.",
          },
          explanation: {
            type: "string",
            description: "Human-readable explanation of why this is an issue and how it can be resolved.",
          },
          diffSuggestion: {
            type: "string",
            description: "Recommended code changes or fixes to address this finding.",
          },
          confidence: {
            type: "number",
            description: "Confidence score from 0.0 to 1.0 indicating how certain you are this is a real issue. High confidence (>0.8) = definite bug. Low confidence (<0.4) = possible nitpick.",
          },
          evidenceChain: {
            type: "array",
            description: "Multi-hop trace showing how a bug propagates across related files or functions. List of trace points in execution path order.",
            items: {
              type: "object",
              properties: {
                file: { type: "string", description: "Name of the file in the codebase path." },
                line: { type: "integer", description: "Line number where the reference exists." },
                text: { type: "string", description: "Description of the code role or dependency relationship." },
              },
              required: ["file", "line", "text"],
            },
          },
        },
        required: ["category", "severity", "filename", "line", "explanation", "confidence"],
      },
    },
  },
  required: ["rating", "summary", "findings"],
};

const tools = [
  {
    type: "function" as const,
    function: {
      name: "searchCodebase",
      description: "Search the codebase for symbols by name to gather context.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The symbol name or keyword to search for (e.g., 'MfaModal')" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "getCallers",
      description: "Get functions that call the given symbol ID to trace impact of a change.",
      parameters: {
        type: "object",
        properties: {
          symbolId: { type: "string", description: "The stable symbol ID obtained from searchCodebase tool." },
        },
        required: ["symbolId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "findSimilar",
      description: "Given an implementation query, find semantically similar code snippets using vector embeddings.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The description of the functionality to search for" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "submitReview",
      description: "Submit the final PR review assessment to end the loop. Call this when you have gathered enough context.",
      parameters: reviewResponseSchema,
    },
  },
];

const SYSTEM_INSTRUCTION = `You are "BugHunter" — a paranoid, zero-tolerance code reviewer. You trust NOTHING and NO ONE. Someone is trying to steal your millions through this code. Find every hole before they do.

Your ONLY job: inspect the PR diff and codebase context. DO NOT modify any files or write code. You are a detective, not a fixer.

MINDSET:
- Assume every line is malicious until proven safe.
- Assume every variable is unvalidated input from an attacker.
- Assume every dependency is compromised.
- Assume every TODO is a time bomb.
- Assume the developer cut every corner they could.
- Your reputation and fortune depend on catching every issue.
- One missed exploit = everything gone. Be ruthless.

CATEGORIES (classify every finding into exactly one):
- "Security" — OWASP top 10 violations, hardcoded secrets, injection risks, auth bypasses, privilege escalation, XSS, CSRF, SSRF, insecure deserialization, path traversal, crypto flaws.
- "Correctness" — logic bugs, off-by-one, race conditions, null dereferences, type unsafe coercion, unhandled errors, deadlock risks, state corruption.
- "Performance" — N+1 queries, memory leaks, unbounded loops, blocking event loop, render-blocking, unnecessary allocations.
- "Accessibility" — missing ARIA labels, keyboard trap, color contrast failures, semantic HTML violations, screen reader breakage.
- "Style" — code complexity, confusing names, dead code, fragile patterns, copy-paste code, missing error boundaries, overly clever tricks.

SEVERITY:
- "blocker" — WILL cause a production incident, data loss, or security breach. Non-negotiable.
- "warning" — Likely to cause problems. Strongly recommend fixing.
- "suggestion" — Not critical but improves quality, safety, or maintainability.

Every finding MUST include:
- Exact file path and line number
- Detailed explanation of WHY this is dangerous
- A confidence score 0.0-1.0 (be honest but skeptical — if you can't prove it's safe, flag it)
- A concrete code suggestion in diffSuggestion
- Evidence chain showing how the issue propagates

GRADING (1-10 scale):
- 10/10 — Flawless. No security holes, no correctness bugs, no performance traps. Production-ready.
- 9/10 — Exceptional. Only nit-level suggestions.
- 8/10 — Production grade. Minor issues only. Safe to deploy.
- 7/10 — Solid but has warnings. Reviewer should fix warnings before merge.
- 5-6/10 — Has blockers or significant warnings. NOT production grade. Must fix.
- 3-4/10 — Significant problems. Major rework needed.
- 1-2/10 — Catastrophic. This code is dangerous. Reject entirely.

When done, call submitReview with the final assessment. If no tool calling available, respond with a single JSON object: { rating, summary, findings[] }.

Do not sugarcoat. Do not soften the blow. If the code is bad, say so. If it's clean, say so. Be absolutely certain either way.`;

/**
 * Executes the PR scan against the configured OpenAI-compatible LLM.
 * Reads endpoint+key+model from env (see src/lib/llmClient.ts); no longer
 * takes a backend-option parameter. Falls through to procedural findings
 * when the LLM is unconfigured or fails — UI surfaces this via systemWarn.
 */
export async function runPrScan(prId: string): Promise<ScanResult> {
  // 1. Fetch Pull Request details
  const pr = await prisma.pullRequest.findUnique({ where: { id: prId } });
  if (!pr) {
    throw new Error(`Pull Request with ID "${prId}" was not found.`);
  }

  // 2. Fetch modified files and diff content
  const files = await prisma.prFile.findMany({
    where: { prId },
    select: { filename: true, status: true, additions: true, deletions: true, originalContent: true, modifiedContent: true, diff: true },
  });
  if (files.length === 0) {
    await prisma.pullRequest.updateMany({ where: { id: prId }, data: { status: "Failed" } });
    throw new Error("No modified files or diffs found in this Pull Request to scan.");
  }

  // 3. Mark PR status as 'In Progress' for real-time visual progress
  await prisma.pullRequest.updateMany({ where: { id: prId }, data: { status: "In Progress" } });

  let findings: any[] = [];
  let rating: number | null = null;
  let usedModel = "unconfigured";
  let systemWarn: string | null = null;

  // 4. Retrieve codebase-wide multi-hop context from indexed AST tables
  let codebaseContext = "";
  try {
    const symbolList = await prisma.symbol.findMany({
      where: { repoId: pr.repoId, filePath: { in: files.map((f) => f.filename) } },
    });
    if (symbolList && symbolList.length > 0) {
      codebaseContext += "\n=== CODEBASE AST SYMBOLS DETECTED & MODIFIED IN PR ===\n";
      for (const sym of symbolList) {
        codebaseContext += `- Symbol: "${sym.name}" (${sym.kind}) defined at "${sym.filePath}" [lines ${sym.lineStart}-${sym.lineEnd}] in ${sym.language}\n`;
        const callers = await prisma.edge.findMany({ where: { repoId: pr.repoId, toId: sym.id } });
        if (callers && callers.length > 0) {
          codebaseContext += "  Codebase call reference linkages (Call graph propagation):\n";
          for (const caller of callers) {
            const callerSym = await prisma.symbol.findUnique({ where: { id: caller.fromId } });
            codebaseContext += `    * Called by: "${callerSym ? callerSym.name : "Unknown code block"}" in file "${caller.filePath}" at line ${caller.line}\n`;
          }
        }
      }
    }
  } catch (err) {
    console.log("No index records found or symbols table is not populated yet for this workspace.", err);
  }

  // 5. Build diff payload for the model
  const diffPayload = files
    .map(
      (f) =>
        `--- FILE: ${f.filename} (Status: ${f.status}, Additions: ${f.additions}, Deletions: ${f.deletions}) ---\n` +
        `=== GIT DIFF ===\n${f.diff || ""}\n` +
        `=== CONTEXT (LAST MODIFIED FULL CODE) ===\n${f.modifiedContent || ""}\n`,
    )
    .join("\n\n");

  // 6. Run agentic review loop, iterating providers in the chain.
  //    Primary first, then fallback if configured. If every provider
  //    fails or all loops end without a submitReview, we surface an
  //    honest empty-failings + null-rating result with an actionable
  //    systemWarn. Never fabricate templated findings — three months
  //    of solarplanner "reviews" were that template silently masking
  //    LLM failures.
  const chain = getChatChain();
  let agenticError: string | null = null;
  let finalReview: any = null;

  if (chain.length === 0) {
    systemWarn = "No LLM endpoint or chat model configured. Open the LLM Settings tab and configure at least one provider.";
  } else {
    providerLoop: for (const { client, model, name } of chain) {
      usedModel = model;
      try {
        const initialPrompt = `Your mission: audit this PR with maximum prejudice. Assume the author is hiding something. Trace every changed function across the codebase — check its callers, its callees, its error handling, its edge cases. Use \`searchCodebase\`, \`getCallers\`, and \`findSimilar\` to validate that nothing is overlooked.
When you are satisfied (or outraged), call \`submitReview\` exactly once.

=== CANDIDATE PR INFORMATION ===
PR ID: ${pr.id}
Repo: ${pr.repoId}
Title: ${pr.title}
Description: ${pr.description || ""}

${codebaseContext ? `=== PRE-FETCHED AST SYMBOLS & CALL-GRAPH LINKAGES ===\n${codebaseContext}\n` : ""}
=== CHANGED FILES & CONTEXT ===
${diffPayload}`;

        const messages: any[] = [
          { role: "system", content: SYSTEM_INSTRUCTION },
          { role: "user", content: initialPrompt },
        ];

        let loopCount = 0;
        let lastHadToolCalls = false;

        while (loopCount < 8 && !finalReview) {
          loopCount++;
          console.log(`[review] iteration ${loopCount}/8 provider=${name}`);
          void logReview(prId, `Iteration ${loopCount}/8 — ${name}`, "info");
          const response = await client.chat.completions.create({
            model,
            messages,
            tools,
            tool_choice: "auto",
            temperature: 0.2,
            // OpenRouter pre-flight checks worst-case cost = max_tokens ×
            // output-token price. Leaving this unset lets the model default
            // to its full output cap (e.g. 65536 for DeepSeek V4 Pro),
            // which can exceed the user's remaining credit budget even
            // though actual usage is much smaller. 16384 is comfortable
            // headroom for a structured findings JSON with evidence chains.
            max_tokens: 16384,
          });

          const msg = response.choices?.[0]?.message;
          if (!msg) break;
          messages.push(msg);
          lastHadToolCalls = Boolean(msg.tool_calls && msg.tool_calls.length > 0);

          if (msg.tool_calls && msg.tool_calls.length > 0) {
            for (const call of msg.tool_calls) {
              // OpenAI SDK v6 unions function-tool calls with custom-tool calls;
              // only the former has .function. Skip anything else.
              if (!("function" in call)) continue;
              const fnName = call.function?.name;
              const fnArgs = call.function?.arguments ? JSON.parse(call.function.arguments) : {};

              if (fnName === "submitReview") {
                console.log(
                  `[review] submitReview received: rating=${fnArgs.rating} findings=${fnArgs.findings?.length ?? 0} provider=${name}`,
                );
                void logReview(prId, `submitReview: rating=${fnArgs.rating}, ${fnArgs.findings?.length ?? 0} findings`, "info");
                finalReview = fnArgs;
                break;
              }

              let toolResult = "No results.";
              let resultSummary = "no results";
              try {
                if (fnName === "searchCodebase") {
                  const items = await prisma.symbol.findMany({
                    where: { repoId: pr.repoId, name: { contains: fnArgs.query } },
                    take: 10,
                    select: { id: true, name: true, kind: true, filePath: true, lineStart: true, lineEnd: true, summary: true },
                  });
                  if (items && items.length > 0) {
                    toolResult = JSON.stringify(items);
                    resultSummary = `${items.length} results`;
                  }
                } else if (fnName === "getCallers") {
                  const edges = await prisma.edge.findMany({ where: { repoId: pr.repoId, toId: fnArgs.symbolId } });
                  if (edges && edges.length > 0) {
                    toolResult = JSON.stringify(edges);
                    resultSummary = `${edges.length} results`;
                  }
                } else if (fnName === "findSimilar") {
                  const { IndexingService: idxSvc } = await import("./src/services/indexingService");
                  const scored = await idxSvc.semanticSearch(pr.repoId, fnArgs.query, 5);
                  if (scored && scored.length > 0) {
                    toolResult = JSON.stringify(scored);
                    resultSummary = `${scored.length} results`;
                  }
                }
              } catch (e) {
                console.error(`Tool ${fnName} failed:`, e);
                resultSummary = `error: ${(e as any)?.message || String(e)}`;
                toolResult = `Tool error: ${(e as any)?.message || String(e)}`;
                void logReview(prId, `Tool ${fnName} failed: ${(e as any)?.message || String(e)}`, "error");
              }
              console.log(`[review] tool ${fnName} → ${resultSummary}`);
              void logReview(prId, `Tool: ${fnName} → ${resultSummary}`, "tool_call");

              messages.push({
                role: "tool",
                tool_call_id: call.id,
                content: toolResult,
              });
            }
            if (finalReview) break;
            // Continue loop with the tool results now appended.
          } else {
            // No tool call — model returned text (some endpoints/models don't
            // support function calling). Try to parse the body as JSON.
            const rawText = msg.content?.trim() || "{}";
            try {
              const cleanJson = rawText
                .replace(/```json/gi, "")
                .replace(/```/g, "")
                .trim();
              const parsed = JSON.parse(cleanJson);
              if (parsed.rating && parsed.findings) {
                console.log(
                  `[review] parsed JSON finalReview without submitReview: rating=${parsed.rating} findings=${parsed.findings.length} provider=${name}`,
                );
                finalReview = parsed;
              }
            } catch {
              // not JSON — give up on this scan path
            }
            break;
          }
        }

        if (!finalReview) {
          console.log(
            `[review] loop exited without submitReview (iterations used: ${loopCount}, last message had tool_calls: ${lastHadToolCalls}) provider=${name}`,
          );
          void logReview(prId, `Loop exhausted — no submitReview after ${loopCount} iterations (last had tool_calls: ${lastHadToolCalls})`, "warn");
        }

        if (finalReview) {
          // Success — exit the chain loop early.
          break providerLoop;
        }
        // Else: provider ran without exception but produced no submitReview.
        // Fall through to the next provider (if any).
      } catch (err: any) {
        console.warn(`[review] chat provider ${name} failed: ${err.message}`);
        void logReview(prId, `Provider ${name} failed: ${err.message}`, "error");
        agenticError = `${name}: ${err.message}`;
        // try next provider
      }
    }

    if (finalReview) {
      findings = finalReview.findings || [];
      rating = Math.max(1, Math.min(10, finalReview.rating || 5));
    } else if (agenticError) {
      systemWarn = `All chat providers failed (last error: ${agenticError}). Check your internet connection and LLM Settings.`;
    } else {
      systemWarn = `Model ${usedModel} ended the agentic loop without calling submitReview. Check that the model supports tool calling, or pick a different model in LLM Settings.`;
    }
  }

  // 6. Persist findings
  await prisma.reviewFinding.deleteMany({ where: { prId } });

  let index = 1;
  for (const finding of findings) {
    await prisma.reviewFinding.create({
      data: {
        id: `find-live-${prId}-${index++}`,
        prId: prId,
        repoId: pr.repoId,
        category: finding.category || "Style",
        severity: finding.severity || "suggestion",
        filename: finding.filename || files[0].filename,
        line: finding.line || 1,
        explanation: finding.explanation || "No explanation provided.",
        diffSuggestion: finding.diffSuggestion || null,
        evidenceChain: finding.evidenceChain ? JSON.stringify(finding.evidenceChain) : null,
        confidence: finding.confidence != null ? finding.confidence : null,
        timestamp: new Date().toISOString(),
      },
    });
  }

  // 7. Update PR rating + status
  await prisma.pullRequest.updateMany({ where: { id: prId }, data: { status: "Completed", rating } });

  // 8. Audit trail
  const revId = `rev-${Date.now()}`;
  await prisma.reviewHistory.create({
    data: {
      id: revId,
      repoId: pr.repoId,
      repoName: pr.repoId,
      branch: pr.sourceBranch,
      commitHash: pr.commitHash,
      triggerReason: `Dynamic AI scan via ${usedModel}`,
      status: "done",
      timestamp: new Date().toISOString(),
    },
  });

  await prisma.repository.updateMany({
    where: { id: pr.repoId },
    data: { reviewsCount: { increment: 1 }, status: "idle" },
  });

  return {
    success: true,
    rating,
    findings,
    usedModel,
    systemWarn,
  };
}
