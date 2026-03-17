# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.3] - 2026-03-17

### Added
- **Session-scoped task storage** — new `taskScope` config with three modes: `memory` (in-memory only), `session` (per-session file, default), `project` (shared across sessions). Session mode uses `tasks-<sessionId>.json`, surviving session resume while keeping sessions isolated.
- **Session resume support** — `session_switch` event handler reloads persisted tasks on resume without auto-clearing completed tasks (user may want to review).
- **Session file cleanup** — empty session task files are automatically deleted when all tasks are cleared, preventing stale file accumulation.
- **"Clear all" in `/tasks` menu** — wipe all tasks regardless of status, not just completed ones.

### Changed
- **Unified storage setting** — replaced `persistTasks` (boolean) with a single `taskScope: "memory" | "session" | "project"` setting. The `persistTasks` field is no longer recognized.
- **Auto-clear completed on new session start** — when all persisted tasks are completed, they are silently cleared instead of showing stale completed work. On resume, completed tasks are preserved.
- **Widget only shows on start if there's unfinished work** — sessions with only completed tasks start with a clean slate.
- **Settings moved to last position** in `/tasks` menu for better UX (actions first, config last).

### Fixed
- **Robust session store upgrade** — store upgrade from in-memory to file-backed triggers on `turn_start`, `before_agent_start`, `session_switch`, and `tool_execution_start` — whichever fires first.

## [0.3.2] - 2026-03-17

### Fixed
- **Completed tasks no longer vanish from the list** — completed tasks are now persisted to disk so they survive reloads and show as strikethrough instead of disappearing. Use "Clear completed" in `/tasks` to explicitly remove them.

## [0.3.1] - 2026-03-16

### Added
- **Local-by-default task persistence** — tasks now auto-persist to `<cwd>/.pi/tasks/tasks.json` on every mutation and reload on restart. No config needed. Set `PI_TASKS=off` to opt out (CI/automation).
- **Settings persistence** — `persistTasks` and `autoCascade` settings survive restarts via `<cwd>/.pi/tasks-config.json`.
- **"Persist tasks" toggle in Settings** — `/tasks` → Settings now shows two toggles: auto-execute and persist. Both are saved immediately to `tasks-config.json`.
- **Completed tasks excluded from disk** — only `pending` and `in_progress` tasks are written to disk. Completed tasks are in-memory only and pruned on restart. *(Reverted in 0.3.2 — completed tasks are now persisted.)*
- **Absolute path support** — `TaskStore` now accepts an absolute file path in addition to a short list ID.

