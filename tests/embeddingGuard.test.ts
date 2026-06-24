import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the llmClient so we can inject fake providers returning arbitrary
// vector shapes. The mock must be set before importing EmbeddingService.
vi.mock("../src/lib/llmClient", () => ({
  getChatClient: () => null,
  getChatModel: () => null,
  getEmbeddingChain: () => [],
}));

// Mock prisma so the dim-mismatch check returns whatever the test wants
// without touching a real DB. Default: table is empty (no rows → no warning).
vi.mock("../src/lib/prisma", () => ({
  prisma: {
    $queryRaw: async () => [],
  },
}));

// Re-import per test so module-level state (circuit breaker, dim cache) resets.
async function loadFresh() {
  vi.resetModules();
  return (await import("../src/services/embeddingService")).EmbeddingService;
}

// Per-test chain override. The mock above returns [] — these tests
// reach in and swap it via re-mocking.
async function withChain(chain: any[]) {
  vi.doMock("../src/lib/llmClient", () => ({
    getChatClient: () => null,
    getChatModel: () => null,
    getEmbeddingChain: () => chain,
  }));
  return loadFresh();
}

// Per-test chain + DB-dim override. `dbDim` controls what the mismatch
// check sees in symbols.embedding — pass `null` to mean "table empty",
// a number to mean "one row at this dim", or omit for the empty default.
async function withChainAndDb(chain: any[], dbDim: number | null = null) {
  vi.doMock("../src/lib/llmClient", () => ({
    getChatClient: () => null,
    getChatModel: () => null,
    getEmbeddingChain: () => chain,
  }));
  vi.doMock("../src/lib/prisma", () => ({
    prisma: {
      $queryRaw: async () => (dbDim === null ? [] : [{ dim: dbDim }]),
    },
  }));
  return loadFresh();
}

beforeEach(async () => {
  vi.resetModules();
  vi.doMock("../src/lib/llmClient", () => ({
    getChatClient: () => null,
    getChatModel: () => null,
    getEmbeddingChain: () => [],
  }));
  vi.doMock("../src/lib/prisma", () => ({
    prisma: { $queryRaw: async () => [] },
  }));
  // Reset both module-level guards between tests.
  const { EmbeddingService } = await import("../src/services/embeddingService");
  EmbeddingService.resetCircuitBreaker();
  EmbeddingService.resetDimMismatchGuard();
});

function fakeProvider(vec: number[], name = "fake"): any {
  return {
    name,
    model: "fake-model",
    client: {
      embeddings: {
        create: async () => ({ data: [{ embedding: vec }] }),
      },
    },
  };
}

describe("embedding dimension guard", () => {
  it("passes a 1024-dim vector through unchanged", async () => {
    const EmbeddingService = await withChain([fakeProvider(new Array(1024).fill(0.1))]);
    const result = await EmbeddingService.generateEmbedding("hello");
    expect(result.length).toBe(1024);
    expect(result[0]).toBeCloseTo(0.1);
  });

  it("returns [] when provider returns wrong dim (e.g. 1536)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const EmbeddingService = await withChain([fakeProvider(new Array(1536).fill(0.2))]);
    const result = await EmbeddingService.generateEmbedding("hello");
    expect(result).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("1536 dimensions"),
    );
    warn.mockRestore();
  });

  it("tries the fallback provider when the primary returns wrong dim", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const EmbeddingService = await withChain([
      fakeProvider(new Array(768).fill(0.3), "primary"),
      fakeProvider(new Array(1024).fill(0.4), "fallback"),
    ]);
    const result = await EmbeddingService.generateEmbedding("hello");
    expect(result.length).toBe(1024);
    expect(result[0]).toBeCloseTo(0.4);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("primary returned 768 dimensions"));
    expect(EmbeddingService.isCircuitOpen()).toBe(false);
    warn.mockRestore();
  });

  it("trips the breaker when every provider returns wrong dim (no fallback rescue)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const EmbeddingService = await withChain([
      fakeProvider(new Array(768).fill(0.3), "primary"),
      fakeProvider(new Array(1536).fill(0.5), "fallback"),
    ]);
    const result = await EmbeddingService.generateEmbedding("hello");
    expect(result).toEqual([]);
    expect(EmbeddingService.isCircuitOpen()).toBe(true);
    warn.mockRestore();
    err.mockRestore();
  });

  it("still trips the breaker when the provider actually throws", async () => {
    const errProvider = {
      name: "broken",
      model: "x",
      client: { embeddings: { create: async () => { throw new Error("network down"); } } },
    };
    const EmbeddingService = await withChain([errProvider]);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await EmbeddingService.generateEmbedding("hello");
    expect(result).toEqual([]);
    expect(EmbeddingService.isCircuitOpen()).toBe(true);
    err.mockRestore();
  });

  it("returns [] on empty input", async () => {
    const EmbeddingService = await loadFresh();
    expect(await EmbeddingService.generateEmbedding("")).toEqual([]);
  });
});

describe("embedding DB dimension-mismatch warning", () => {
  it("warns once when DB has 768-dim vectors but provider returns 1024", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const EmbeddingService = await withChainAndDb(
      [fakeProvider(new Array(1024).fill(0.1), "newmodel")],
      768,
    );
    await EmbeddingService.generateEmbedding("hello");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Dimension mismatch"),
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("768-dim"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("1024-dim"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("newmodel"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("DELETE FROM symbols"));
    warn.mockRestore();
  });

  it("does not warn when DB dim matches the provider dim", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const EmbeddingService = await withChainAndDb(
      [fakeProvider(new Array(1024).fill(0.1))],
      1024,
    );
    await EmbeddingService.generateEmbedding("hello");
    expect(warn).not.toHaveBeenCalledWith(
      expect.stringContaining("Dimension mismatch"),
    );
    warn.mockRestore();
  });

  it("suppresses the warning on subsequent calls after firing once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const EmbeddingService = await withChainAndDb(
      [fakeProvider(new Array(1024).fill(0.1))],
      768,
    );
    await EmbeddingService.generateEmbedding("first");
    await EmbeddingService.generateEmbedding("second");
    await EmbeddingService.generateEmbedding("third");
    const mismatchWarnings = warn.mock.calls.filter((args) =>
      typeof args[0] === "string" && args[0].includes("Dimension mismatch"),
    );
    expect(mismatchWarnings.length).toBe(1);
    warn.mockRestore();
  });

  it("does not warn when DB has no vectors yet (fresh install)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const EmbeddingService = await withChainAndDb(
      [fakeProvider(new Array(1024).fill(0.1))],
      null, // table empty
    );
    await EmbeddingService.generateEmbedding("hello");
    expect(warn).not.toHaveBeenCalledWith(
      expect.stringContaining("Dimension mismatch"),
    );
    warn.mockRestore();
  });

  it("fails open when the DB query throws (no warning, embedding still returns)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.doMock("../src/lib/prisma", () => ({
      prisma: {
        $queryRaw: async () => {
          throw new Error("connection refused");
        },
      },
    }));
    vi.doMock("../src/lib/llmClient", () => ({
      getChatClient: () => null,
      getChatModel: () => null,
      getEmbeddingChain: () => [fakeProvider(new Array(1024).fill(0.1))],
    }));
    vi.resetModules();
    const { EmbeddingService } = await import("../src/services/embeddingService");
    const result = await EmbeddingService.generateEmbedding("hello");
    expect(result.length).toBe(1024);
    expect(warn).not.toHaveBeenCalledWith(
      expect.stringContaining("Dimension mismatch"),
    );
    warn.mockRestore();
  });
});
