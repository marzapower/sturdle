/**
 * Architecture boundary rules, run via `pnpm boundaries`
 * (`depcruise packages examples --config .dependency-cruiser.cjs`) inside `pnpm check`.
 *
 * The three published packages form a tiny DAG — engine ← postgres, ui alone — and each one
 * must stay installable on its own: no package reaches into a sibling except along that edge,
 * and none reaches into the examples.
 */
module.exports = {
  forbidden: [
    {
      name: "sturdle-engine-standalone",
      severity: "error",
      comment:
        "packages/engine imports no workspace package at all (it is the root of the Sturdle DAG).",
      from: { path: "^packages/engine/" },
      to: { path: "^(packages|examples)/", pathNot: "^packages/engine/" },
    },
    {
      name: "sturdle-postgres-imports-only-engine",
      severity: "error",
      comment: "packages/postgres may depend on packages/engine only (DAG: engine ← postgres).",
      from: { path: "^packages/postgres/" },
      to: { path: "^(packages|examples)/", pathNot: "^packages/(postgres|engine)/" },
    },
    {
      name: "sturdle-ui-standalone",
      severity: "error",
      comment: "packages/ui is presentational only: no engine, no adapter, no example imports.",
      from: { path: "^packages/ui/" },
      to: { path: "^(packages|examples)/", pathNot: "^packages/ui/" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: { path: "(^|/)(node_modules|dist|\\.next)/" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.base.json" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["sturdle-source", "import", "require", "node", "default", "types"],
      extensions: [".ts", ".tsx", ".d.ts", ".js", ".mjs", ".cjs", ".json"],
      mainFields: ["module", "main", "types"],
    },
  },
};
