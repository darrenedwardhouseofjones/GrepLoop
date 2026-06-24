import { describe, it, expect } from "vitest";
import { parseFileSymbols as tsParse } from "../../src/services/indexing/tsParser";

const REPO_ID = "test-repo";

/**
 * Correctness + regression tests for the tree-sitter TS/JS parser.
 *
 * Coverage:
 *   1. Correctness — does the parser extract what's actually there?
 *   2. Stability — same input → same output across re-parses?
 *   3. Regression guards — explicit tests for the bugs the previous
 *      regex parser had (phantom symbols from comments, control-flow
 *      keywords matched as calls, brace-counting drift on template
 *      literals, private methods missed entirely).
 *
 * Fixtures live inline (no fs reads) so the tests run anywhere.
 */

describe("tsParser — symbol extraction", () => {
  it("extracts a named function declaration with correct line range", async () => {
    const src = `
function foo() {
  return 1;
}
`.trim();

    const result = await tsParse(REPO_ID, "test.ts", src);
    expect(result.symbols).toHaveLength(1);
    expect(result.symbols[0]).toMatchObject({
      name: "foo",
      kind: "function",
      lineStart: 1,
      lineEnd: 3,
    });
  });

  it("extracts async functions", async () => {
    const src = `async function fetchThing() { return await fetch("/"); }`;
    const result = await tsParse(REPO_ID, "test.ts", src);
    expect(result.symbols).toHaveLength(1);
    expect(result.symbols[0]).toMatchObject({ name: "fetchThing", kind: "function" });
  });

  it("extracts TypeScript generics without dropping the function", async () => {
    const src = `function identity<T>(x: T): T { return x; }`;
    const result = await tsParse(REPO_ID, "test.ts", src);
    expect(result.symbols).toHaveLength(1);
    expect(result.symbols[0]).toMatchObject({ name: "identity", kind: "function" });
  });

  it("extracts class declarations", async () => {
    const src = `
class Foo {
  constructor() {}
}
`.trim();

    const result = await tsParse(REPO_ID, "test.ts", src);
    const cls = result.symbols.find((s) => s.kind === "class");
    expect(cls).toMatchObject({ name: "Foo", lineStart: 1, lineEnd: 3 });
  });

  it("extracts methods including private (#name) and static", async () => {
    const src = `
class Service {
  public handler() {}
  protected check() {}
  private secret() {}
  static of() {}
  #privateMethod() {}
}
`.trim();

    const result = await tsParse(REPO_ID, "test.ts", src);
    const methodNames = result.symbols
      .filter((s) => s.kind === "method")
      .map((s) => s.name)
      .sort();
    // Note: #privateMethod keeps the # prefix — JS treats #foo and foo as
    // distinct identifiers, and call sites like this.#foo() carry the #
    // in their property_identifier text too, so graph resolution matches.
    expect(methodNames).toEqual(
      ["#privateMethod", "check", "handler", "of", "secret"].sort(),
    );
  });

  it("extracts arrow functions assigned to const", async () => {
    const src = `
const add = (a: number, b: number) => a + b;
const asyncWork = async () => { await fetch("/"); };
`.trim();

    const result = await tsParse(REPO_ID, "test.ts", src);
    const arrowNames = result.symbols.map((s) => s.name).sort();
    expect(arrowNames).toEqual(["add", "asyncWork"]);
  });

  it("extracts function_expression assigned to const", async () => {
    const src = `const fn = function named() { return 1; };`;
    const result = await tsParse(REPO_ID, "test.ts", src);
    expect(result.symbols).toHaveLength(1);
    expect(result.symbols[0]).toMatchObject({ name: "fn", kind: "function" });
  });

  it("does NOT miscategorize module-scope functions as methods", async () => {
    // The regex parser would tag `helper` as a "method" because it
    // appeared after a class declaration in the same file, even though
    // it's outside the class body. Tree-sitter gets this right.
    const src = `
class Bar {}
function helper() {}
`.trim();

    const result = await tsParse(REPO_ID, "test.ts", src);
    const helper = result.symbols.find((s) => s.name === "helper");
    expect(helper?.kind).toBe("function");
  });

  it("handles JSX/TSX correctly via the tsx grammar", async () => {
    const src = `
function Card(props: { name: string }) {
  return <div>{props.name}</div>;
}
`.trim();

    const result = await tsParse(REPO_ID, "Card.tsx", src);
    expect(result.symbols).toHaveLength(1);
    expect(result.symbols[0]).toMatchObject({ name: "Card", kind: "function" });
  });

  it("returns correct lineEnd for multi-line function bodies (no brace-counting drift)", async () => {
    // The regex parser's brace counter miscounts when the body contains
    // template literals with `{` inside. Tree-sitter gives exact ranges.
    const src = `
function greet(name: string) {
  const msg = \`Hello \${name}! You have \${5} new messages.\`;
  return msg;
}
`.trim();

    const result = await tsParse(REPO_ID, "test.ts", src);
    expect(result.symbols[0]).toMatchObject({ lineStart: 1, lineEnd: 4 });
  });

  it("ignores commented-out function declarations", async () => {
    // `// function fake() {` would fool the regex parser into extracting
    // a phantom symbol. Tree-sitter parses comments as comment nodes.
    const src = `
// function fake() {
function real() {}
`.trim();

    const result = await tsParse(REPO_ID, "test.ts", src);
    const names = result.symbols.map((s) => s.name);
    expect(names).toEqual(["real"]);
    expect(names).not.toContain("fake");
  });
});

