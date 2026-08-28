import { describe, it, expect, vi } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  QueryLimitError,
  checkDepth,
  checkComplexity,
  computeComplexity,
  documentDepth,
  enforceQueryLimits,
  loadGraphqlLimits,
} = require("./graphql-depth-limit.js");

function queryDoc(selections: unknown[]) {
  return {
    definitions: [
      {
        kind: "OperationDefinition",
        operation: "query",
        selectionSet: { selections },
      },
    ],
  };
}

function field(name: string, children?: unknown[], args?: unknown[]) {
  const sel: Record<string, unknown> = { kind: "Field", name: { kind: "Name", value: name } };
  if (args) sel.arguments = args;
  if (children) sel.selectionSet = { selections: children };
  return sel;
}

function intArg(name: string, value: number) {
  return {
    name: { kind: "Name", value: name },
    value: { kind: "IntValue", value: String(value) },
  };
}

function varArg(name: string, variable: string) {
  return {
    name: { kind: "Name", value: name },
    value: { kind: "Variable", name: { kind: "Name", value: variable } },
  };
}

function nest(levels: number): unknown[] {
  if (levels <= 0) return [field("leaf")];
  return [field(`n${levels}`, nest(levels - 1))];
}

describe("documentDepth", () => {
  it("counts nested selection sets and ignores leaf fields", () => {
    const doc = queryDoc([field("a", [field("b", [field("c")])])]);
    expect(documentDepth(doc)).toBe(2);
  });

  it("returns 0 for a flat query", () => {
    const doc = queryDoc([field("schedule"), field("claimableAmount")]);
    expect(documentDepth(doc)).toBe(0);
  });
});

describe("checkDepth", () => {
  it("allows queries at or under the limit", () => {
    const allowed = queryDoc(nest(5));
    expect(documentDepth(allowed)).toBe(5);
    expect(checkDepth(allowed, 5)).toBe(5);
  });

  it("rejects queries deeper than the limit", () => {
    const tooDeep = queryDoc(nest(6));
    expect(documentDepth(tooDeep)).toBe(6);
    expect(() => checkDepth(tooDeep, 5)).toThrow(QueryLimitError);
    try {
      checkDepth(tooDeep, 5);
    } catch (err) {
      expect(err).toBeInstanceOf(QueryLimitError);
      const qe = err as InstanceType<typeof QueryLimitError>;
      expect(qe.statusCode).toBe(400);
      expect(qe.code).toBe("DEPTH_EXCEEDED");
      expect(qe.message).toMatch(/depth 6 exceeds maximum allowed depth of 5/);
    }
  });
});

describe("computeComplexity", () => {
  it("charges 1 per field", () => {
    const doc = queryDoc([
      field("schedule", [field("recipient"), field("sponsor"), field("token")]),
    ]);
    expect(computeComplexity(doc)).toBe(4);
  });

  it("charges n for list fields and multiplies nested cost by n", () => {
    const doc = queryDoc([
      field("streams", [field("id"), field("recipient")], [intArg("first", 10)]),
    ]);
    expect(computeComplexity(doc)).toBe(30);
  });

  it("resolves list size from GraphQL variables", () => {
    const doc = queryDoc([
      field("streams", [field("id")], [varArg("limit", "n")]),
    ]);
    expect(computeComplexity(doc, { n: 5 })).toBe(5 + 5 * 1);
  });
});

describe("checkComplexity", () => {
  it("allows queries at or under the budget", () => {
    const fields = Array.from({ length: 50 }, (_, i) => field(`f${i}`));
    const doc = queryDoc(fields);
    expect(computeComplexity(doc)).toBe(50);
    expect(checkComplexity(doc, 100)).toBe(50);
  });

  it("rejects queries over the budget", () => {
    const fields = Array.from({ length: 101 }, (_, i) => field(`f${i}`));
    const doc = queryDoc(fields);
    expect(computeComplexity(doc)).toBe(101);
    expect(() => checkComplexity(doc, 100)).toThrow(QueryLimitError);
    try {
      checkComplexity(doc, 100);
    } catch (err) {
      const qe = err as InstanceType<typeof QueryLimitError>;
      expect(qe.statusCode).toBe(400);
      expect(qe.code).toBe("COMPLEXITY_EXCEEDED");
      expect(qe.complexity).toBe(101);
      expect(qe.message).toMatch(/complexity 101 exceeds maximum allowed complexity of 100/);
    }
  });
});

describe("enforceQueryLimits", () => {
  it("returns scores for an allowed query", () => {
    const doc = queryDoc([field("schedule", [field("recipient")])]);
    expect(enforceQueryLimits(doc, { maxDepth: 5, maxComplexity: 100 })).toEqual({
      depth: 1,
      complexity: 2,
    });
  });

  it("logs depth-exceeded rejections at warn with complexity score", () => {
    const logger = { warn: vi.fn() };
    const tooDeep = queryDoc(nest(6));
    expect(() =>
      enforceQueryLimits(tooDeep, {
        maxDepth: 5,
        maxComplexity: 100,
        logger,
        query: "{ n6 { n5 { n4 { n3 { n2 { n1 { leaf } } } } } } }",
      }),
    ).toThrow(/depth 6 exceeds/);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [payload, message] = logger.warn.mock.calls[0];
    expect(payload.code).toBe("DEPTH_EXCEEDED");
    expect(payload.depth).toBe(6);
    expect(typeof payload.complexity).toBe("number");
    expect(payload.complexity).toBeGreaterThan(0);
    expect(message).toMatch(/GraphQL query rejected/);
  });

  it("logs complexity-exceeded rejections at warn with complexity score", () => {
    const logger = { warn: vi.fn() };
    const wide = queryDoc(Array.from({ length: 101 }, (_, i) => field(`f${i}`)));
    expect(() =>
      enforceQueryLimits(wide, { maxDepth: 5, maxComplexity: 100, logger }),
    ).toThrow(/complexity 101 exceeds/);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [payload] = logger.warn.mock.calls[0];
    expect(payload.code).toBe("COMPLEXITY_EXCEEDED");
    expect(payload.complexity).toBe(101);
    expect(payload.maxComplexity).toBe(100);
  });
});

describe("loadGraphqlLimits", () => {
  it("defaults to depth 5 and complexity 100", () => {
    expect(loadGraphqlLimits({})).toEqual({ maxDepth: 5, maxComplexity: 100 });
  });

  it("reads GRAPHQL_MAX_DEPTH and GRAPHQL_MAX_COMPLEXITY", () => {
    expect(
      loadGraphqlLimits({ GRAPHQL_MAX_DEPTH: "8", GRAPHQL_MAX_COMPLEXITY: "250" }),
    ).toEqual({ maxDepth: 8, maxComplexity: 250 });
  });
});
