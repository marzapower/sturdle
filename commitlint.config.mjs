// Commit types are this project's own set, not Conventional Commits' full list:
// `new` (a feature), `enh` (an improvement, refactor, docs or tests), `fix`, `chore`.
export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "type-enum": [2, "always", ["new", "enh", "fix", "chore"]],
  },
};
