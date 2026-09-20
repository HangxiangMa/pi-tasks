/**
 * task-widget.ts — Persistent widget showing task list with status glyphs and progress.
 *
 * Display style matches Claude Code's task list:
 *   ✔ completed tasks (strikethrough + dim)
 *   ◼ in_progress tasks
 *   ◻ pending tasks
 *   ✳/✽ actively executing task (star spinner with activeForm text)
 *
 * Every glyph on screen is a default that `glyphs` in tasks-config.json can
 * replace — see task-glyphs.ts.
 */

import { truncateToWidth } from "@earendil-works/pi-tui";
import { resolveTaskGlyphs } from "../task-glyphs.js";
import type { TaskStore } from "../task-store.js";
import type { TasksConfig } from "../tasks-config.js";

// ---- Truncation ----

import { normalizeTaskUsage, type Task, type TaskUsage } from "../types.js";

function truncateFromTop(tasks: Task[], limit: number): Task[] {
  return tasks.slice(-limit);
}

function truncateFromBottom(tasks: Task[], limit: number): Task[] {
  return tasks.slice(0, limit);
}

const TRUNCATE_FNS = { top: truncateFromTop, bottom: truncateFromBottom };

// ---- Types ----

export type Theme = {
  fg(color: string, text: string): string;
  bold(text: string): string;
  strikethrough(text: string): string;
};

export type UICtx = {
  setStatus(key: string, text: string | undefined): void;
  setWidget(
    key: string,
    content: undefined | ((tui: any, theme: Theme) => { render(): string[]; invalidate(): void }),
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
};

const DEFAULT_MAX_VISIBLE_TASKS = 10;

/** Per-task runtime metrics (elapsed time, token usage). */
export interface TaskMetrics extends TaskUsage {
  startedAt: number;
}

/** Format milliseconds as a human-readable duration (e.g., "2m 49s", "1h 3m"). */
function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return sec > 0 ? `${min}m ${sec}s` : `${min}m`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin > 0 ? `${hr}h ${remMin}m` : `${hr}h`;
}

/** Format token count with k suffix (e.g., "4.1k", "850"). */
function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
}

function formatUsage(usage: TaskUsage | undefined): string {
  if (!usage) return "";
  const parts = [
    usage.inputTokens > 0 ? `↑${formatTokens(usage.inputTokens)}` : "",
    usage.outputTokens > 0 ? `↓${formatTokens(usage.outputTokens)}` : "",
    usage.cost > 0 ? `${usage.costEstimated ? "~" : ""}$${usage.cost.toFixed(4)}` : "",
  ].filter(Boolean);
  return parts.length > 0 ? ` (${parts.join(" ")})` : "";
}

// ---- Widget ----

export class TaskWidget {
  private uiCtx: UICtx | undefined;
  private widgetFrame = 0;
  private widgetInterval: ReturnType<typeof setInterval> | undefined;
  /** IDs of tasks currently being actively executed (show spinner). */
  private activeTaskIds = new Set<string>();
  /** Per-task runtime metrics keyed by task ID. */
  private metrics = new Map<string, TaskMetrics>();
  /** Cached TUI instance for requestRender() calls. */
  private tui: any | undefined;
  /** Whether the widget callback is currently registered. */
  private widgetRegistered = false;

  constructor(
    private store: TaskStore,
    private config: TasksConfig = {},
  ) {}

  setStore(store: TaskStore) {
    if (this.store === store) return;
    this.activeTaskIds.clear();
    this.metrics.clear();
    this.store = store;
  }

  setUICtx(ctx: UICtx) {
    this.uiCtx = ctx;
  }

  /** Add or remove a task from the active spinner set. */
  setActiveTask(taskId: string | undefined, active = true) {
    if (taskId && active) {
      this.activeTaskIds.add(taskId);
      if (!this.metrics.has(taskId)) {
        const usage = this.store.get(taskId)?.usage;
        this.metrics.set(taskId, { startedAt: Date.now(), ...(usage ?? { inputTokens: 0, outputTokens: 0, cost: 0 }) });
      }
      this.ensureTimer();
    } else if (taskId) {
      this.activeTaskIds.delete(taskId);
    }
    this.update();
  }

  /** Record token usage for the currently active task(s). */
  addTokenUsage(inputTokens: number, outputTokens: number, cost = 0) {
    const ids = [...this.activeTaskIds];
    const count = ids.length;
    if (count === 0) return;
    const normalized = normalizeTaskUsage({ inputTokens, outputTokens, cost });
    if (!normalized) return;
    for (let i = 0; i < count; i++) {
      const usage: TaskUsage = {
        inputTokens: Math.floor(normalized.inputTokens / count) + (i < normalized.inputTokens % count ? 1 : 0),
        outputTokens: Math.floor(normalized.outputTokens / count) + (i < normalized.outputTokens % count ? 1 : 0),
        cost: normalized.cost / count,
        ...(count > 1 ? { costEstimated: true } : {}),
      };
      this.recordUsage(ids[i], usage);
    }
    this.update();
  }

