import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const validEnv: NodeJS.ProcessEnv = {
  HORIZON_URL: "https://horizon-testnet.stellar.org",
  NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
  VESTING_CONTRACT_ID: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  DATABASE_URL: "postgres://user:pass@localhost:5432/vesting",
  REDIS_URL: "redis://localhost:6379",
  WEBHOOK_SECRET: "super-secret-value-1234",
  JWT_SECRET: "a-very-long-jwt-secret-that-is-at-least-32-chars",
};

// config.ts parses process.env at import time — seed required vars first.
Object.assign(process.env, validEnv);

const { parseConfig } = await import("./config");

let exitSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as typeof process.exit);
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  exitSpy.mockRestore();
  stderrSpy.mockRestore();
});

describe("GraphQL limits in parseConfig", () => {
  it("defaults to depth 5 and complexity 100", () => {
    const cfg = parseConfig(validEnv);
    expect(cfg.graphqlMaxDepth).toBe(5);
    expect(cfg.graphqlMaxComplexity).toBe(100);
  });

  it("reads GRAPHQL_MAX_DEPTH and GRAPHQL_MAX_COMPLEXITY", () => {
    const cfg = parseConfig({
      ...validEnv,
      GRAPHQL_MAX_DEPTH: "8",
      GRAPHQL_MAX_COMPLEXITY: "250",
    });
    expect(cfg.graphqlMaxDepth).toBe(8);
    expect(cfg.graphqlMaxComplexity).toBe(250);
  });

  it("rejects non-positive GraphQL limits", () => {
    expect(() => parseConfig({ ...validEnv, GRAPHQL_MAX_DEPTH: "0" })).toThrow();
    expect(() => parseConfig({ ...validEnv, GRAPHQL_MAX_COMPLEXITY: "-1" })).toThrow();
  });
});