describe("tsParser — call extraction", () => {
  it("extracts bare function calls with correct enclosing symbol", async () => {
    const src = `
function outer() {
  inner();
}
function inner() {}
`.trim();

    const result = await tsParse(REPO_ID, "test.ts", src);
    const innerCall = result.rawCalls.find((c) => c.toRaw === "inner");
    expect(innerCall).toMatchObject({ fromSymbolName: "outer", line: 2 });
  });

  it("extracts method calls (foo.bar())", async () => {
    const src = `
function handler(svc: Service) {
  svc.process();
}
`.trim();

    const result = await tsParse(REPO_ID, "test.ts", src);
    const call = result.rawCalls.find((c) => c.toRaw === "process");
    expect(call).toMatchObject({ fromSymbolName: "handler" });
  });

  it("does NOT extract control-flow keywords as calls", async () => {
    // The regex parser would happily match `if (`, `for (`, `switch (`
    // because they look like calls to a function named `if`/`for`/`switch`.
    const src = `
function run(items: number[]) {
  if (items.length > 0) {
    for (const x of items) {
      while (x > 0) {}
    }
    switch (x) {
      case 1: break;
    }
  }
}
`.trim();

    const result = await tsParse(REPO_ID, "test.ts", src);
    const phantomCallees = result.rawCalls
      .map((c) => c.toRaw)
      .filter((n) => ["if", "for", "while", "switch", "case"].includes(n));
    expect(phantomCallees).toEqual([]);
  });

  it("attributes calls inside methods to the method, not the class", async () => {
    const src = `
class Service {
  handle() {
    this.process();
  }
}
`.trim();

    const result = await tsParse(REPO_ID, "test.ts", src);
    const call = result.rawCalls.find((c) => c.toRaw === "process");
    expect(call?.fromSymbolName).toBe("handle");
  });

  it("drops module-top-level calls (no enclosing symbol)", async () => {
    const src = `
configure({ debug: true });
function main() {}
`.trim();

    const result = await tsParse(REPO_ID, "test.ts", src);
    expect(result.rawCalls).toEqual([]);
  });
});

describe("tsParser — stability", () => {
  it("produces identical output across two parses of the same input", async () => {
    const src = `
class Foo {
  bar() {
    return this.baz();
  }
  baz() { return 1; }
}
const main = () => new Foo().bar();
`.trim();

    const a = await tsParse(REPO_ID, "test.ts", src);
    const b = await tsParse(REPO_ID, "test.ts", src);

    expect(b.symbols).toEqual(a.symbols);
    expect(b.rawCalls).toEqual(a.rawCalls);
  });

  it("produces stable sourceHash values (drives incremental indexing)", async () => {
    const src = `function stable() { return 1; }`;
    const a = await tsParse(REPO_ID, "test.ts", src);
    const b = await tsParse(REPO_ID, "test.ts", src);
    expect(a.symbols[0].sourceHash).toEqual(b.symbols[0].sourceHash);
  });
});

describe("tsParser — regression guards for known regex-parser bugs", () => {
  // The previous regex parser had four classes of bugs that tree-sitter
  // eliminates by construction. These tests make the upgrade concrete
  // and would catch any future regression to a regex-based approach.

  it("does not extract phantom symbols from comments", async () => {
    // The regex parser matched `function fake() {` even inside a `//`
    // comment, producing a phantom symbol. Tree-sitter parses comments
    // as comment nodes and never confuses them with declarations.
    const src = `
// function fake() {
/* function anotherFake() { */
function real() {}
`.trim();

    const result = await tsParse(REPO_ID, "test.ts", src);
    expect(result.symbols.map((s) => s.name)).toEqual(["real"]);
  });

  it("does not match control-flow keywords as call sites", async () => {
    // The regex parser's `matchAll(name\\()` happily matched `if (`,
    // `for (`, `switch (` because they look syntactically like calls.
    const src = `
function run(items: number[]) {
  if (items.length > 0) {
    for (const x of items) {
      while (x > 0) {}
    }
    switch (x) {
      case 1: break;
    }
  }
}
`.trim();

    const result = await tsParse(REPO_ID, "test.ts", src);
    const phantomCallees = result.rawCalls
      .map((c) => c.toRaw)
      .filter((n) => ["if", "for", "while", "switch", "case"].includes(n));
    expect(phantomCallees).toEqual([]);
  });

  it("computes correct lineEnd when the body contains template literals with braces", async () => {
    // The regex parser's brace counter treated `${}` in template literals
    // as block delimiters, producing wrong lineEnd values. Tree-sitter
    // parses template literals correctly and gives exact ranges.
    const src = `
function greet(name: string) {
  const msg = \`Hello \${name}! You have \${5} new messages.\`;
  return msg;
}
`.trim();

    const result = await tsParse(REPO_ID, "test.ts", src);
    expect(result.symbols[0]).toMatchObject({ lineStart: 1, lineEnd: 4 });
  });

  it("extracts private methods (the regex parser missed #name entirely)", async () => {
    const src = `
class Service {
  #privateMethod() {}
  regular() {}
}
`.trim();

    const result = await tsParse(REPO_ID, "test.ts", src);
    expect(result.symbols.map((s) => s.name)).toContain("#privateMethod");
    expect(result.symbols.map((s) => s.name)).toContain("regular");
  });
});