  /** Sync live metrics after a store mutation that already persisted usage. */
  syncUsage(taskId: string, usage: TaskUsage | undefined) {
    if (!usage) return;
    const current = this.metrics.get(taskId);
    if (current) Object.assign(current, usage);
    else this.metrics.set(taskId, { startedAt: Date.now(), ...usage });
  }

  /** Persist usage returned by a subagent before its task leaves active state. */
  recordUsage(taskId: string, usage: TaskUsage) {
    const task = this.store.recordUsage(taskId, usage);
    if (!task) return;
    this.syncUsage(taskId, task.usage);
  }

  /** Ensure the widget update timer is running. The spinner advances here and
   *  nowhere else: `update()` also runs on every task mutation and tool execution,
   *  so incrementing there tied the animation speed to how busy the agent was. */
  ensureTimer() {
    if (!this.widgetInterval) {
      this.widgetInterval = setInterval(() => {
        this.widgetFrame++;
        this.update();
      }, 150);
    }
  }

  /** Render callback entry point. Guarded so a render error can never escape to
   *  the TUI timer and crash the whole host process — worst case the widget is
   *  empty for one frame. */
  private renderWidget(tui: any, theme: Theme): string[] {
    try {
      return this.buildWidgetLines(tui, theme);
    } catch {
      return [];
    }
  }

  /** Build widget lines from current live state. */
  private buildWidgetLines(tui: any, theme: Theme): string[] {
    const sortOrder = this.config.sortOrder ?? "id";
    // Resolved per render, not cached: the extension swaps this config object's
    // contents when the host moves to a session in another workspace.
    const glyphs = resolveTaskGlyphs(this.config.glyphs);
    const tasks = this.store.list(sortOrder);
    const w = tui.terminal.columns;
    const truncate = (line: string) => truncateToWidth(line, w, glyphs.truncation);

    if (tasks.length === 0) return [];

    const completed = tasks.filter(t => t.status === "completed");
    const inProgress = tasks.filter(t => t.status === "in_progress");
    const pending = tasks.filter(t => t.status === "pending");

    const parts: string[] = [];
    if (completed.length > 0) parts.push(`${completed.length} done`);
    if (inProgress.length > 0) parts.push(`${inProgress.length} in progress`);
    if (pending.length > 0) parts.push(`${pending.length} open`);
    const statusText = `${tasks.length} tasks (${parts.join(", ")})`;

    const spinnerFrame = glyphs.spinner[this.widgetFrame % glyphs.spinner.length];
    const lines: string[] = [truncate(theme.fg("accent", glyphs.header) + " " + theme.fg("accent", statusText))];

    // Collapsing only decides what goes in the list; the visible-limit logic below
    // then runs unchanged over whatever remains.
    const showAll = this.config.showAll ?? false;
    const limit = this.config.maxVisible ?? DEFAULT_MAX_VISIBLE_TASKS;
    // When a completed plan would consume the widget, fold it automatically so active
    // work remains visible. An explicit setting still wins for users who want history.
    // Narrowed rather than defaulted: config is hand-editable JSON, and an
    // unrecognised value would index TRUNCATE_FNS to undefined and blank the widget.
    const hiddenAt = this.config.hiddenAt === "top" ? "top" : "bottom";
    const collapseCompleted = this.config.collapseCompleted ?? (
      !showAll && hiddenAt !== "top" && completed.length > 1 &&
      completed.length + inProgress.length + pending.length >= limit &&
      inProgress.length + pending.length > 0
    );
    const listed = collapseCompleted ? tasks.filter(t => t.status !== "completed") : tasks;
    const visible = showAll ? listed : TRUNCATE_FNS[hiddenAt](listed, limit);

    const hiddenCount = listed.length - visible.length;
    const overflowLine = hiddenCount > 0
      ? truncate(theme.fg("dim", `    ${glyphs.overflow} and ${hiddenCount} more`))
      : undefined;

    if (overflowLine && hiddenAt === "top") {
      lines.push(overflowLine);
    }
    for (let i = 0; i < visible.length; i++) {
      const task = visible[i];
      const isActive = this.activeTaskIds.has(task.id) && task.status === "in_progress";

      let statusGlyph: string;
      if (isActive) {
        statusGlyph = theme.fg("accent", spinnerFrame);
      } else if (task.status === "completed") {
        statusGlyph = theme.fg("success", glyphs.completed);
      } else if (task.status === "in_progress") {
        statusGlyph = theme.fg("accent", glyphs.inProgress);
      } else {
        statusGlyph = glyphs.pending;
      }

      let suffix = "";
      if (task.status === "pending" && task.blockedBy.length > 0) {
        const openBlockers = task.blockedBy.filter(bid => {
          const blocker = this.store.get(bid);
          return blocker && blocker.status !== "completed";
        });
        if (openBlockers.length > 0) {
          suffix = theme.fg("dim", ` ${glyphs.blocked} blocked by ${openBlockers.map(id => "#" + id).join(", ")}`);
        }
      }

      let text: string;
      if (isActive) {
        const form = task.activeForm || task.subject;
        const agentId = task.metadata?.agentId;
        const agentLabel = agentId ? ` (agent ${agentId.slice(0, 5)})` : "";
        const m = this.metrics.get(task.id);
        let stats = "";
        if (m) {
          const elapsed = formatDuration(Date.now() - m.startedAt);
          const tokenParts: string[] = [];
          if (m.inputTokens > 0) tokenParts.push(`${glyphs.inputTokens} ${formatTokens(m.inputTokens)}`);
          if (m.outputTokens > 0) tokenParts.push(`${glyphs.outputTokens} ${formatTokens(m.outputTokens)}`);
          if (m.cost > 0) tokenParts.push(`${m.costEstimated ? "~" : ""}$${m.cost.toFixed(4)}`);
          stats = tokenParts.length > 0
            ? ` ${theme.fg("dim", `(${elapsed} ${glyphs.statsSeparator} ${tokenParts.join(" ")})`)}`
            : ` ${theme.fg("dim", `(${elapsed})`)}`;
        }
        text = `  ${statusGlyph} ${theme.fg("dim", "#" + task.id)} ${
          theme.fg("accent", form + agentLabel + glyphs.trailingEllipsis)
        }${stats}`;
      } else if (task.status === "completed") {
        text = `  ${statusGlyph} ${theme.fg("dim", theme.strikethrough("#" + task.id + " " + task.subject))}${theme.fg("dim", formatUsage(task.usage))}`;
      } else {
        const agentSuffix = task.status === "in_progress" && task.metadata?.agentId
          ? theme.fg("dim", ` (agent ${task.metadata.agentId.slice(0, 5)})`)
          : "";
        text = `  ${statusGlyph} ${theme.fg("dim", "#" + task.id)} ${task.subject}${agentSuffix}${theme.fg("dim", formatUsage(task.usage))}`;
      }

      lines.push(truncate(text + suffix));
    }

    if (overflowLine && hiddenAt !== "top") {
      lines.push(overflowLine);
    }
    if (collapseCompleted && completed.length > 0) {
      lines.push(truncate(`  ${theme.fg("success", glyphs.completedSummary)} ${theme.fg("dim", `${completed.length} completed`)}`));
    }

    return lines;
  }

