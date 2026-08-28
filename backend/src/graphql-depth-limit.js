"use strict";

/**
 * GraphQL query depth + complexity guards.
 *
 * Depth
 *   Number of nested selection sets along the deepest path. Matches the
 *   original scaffold: a leaf field does not increment depth.
 *
 * Complexity
 *   Each field costs 1. A field that looks like a list (it carries a
 *   first/last/limit/n/count/take/pageSize argument) costs `n` and multiplies
 *   the cost of its nested selections by `n`. That models the DB fan-out of
 *   "fetch n rows, then resolve children for each row".
 *
 * Both checks run before resolvers. Violations throw QueryLimitError.
 */

const LIST_SIZE_ARG_NAMES = new Set([
  "first",
  "last",
  "limit",
  "n",
  "count",
  "take",
  "pageSize",
]);

class QueryLimitError extends Error {
  /**
   * @param {string} message
   * @param {{ code: string, depth: number, complexity: number, maxDepth: number, maxComplexity: number }} details
   */
  constructor(message, details) {
    super(message);
    this.name = "QueryLimitError";
    this.statusCode = 400;
    this.code = details.code;
    this.depth = details.depth;
    this.complexity = details.complexity;
    this.maxDepth = details.maxDepth;
    this.maxComplexity = details.maxComplexity;
  }
}

function fieldName(sel) {
  return sel?.name?.value ?? sel?.name ?? null;
}

function isField(sel) {
  if (!sel) return false;
  if (sel.kind === "Field") return true;
  if (sel.kind === "FragmentSpread" || sel.kind === "InlineFragment") return false;
  return Boolean(sel.name) && sel.kind !== "FragmentDefinition";
}

function isFragmentSpread(sel) {
  return sel?.kind === "FragmentSpread";
}

function isInlineFragment(sel) {
  return sel?.kind === "InlineFragment" || (sel?.selectionSet && !sel.name && sel.kind !== "Field");
}

function collectFragments(document) {
  const fragments = Object.create(null);
  for (const def of document.definitions ?? []) {
    if (def.kind === "FragmentDefinition" || def.selectionSet && def.name && def.typeCondition) {
      const name = fieldName(def);
      if (name) fragments[name] = def;
    }
  }
  return fragments;
}

function operationDefinitions(document) {
  return (document.definitions ?? []).filter((def) => {
    if (def.kind === "OperationDefinition") return true;
    if (def.kind === "FragmentDefinition") return false;
    return Boolean(def.selectionSet) && !def.typeCondition;
  });
}

function resolveArgValue(arg, variables) {
  const value = arg?.value;
  if (value == null) return null;
  if (typeof value === "number") return value;
  const kind = value.kind;
  if (kind === "IntValue" || kind === "int") {
    const n = Number.parseInt(value.value, 10);
    return Number.isFinite(n) ? n : null;
  }
  if (kind === "Variable" || kind === "variable") {
    const name = value.name?.value ?? value.name;
    const raw = variables?.[name];
    if (typeof raw === "number" && Number.isFinite(raw)) return raw;
    if (typeof raw === "string" && /^-?\d+$/.test(raw)) return Number.parseInt(raw, 10);
  }
  return null;
}

function listMultiplier(field, variables) {
  const args = field.arguments ?? field.args ?? [];
  for (const arg of args) {
    const name = arg.name?.value ?? arg.name;
    if (!LIST_SIZE_ARG_NAMES.has(name)) continue;
    const n = resolveArgValue(arg, variables);
    if (n == null) continue;
    return Math.max(0, n);
  }
  return null;
}

function selectionDepth(selections, fragments, visiting) {
  let max = 0;
  for (const sel of selections ?? []) {
    if (isFragmentSpread(sel)) {
      const name = fieldName(sel);
      if (!name || visiting.has(name)) continue;
      const frag = fragments[name];
      if (!frag?.selectionSet) continue;
      visiting.add(name);
      const d = selectionDepth(frag.selectionSet.selections, fragments, visiting);
      visiting.delete(name);
      if (d > max) max = d;
      continue;
    }
    if (isInlineFragment(sel) && sel.selectionSet) {
      const d = selectionDepth(sel.selectionSet.selections, fragments, visiting);
      if (d > max) max = d;
      continue;
    }
    if (sel.selectionSet) {
      const d = 1 + selectionDepth(sel.selectionSet.selections, fragments, visiting);
      if (d > max) max = d;
    }
  }
  return max;
}

