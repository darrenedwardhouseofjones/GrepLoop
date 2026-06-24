import { getChatClient, getChatModel, getEmbeddingChain } from "../lib/llmClient";
import { prisma } from "../lib/prisma";

/**
 * Required embedding dimensionality. Matches the `vector(1024)` column
 * type on `symbols.embedding` in `prisma/schema.prisma`. Vectors of any
 * other length are rejected by Postgres on insert with a cryptic error,
 * so we guard here and skip the write instead.
 *
 * If you swap to an embedding model with a different output dim,
 * update this constant AND the schema column in the same PR.
 *
 * Current: 1024 matches `mxbai-embed-large` (Ollama). To switch to a
 * 1536-dim model (OpenAI text-embedding-3-small, Voyage voyage-code-2),
 * bump this + the schema column together.
 */
export const EMBEDDING_DIM = 1024;

/**
 * Module-level circuit breaker. Once every provider in the embedding chain
 * has failed in a single session, subsequent calls short-circuit to []
 * without touching the network. Prevents log spam from the indexing service
 * (which retries every symbol on a schedule).
 *
 * Reset only by process restart — good enough for dev. Production rarely
 * hits all-providers-fail; if it does, an operator restart picks up new
 * config.
 */
let embeddingCircuitOpen = false;

/**
 * Cached dimensionality of vectors already stored in `symbols.embedding`.
 * Populated lazily on the first successful embedding call this session by
 * querying `vector_dims()` on one non-null row.
 *
 * - `undefined` → not yet checked this session (will query on next success)
 * - `null`      → queried, table has no vectors yet (will retry next call)
 * - `number`    → queried, cached. Subsequent calls compare against this.
 *
 * Used to detect the painful footgun where an operator swaps the embedding
 * model in LLM Settings without re-indexing: existing rows stay at the old
 * dim, new rows land at the new dim, and cosine similarity silently returns
 * wrong results (or errors) because vectors are length-mismatched.
 */
let cachedDbEmbeddingDim: number | null | undefined = undefined;

/**
 * One-shot guard for the dimension-mismatch warning. Once fired, suppressed
 * for the rest of the session — avoids log spam across thousands of symbols.
 * Reset only by process restart (same lifecycle as the circuit breaker).
 */
let dimMismatchWarned = false;

/**
 * Compares the dimensionality of vectors already stored in `symbols.embedding`
 * against the dimensionality the active provider just returned. If they
 * differ, emits a single structured warning explaining that the index is now
 * inconsistent and how to fix it (re-index or truncate).
 *
 * Fail-open: any DB error is swallowed. This is a best-effort UX guard, not
 * a correctness gate — the actual dim guard (EMBEDDING_DIM check above)
 * handles correctness.
 *
 * Queried at most once per session (cached in `cachedDbEmbeddingDim`). If
 * the table has no vectors yet, the cache stays `undefined` so we re-check
 * on the next call until rows appear.
 */
async function checkDbEmbeddingDimMismatch(
  providerDim: number,
  providerName: string,
): Promise<void> {
  if (dimMismatchWarned) return;

  if (cachedDbEmbeddingDim === undefined) {
    try {
      const rows = await prisma.$queryRaw<Array<{ dim: number | null }>>`
        SELECT vector_dims(embedding) AS dim
        FROM symbols
        WHERE embedding IS NOT NULL
        LIMIT 1
      `;
      cachedDbEmbeddingDim = rows[0]?.dim ?? null;
    } catch {
      // Fail open — DB unavailable, pgvector not installed, etc.
      // Better to index with no warning than to block on metadata.
      return;
    }
  }

  // No vectors yet — nothing to compare. Leave cache as `undefined` so we
  // retry on the next call (rows may appear later in the same session).
  if (cachedDbEmbeddingDim === null) {
    cachedDbEmbeddingDim = undefined;
    return;
  }

  if (cachedDbEmbeddingDim !== providerDim) {
    dimMismatchWarned = true;
    console.warn(
      `[embedding] ⚠ Dimension mismatch: database has ${cachedDbEmbeddingDim}-dim vectors ` +
        `in symbols.embedding, but provider "${providerName}" now returns ${providerDim}-dim. ` +
        `Cosine similarity requires equal-length vectors — new embeddings cannot be matched against ` +
        `existing ones, so semantic search will silently return wrong results (or error) until the ` +
        `index is rebuilt. Fix: re-index the repository from the UI (Repository → Re-index), or run ` +
        `"DELETE FROM symbols WHERE embedding IS NOT NULL" via psql to start fresh at the new dimensionality.`,
    );
  }
}

