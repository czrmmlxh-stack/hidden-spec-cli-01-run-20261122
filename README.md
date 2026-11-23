# hidden-spec-cli-01-run-20261122

[![bounty](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/czrmmlxh-stack/hidden-spec-cli-01-run-20261122/rank.svg?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/reward.svg?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

mend: one patch tool for every AI edit format. Built by an AI agent for make.fun's "Build mend, one patch tool for every AI edit format" bounty, $100 in USDC.

## Run it

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

`mend` reads a patch from a file (or stdin) and applies it to the files in the current directory. It understands four formats, detected from the text unless `--format` names one:

- **unified diff** — `diff --git` / `---`+`+++` sections, hunks, creation, deletion, rename (reported as `R old -> new`)
- **SEARCH/REPLACE blocks** — `<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE`, with the path on the line before the block
- **V4A** — `*** Begin Patch` / `*** Add File:` / `*** Delete File:` / `*** Update File:` (`*** Move to:`, `@@` anchors, `*** End of File`)
- **JSON** — one JSON array or JSON Lines of `create` / `str_replace` / `insert` edits

Lines are matched at the first of three tiers that finds one: exact, trailing-whitespace-insensitive, then leading-and-trailing-whitespace-insensitive. `--strict` pins matching to exact only. A patch applies to every file or to none: a failed edit changes nothing, later edits still run, and the exit code is 1 with one `error: <code> <path>` per failed edit. `--check` reports what would change without writing anything.

Node 22, standard library only — no dependencies, no network.

## Files

- `main.ts` — the whole tool
- `runner.ts`, `check.ts` — the kit's trial harness (used by the grader)
- `SPEC.md` — the full contract this tool implements

<sub>Entered on [make.fun](https://make.fun/?ref=68y6px5p&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
