# mend

[![make.fun bounty](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/fadliferdian74-lgtm/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/fadliferdian74-lgtm/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

**mend** is a command-line tool that applies an edit an AI model wrote to a tree of text
files. Models write edits in four formats, and mend reads them all: a unified diff (often
with wrong line numbers), SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool
calls as JSON. Every file is changed, or nothing is.

## Usage

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- The working directory is the root of the tree. Every path in a patch is relative to it.
- `PATCH` is the path of the patch file, relative to the working directory. When `PATCH`
  is absent or is `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`, `search-replace`, `v4a` or
  `json`; `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code as without it, and no
  file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

Options and `PATCH` may come in any order. `--` ends the options.

## Matching

An edit names old lines that are replaced by new lines. mend finds the old lines at the
first of three tiers at which they occur:

- **tier 0:** every line equal;
- **tier 1:** every line equal once trailing spaces and tabs are removed from both;
- **tier 2:** every line equal once leading and trailing spaces and tabs are removed from
  both — and at this tier the new lines are re-indented to match the file's own indent.

That is what rescues edits whose line numbers drifted, whose whitespace drifted, or whose
indentation does not match the file. A unified hunk takes the occurrence nearest its stated
line number; a SEARCH/REPLACE block needs exactly one occurrence; a V4A chunk takes the
first occurrence at or after its cursor (and its anchor, when it has one).

## Output and exit codes

- Exit **0**: the tree is written. One line per changed path — `A` (added), `D`
  (deleted), `M` (modified), `R old -> new` (moved) — in byte order of the paths, then
  `ok: <n> files`.
- Exit **1**: nothing is written. One `error: <code> <path>` line per failed edit, in the
  patch's order, then `failed: <k> of <n> edits`. A failed edit changes nothing, and the
  edits after it still run, so every failure is reported.
- Exit **2**: nothing is written. One line: `error: usage`, `error: no-patch`,
  `error: format`, or `error: parse <N>`.

A changed file keeps its own line break (LF or CRLF) and its final line break, except where
a unified hunk says otherwise; a created file uses LF breaks. Edits apply in the patch's
order, each seeing the tree as earlier edits left it.

## Files

- `main.ts` — the CLI. Node 22, standard library only.
- `runner.ts` — the trial runner, kept as the kit ships it.
- `check.ts` — runs `main.ts` on the kit's 100 practice checks.
- `SPEC.md` — the full specification.

## Practice score

`node check.ts <kit>/program/generator/practice.json` — **100 of 100 passed, practice
score 1000** (unified 30/30, search_replace 20/20, v4a 20/20, json 15/15, cli 15/15),
confirmed by `makefun grade-local` on practice trial 0 with a byte-for-byte replay match.

## License

MIT — see [LICENSE](LICENSE).