  /** Force an immediate widget update. */
  update() {
    if (!this.uiCtx) return;
    const tasks = this.store.list();

    // Transition: visible → hidden
    if (tasks.length === 0) {
      if (this.widgetRegistered) {
        this.uiCtx.setWidget("tasks", undefined);
        this.widgetRegistered = false;
      }
      if (this.widgetInterval) {
        clearInterval(this.widgetInterval);
        this.widgetInterval = undefined;
      }
      return;
    }

    // Prune stale active IDs (deleted or no longer in_progress)
    for (const id of this.activeTaskIds) {
      const t = this.store.get(id);
      if (!t || t.status !== "in_progress") {
        this.activeTaskIds.delete(id);
        this.metrics.delete(id);
      }
    }

    // Check if any task needs animation
    const hasActiveSpinner = tasks.some(t => this.activeTaskIds.has(t.id) && t.status === "in_progress");
    if (hasActiveSpinner) {
      this.ensureTimer();
    } else if (!hasActiveSpinner && this.widgetInterval) {
      clearInterval(this.widgetInterval);
      this.widgetInterval = undefined;
    }

    // Transition: hidden → visible — register widget callback once
    if (!this.widgetRegistered) {
      this.uiCtx.setWidget("tasks", (tui, theme) => {
        this.tui = tui;
        return { render: () => this.renderWidget(tui, theme), invalidate: () => {} };
      }, { placement: "aboveEditor" });
      this.widgetRegistered = true;
    } else if (this.tui) {
      // Widget already registered — just request a re-render
      this.tui.requestRender();
    }
  }

  dispose() {
    if (this.widgetInterval) {
      clearInterval(this.widgetInterval);
      this.widgetInterval = undefined;
    }
    if (this.uiCtx) {
      this.uiCtx.setWidget("tasks", undefined);
    }
    this.widgetRegistered = false;
    this.tui = undefined;
  }
}