function documentDepth(document) {
  const fragments = collectFragments(document);
  let max = 0;
  for (const def of operationDefinitions(document)) {
    const d = selectionDepth(def.selectionSet.selections, fragments, new Set());
    if (d > max) max = d;
  }
  return max;
}

function checkDepth(document, maxDepth) {
  const depth = documentDepth(document);
  if (depth > maxDepth) {
    throw new QueryLimitError(
      `Query depth ${depth} exceeds maximum allowed depth of ${maxDepth}`,
      {
        code: "DEPTH_EXCEEDED",
        depth,
        complexity: computeComplexity(document),
        maxDepth,
        maxComplexity: Infinity,
      },
    );
  }
  return depth;
}

function scoreSelections(selections, fragments, variables, visiting) {
  let cost = 0;
  for (const sel of selections ?? []) {
    if (isFragmentSpread(sel)) {
      const name = fieldName(sel);
      if (!name || visiting.has(name)) continue;
      const frag = fragments[name];
      if (!frag?.selectionSet) continue;
      visiting.add(name);
      cost += scoreSelections(frag.selectionSet.selections, fragments, variables, visiting);
      visiting.delete(name);
      continue;
    }
    if (isInlineFragment(sel) && sel.selectionSet) {
      cost += scoreSelections(sel.selectionSet.selections, fragments, variables, visiting);
      continue;
    }
    if (!isField(sel) && !sel.selectionSet) continue;

    const childCost = sel.selectionSet
      ? scoreSelections(sel.selectionSet.selections, fragments, variables, visiting)
      : 0;
    const n = listMultiplier(sel, variables);
    if (n == null) {
      cost += 1 + childCost;
    } else {
      cost += n + n * childCost;
    }
  }
  return cost;
}

function computeComplexity(document, variables = {}) {
  const fragments = collectFragments(document);
  let total = 0;
  for (const def of operationDefinitions(document)) {
    total += scoreSelections(def.selectionSet.selections, fragments, variables, new Set());
  }
  return total;
}

function checkComplexity(document, maxComplexity, variables = {}) {
  const complexity = computeComplexity(document, variables);
  if (complexity > maxComplexity) {
    throw new QueryLimitError(
      `Query complexity ${complexity} exceeds maximum allowed complexity of ${maxComplexity}`,
      {
        code: "COMPLEXITY_EXCEEDED",
        depth: documentDepth(document),
        complexity,
        maxDepth: Infinity,
        maxComplexity,
      },
    );
  }
  return complexity;
}

function enforceQueryLimits(document, options = {}) {
  const maxDepth = options.maxDepth ?? 5;
  const maxComplexity = options.maxComplexity ?? 100;
  const variables = options.variables ?? {};
  const logger = options.logger;

  const depth = documentDepth(document);
  const complexity = computeComplexity(document, variables);

  const exceededDepth = depth > maxDepth;
  const exceededComplexity = complexity > maxComplexity;

  if (exceededDepth || exceededComplexity) {
    const code = exceededDepth ? "DEPTH_EXCEEDED" : "COMPLEXITY_EXCEEDED";
    const message = exceededDepth
      ? `Query depth ${depth} exceeds maximum allowed depth of ${maxDepth}`
      : `Query complexity ${complexity} exceeds maximum allowed complexity of ${maxComplexity}`;

    if (logger && typeof logger.warn === "function") {
      logger.warn(
        {
          code,
          complexity,
          depth,
          maxDepth,
          maxComplexity,
          query: typeof options.query === "string" ? options.query.slice(0, 500) : undefined,
        },
        `GraphQL query rejected: ${message}`,
      );
    }

    throw new QueryLimitError(message, {
      code,
      depth,
      complexity,
      maxDepth,
      maxComplexity,
    });
  }

  return { depth, complexity };
}

function loadGraphqlLimits(env = process.env) {
  const maxDepth = Number.parseInt(env.GRAPHQL_MAX_DEPTH ?? "5", 10);
  const maxComplexity = Number.parseInt(env.GRAPHQL_MAX_COMPLEXITY ?? "100", 10);
  return {
    maxDepth: Number.isFinite(maxDepth) && maxDepth > 0 ? maxDepth : 5,
    maxComplexity: Number.isFinite(maxComplexity) && maxComplexity > 0 ? maxComplexity : 100,
  };
}

module.exports = {
  QueryLimitError,
  checkDepth,
  checkComplexity,
  computeComplexity,
  documentDepth,
  enforceQueryLimits,
  loadGraphqlLimits,
};
