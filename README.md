# mend: one patch tool for every AI edit format

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Goresalink/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Goresalink/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

`mend` applies an edit that an AI model wrote to a tree of text files. Models write edits in four formats — a unified diff (often with wrong line numbers), SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as JSON — and `mend` reads all four to one written specification, `SPEC.md`. It finds the lines an edit names even when the model drifted their whitespace or indentation, and changes every file or none (atomic). by bang ndien

## Run it

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- `PATCH` is the patch file, relative to the working directory (the root of the tree). When it is absent or `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`, `search-replace`, `v4a` or `json`; `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code, and no file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

Exit codes: `0` when the tree is written (one line per changed path, then `ok: N files`), `1` when an edit failed (one `error: <code> <path>` line per failed edit, then `failed: K of N edits`; no file is written), `2` on a usage, missing-patch, format or parse error (exactly one `error:` line). Standard error is never compared.

Matching works at three tiers: exact lines, then lines equal once trailing spaces and tabs are removed, then lines equal once leading and trailing spaces and tabs are removed. Unified hunks take the occurrence nearest the (possibly wrong) line number they name; SEARCH/REPLACE blocks fail as `ambiguous` when the old lines occur more than once at their tier; V4A chunks walk a cursor through the file with anchors. Files keep their own line break (CRLF or LF) and their final line break, unless the patch says otherwise.

## The files

- `main.ts`: the CLI, Node 22 and its standard library alone. When `MAKEFUN_ENV_URL` is set it hands the trial over to `runner.ts` instead of running as a CLI.
- `runner.ts`: the kit's runner, kept as it is. In a trial it reads the checks from the env, runs `node main.ts` on each one in a fresh directory, and posts what it did.
- `check.ts`: the practice set on your own machine:

      node check.ts ../program/generator/practice.json
      node check.ts ../program/generator/practice.json u-offset s-basic

  It prints every check the program gets wrong, with what differed, and the practice score. This entry scores 1000 (100 of 100) on the public practice set, and passes 62 hand-computed edge cases from `SPEC.md` on top of that.

- `SPEC.md`: the whole specification.

## Practice

```
node check.ts <path to the kit's program/generator/practice.json>
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=mrxdrtaw&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