### Changed
- **⚠ BREAKING: `PI_TASKS_FILE` / `PI_TASKS_LIST` → `PI_TASKS`** — two env vars consolidated into one. Values: `off` (in-memory), `sprint-1` (named list → `~/.pi/tasks/sprint-1.json`), `/abs/path` (absolute), `./rel/path` (relative to cwd). `PI_TASKS_LIST=name` users: rename to `PI_TASKS=name`.
- **Settings menu** — extracted to `src/ui/settings-menu.ts` and rebuilt using `ui.custom()` + `SettingsList` for native TUI rendering: keyboard navigation, live toggle, per-row descriptions, theme-consistent styling.
- **`autoCascade` setting** — now loaded from `tasks-config.json` on startup so the toggle survives restarts.
- **Hardened `TaskUpdate` description** — added "Before starting work on a task: mark it `in_progress` BEFORE beginning" as an explicit use case. Previously this rule only appeared in `TaskCreate`; now it lives in the tool actually used to set that status.
- **Removed `before_agent_start` system prompt injection** — task state is no longer injected into the system prompt on every agent loop. Analysis showed this creates wallpaper noise that trains the model to ignore the task block. Claude Code itself does not do this: the workflow contract lives in tool descriptions (read at decision time) and the periodic `<system-reminder>` nudge (fired when task tools haven't been used recently). Removed the corresponding 3 tests.
- **Widget render-once refactor** — `TaskWidget` now registers the widget callback a single time and uses `tui.requestRender()` for subsequent updates instead of calling `setWidget()` on every tick. Rendering logic extracted to `renderWidget()`. Eliminates redundant callback re-registration and keeps a cached `tui` reference for lightweight invalidation.

## [0.3.0] - 2026-03-14

### Changed
- **Eventbus RPC for subagent communication** — replaced the `Symbol.for` global registry bridge with a proper eventbus RPC protocol. [`pi-tasks`](https://github.com/tintinweb/pi-tasks) now communicates with `@tintinweb/pi-subagents` via scoped request/reply channels (`subagents:rpc:spawn`, `subagents:rpc:ping`), eliminating shared mutable global state and enabling reliable cross-extension coordination regardless of load order.
- **Presence detection** — two-path handshake: (1) ping RPC on init with scoped reply channel, (2) `subagents:ready` broadcast listener. Works whether [`pi-subagents`](https://github.com/tintinweb/pi-subagents) loads before or after [`pi-tasks`](https://github.com/tintinweb/pi-tasks).
- **Agent-task mapping** — in-memory `agentTaskMap` (agentId → taskId) replaces linear `store.list().find()` scans for O(1) completion event lookup.
- **Spawn error handling** — `spawnSubagent()` returns a Promise with 30s timeout. Failed spawns revert tasks to `pending` with error in metadata instead of silently failing.
- **Removed `SubagentBridge` type** — the `types.ts` interface for the global registry bridge is no longer needed.
- **Widget icon colors** — completed tasks show green `✔`, in-progress tasks show accent-colored `◼` (matching Claude Code's UI).

## [0.2.0] - 2026-03-12

### Added
- **`TaskExecute` tool** — execute tasks as background subagents via @tintinweb/pi-subagents. Tasks with `agentType` metadata are spawned as independent agents; validates status, dependencies, and agent type before launching.
- **`agentType` parameter on `TaskCreate`** — opt-in field (e.g., `"general-purpose"`, `"Explore"`) that marks tasks for subagent execution.
- **Auto-cascade** — when enabled via `/tasks` → Settings, completed agent tasks automatically trigger execution of their unblocked dependents, flowing through the task DAG like a build system. Off by default.
- **Subagent completion listener** — listens to `subagents:completed` and `subagents:failed` events to automatically update task status. Failed tasks revert to `pending` with error stored in metadata.
- **READY tags in system prompt** — pending tasks with `agentType` and all dependencies completed are marked `[READY — use TaskExecute to start]` in the system prompt.
- **Agent ID in widget** — in-progress tasks backed by subagents show the agent ID (e.g., `✳ Writing tests (agent abc12)…`).
- **Settings menu** — `/tasks` → Settings → toggle "Auto-execute tasks with agents".
- **`SubagentBridge` type** — typed interface for the cross-extension Symbol.for bridge.

### Changed
- `@tintinweb/pi-subagents` global registry now exposes `spawn()` and `getRecord()` in addition to `waitForAll()` and `hasRunning()`.
- `@tintinweb/pi-subagents` emits lifecycle events on `pi.events`: `subagents:created`, `subagents:started`, `subagents:completed`, `subagents:failed`, `subagents:steered`.
- `AgentManager` accepts an optional `onStart` callback, fired when an agent transitions to running (including from queue).

## [0.1.0] - 2026-03-12

Initial release — Claude Code-style task tracking and coordination for pi.

### Added
- **6 LLM-callable tools** — `TaskCreate`, `TaskList`, `TaskGet`, `TaskUpdate`, `TaskOutput`, `TaskStop` — matching Claude Code's exact tool specs, descriptions, and schemas.
- **System-reminder injection** — periodic `<system-reminder>` nudges appended to non-task tool results when tasks exist but task tools haven't been used for 4+ turns. Matches Claude Code's host-level reminder mechanism.
- **Prompt guidelines** — `promptGuidelines` on TaskCreate injects persistent guidance into the system prompt, nudging the LLM to use task tools for complex work.
- **Task state in system prompt** — `before_agent_start` event appends current task state to the system prompt on every agent loop, ensuring task awareness survives context compaction.
- **Persistent widget** — live task list above editor with `✔` (completed, strikethrough + dim), `◼` (in-progress), `◻` (pending), animated star spinner (`✳✽`) for active tasks with elapsed time and token counts (e.g., `✳ Running tests… (2m 49s · ↑ 4.1k ↓ 1.2k)`).
- **Multiple parallel active tasks** — widget supports multiple simultaneous spinners.
- **`/tasks` command** — interactive menu: view tasks with actions (start, complete, delete), create tasks, clear completed.
- **Bidirectional dependency management** — `addBlocks`/`addBlockedBy` maintain both sides automatically. Edges cleaned up on task deletion.
- **Dependency warnings** — cycles, self-dependencies, and dangling references produce warnings in TaskUpdate responses. Edges are still stored, matching Claude Code's permissive behavior.
- **File-backed shared storage** — set `PI_TASK_LIST_ID` env var for multi-session coordination at `~/.pi/tasks/<id>.json`. File locking with stale-lock detection prevents race conditions.
- **In-memory session-scoped mode** — default when no env var is set, zero disk I/O.
- **Background process tracker** — output buffering (stdout + stderr), waiter notification, graceful stop with timeout escalation (SIGTERM → 5s → SIGKILL).
- **78 unit tests** — task store CRUD, dependencies, warnings, file persistence; widget rendering, icons, spinners, token/duration formatting; process tracker lifecycle.

[0.3.3]: https://github.com/tintinweb/pi-tasks/releases/tag/v0.3.3
[0.3.2]: https://github.com/tintinweb/pi-tasks/releases/tag/v0.3.2
[0.3.1]: https://github.com/tintinweb/pi-tasks/releases/tag/v0.3.1
[0.3.0]: https://github.com/tintinweb/pi-tasks/releases/tag/v0.3.0
[0.2.0]: https://github.com/tintinweb/pi-tasks/releases/tag/v0.2.0
[0.1.0]: https://github.com/tintinweb/pi-tasks/releases/tag/v0.1.0
