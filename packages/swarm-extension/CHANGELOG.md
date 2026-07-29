# Changelog

## [Unreleased]

### Added

- Added named workflow discovery: `my-workflow` resolves to `~/.omp/agent/swarms/my-workflow.yaml` with `${VAR}` substitution (`PROJECT_DIR`, `WORKFLOW_NAME`); `discoverSwarmYaml` accepts `homeOverride` for test isolation so tests never touch `~/.omp`
- Added gate mechanism (§6.2/§7.1): declared `gate:` blocks in agent YAML pause the pipeline after a wave and wait for a human response file (`gate-response-<agent>.json`); ambient scan picks up `pending-question-<agent>.md` files written by agents mid-execution
- Added per-agent workspace subdirectories: agents can declare `workspace:` relative to the swarm workspace, enabling multi-workspace swarms
- Added headless CLI runner (`cli.ts`): `omp-swarm <workflow-name> [--project DIR] [--name NAME] [--from AGENT]` executes a swarm pipeline outside the TUI

### Fixed

- Fixed gate poll loop using `setTimeout` instead of `Bun.sleep` (AGENTS.md convention)
- Fixed `discovery.ts` using `process.env.HOME ?? ""` instead of `os.homedir()`; discovery tests no longer write fixtures into real `~/.omp/agent/swarms/`
- Fixed `writeGateFile` not clearing a stale `gate-response-<agent>.json` before opening a new gate, causing second and subsequent gates on the same agent to resolve instantly with an old response
- Fixed `on_timeout: fail` gate timeout not aborting the pipeline: `waitForGateResponse` returned `{ decision: "fail" }` but the pipeline continued unconditionally; now throws so `run()`'s catch sets `status: "failed"` and downstream waves are not executed
- Fixed answered ambient `pending-question-<agent>.md` files persisting on disk across iterations, causing the same question to re-fire every iteration when `target_count > 1`

## [16.3.7] - 2026-07-05

### Fixed

- Fixed the peer dependency range for @oh-my-pi/pi-coding-agent to match the current ^16 major version.

## [15.9.0] - 2026-06-04

### Fixed

- Fixed swarm `/swarm run` failing with authStorage/modelRegistry identity error ([#1472](https://github.com/can1357/oh-my-pi/issues/1472))
