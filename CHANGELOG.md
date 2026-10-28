# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.1] - 2026-10-28

### Fixed

- Documented the real install commands. `dsh plugin` is a pnpm passthrough
  (`dsh plugin --profile <name> add <spec>`) and does not select bundles, so the
  README now points at the Plugins page for the one-step install and explains
  that the CLI path still needs the bundle enabled.

## [1.0.0] - 2026-10-28

First public release.

### Added

- Mid-turn progress reminder on `tools/post-execute`: injects one
  `todo-progress-reminder` notice after the last tool result of a step when an
  incomplete todo list has gone `stepThreshold` steps or `callThreshold` calls
  without a `todo_write`. The notice repeats the current list verbatim so the
  model can update it in parallel with its next tool call.
- Turn-end auto-completion on `agent/turn-stopping`: leftover `in_progress` /
  `pending` items are written back as `completed` when a turn ends normally after
  real work.
- Config knobs `stepThreshold`, `callThreshold` and `autoCompleteOnTurnEnd`,
  validated inside the plugin so the bundle keeps zero runtime dependencies.
- Test suite (`node --test`, 13 cases) driving the plugin through a minimal Host
  stand-in, plus GitHub Actions CI.
- Chinese and English README, MIT license, bundle patch and localized Plugin
  Manager metadata (`locale/en.json`, `locale/zh.json`).

### Notes

- Boundary handling: aborted turns, queued next steps, `ask_user_question` /
  `exit_plan_mode`, already-complete lists and plan-only turns never trigger a
  write.
- Verified on DSH `0.2.0-rc.2`.
