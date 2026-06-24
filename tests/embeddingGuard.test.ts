import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the llmClient so we can inject fake providers returning arbitrary
// vector shapes. The mock must be set before importing EmbeddingService.
vi.mock("../src/lib/llmClient", () => ({
  getChatClient: () => null,
  getChatModel: () => null,
  getEmbeddingChain: () => [],
}));

// Re-import per test so module-level state (circuit breaker) resets.
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

beforeEach(async () => {
  vi.resetModules();
  vi.doMock("../src/lib/llmClient", () => ({
    getChatClient: () => null,
    getChatModel: () => null,
    getEmbeddingChain: () => [],
  }));
  // Reset the module-level circuit breaker between tests.
  const { EmbeddingService } = await import("../src/services/embeddingService");
  EmbeddingService.resetCircuitBreaker();
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