export class EmbeddingService {
  /**
   * Generates a short semantic docstring/summary for a code symbol via the
   * configured chat model. Returns "" if no LLM client or chat model is
   * configured (callers treat empty summaries as a no-op).
   */
  public static async generateSummary(
    name: string,
    filePath: string,
    signature: string,
    sourceCode: string,
  ): Promise<string> {
    const client = getChatClient();
    const model = getChatModel();
    if (!client || !model) return "";

    const prompt = `Given this function/class, write a single concise paragraph (2-4 sentences) in plain English
describing what it does, what it accepts as input, what it returns, and any important
side effects or error conditions. Do not describe implementation details unless they
are the only way to convey the function's behaviour.

Function/Class name: ${name}
File: ${filePath}
Signature: ${signature}
Source:
${sourceCode}`;

    try {
      const response = await client.chat.completions.create({
        model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2,
      });
      return response.choices?.[0]?.message?.content?.trim() || "";
    } catch (e) {
      console.error(`Failed to generate summary for ${name}:`, e);
      return "";
    }
  }

  /**
   * Generates a vector embedding for a piece of text (usually the summary)
   * via the configured embedding model. Tries each provider in the chain
   * (primary then fallback) until one succeeds.
   *
   * Returns [] when:
   *   - no text provided
   *   - the circuit breaker is open (every provider already failed this session)
   *   - no provider is configured
   *   - every provider in the chain threw
   *
   * When all providers fail, the circuit breaker trips and a single
   * console.error is emitted with a friendly remediation hint — preventing
   * the indexing service from spamming the dev log every few seconds.
   */
  public static async generateEmbedding(text: string): Promise<number[]> {
    if (!text) return [];
    if (embeddingCircuitOpen) return [];

    const chain = getEmbeddingChain();
    if (chain.length === 0) return [];

    for (const { client, model, name } of chain) {
      try {
        const response = await client.embeddings.create({ model, input: text });
        const vec = response.data?.[0]?.embedding || [];
        if (vec.length === 0) {
          // Empty-but-no-throw response is unusual but not fatal — try next.
          console.warn(`[embedding] provider ${name} returned empty vector, trying next`);
          continue;
        }
        if (vec.length !== EMBEDDING_DIM) {
          // Wrong-shape vector — persisting it would either fail at the
          // DB cast or, worse, succeed with corrupted similarity scores.
          // Try the fallback provider before giving up on this symbol.
          console.warn(
            `[embedding] provider ${name} returned ${vec.length} dimensions, ` +
              `schema requires ${EMBEDDING_DIM}. Trying next embedding provider.`,
          );
          continue;
        }
        // Shape matches the schema column — but does it match what's
        // already in the DB from a prior indexing run with a different
        // model? If not, warn once so the operator knows to re-index.
        await checkDbEmbeddingDimMismatch(vec.length, name);
        return vec;
      } catch (err: any) {
        console.warn(`[embedding] provider ${name} failed: ${(err?.message || String(err)).slice(0, 120)}`);
        continue;
      }
    }

    // Every provider failed — trip the breaker and log once.
    if (!embeddingCircuitOpen) {
      embeddingCircuitOpen = true;
      console.error(
        "[embedding] All providers failed. Further embedding calls will be skipped this session. " +
          `Configure an embedding model that returns ${EMBEDDING_DIM} dimensions ` +
          "or add a compatible cloud embedding fallback in LLM Settings, then restart the dev server.",
      );
    }
    return [];
  }

  /**
   * Test hook + recovery escape hatch: manually reset the circuit breaker.
   * Not currently called in production — the breaker auto-resets on
   * process restart. Exposed in case an admin script wants to retry
   * after a config fix without bouncing the server.
   */
  public static resetCircuitBreaker(): void {
    embeddingCircuitOpen = false;
  }

  /**
   * Test hook: reset the cached DB dim + one-shot mismatch-warning guard.
   * Production code never needs this — both reset naturally on process
   * restart. Exposed so unit tests can exercise the warning path from a
   * clean slate without re-importing the module.
   */
  public static resetDimMismatchGuard(): void {
    cachedDbEmbeddingDim = undefined;
    dimMismatchWarned = false;
  }

  /** Test hook for inspecting breaker state. */
  public static isCircuitOpen(): boolean {
    return embeddingCircuitOpen;
  }

  /**
   * Cosine similarity between two equal-length vectors. Returns 0 for
   * length-mismatched inputs (e.g., when the embedding model was swapped
   * after indexing — prevents silently wrong-but-nonzero scores).
   */
  public static cosineSimilarity(vecA: number[], vecB: number[]): number {
    if (vecA.length !== vecB.length || vecA.length === 0) return 0;
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < vecA.length; i++) {
      dotProduct += vecA[i] * vecB[i];
      normA += vecA[i] * vecA[i];
      normB += vecB[i] * vecB[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }
}
