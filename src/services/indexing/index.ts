/**
 * Barrel re-export for the indexing pipeline. Callers should import from
 * `@/src/services/indexing` (or the back-compat shim at
 * `@/src/services/indexingService`).
 *
 * Internal layout:
 *   types.ts              — shared interfaces
 *   indexOrchestrator.ts  — IndexingService class (orchestrates a run)
 *   graphBuilder.ts       — resolves raw calls → edge rows
 *   incrementalUpdater.ts — file diff against existing rows
 *   tsParser.ts           — tree-sitter TS/JS parser (.ts/.tsx/.js/.jsx)
 */

export { IndexingService } from "./indexOrchestrator";
export type { IndexRunResult } from "./indexOrchestrator";
export type {
  SymbolNode,
  EdgeNode,
  RawCall,
  ParsedFile,
  FileOnDisk,
  FileDiff,
  SymbolKind,
  EdgeKind,
} from "./types";
