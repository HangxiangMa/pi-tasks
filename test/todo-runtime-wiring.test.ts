import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mockPi } from "./helpers/mock-pi";
import registerTasks from "../src/index";
// The real pi-todo runtime artifact that settings.json now loads.
import registerTodo from "../../pi-extensions/packages/pi-todo/dist/index.ts";

// TaskCreate reports its id only in the text body ("Task #<id> created ...").
function createdId(result: any): string {
  const text = String(result?.content?.[0]?.text ?? "");
  const match = /Task #(\S+) created/.exec(text);
  if (!match) throw new Error(`TaskCreate did not report an id: ${text}`);
  return match[1];
}

function textOf(result: any): string {
  return String(result?.content?.[0]?.text ?? "");
}

// A session branch that already holds a real update_todo_list result (details v3)
// with one blocked step. pi-todo restores its state from exactly this shape.
function sessionWithBlockedTodo() {
  return {
    sessionManager: {
      // Session identity is a key only; nothing is read from or written to this path.
      getSessionFile: () => join(tmpdir(), "pi-tasks-todo-wiring", "session.jsonl"),
      getSessionId: () => "todo-wiring-session",
      getBranch: () => [
        {
          type: "message",
          message: {
            role: "toolResult",
            toolName: "update_todo_list",
            isError: false,
            details: {
              version: 3,
              todos: [{ id: "t1", step: "wait for hardware", status: "blocked", reason: "awaiting board" }],
            },
          },
        },
      ],
    },
    cwd: process.cwd(),
    hasUI: false,
    mode: "print",
    isIdle: () => true,
    // Display-only hooks. The TaskStart guard decision does not depend on any of them.
    ui: {
      setWidget: () => {},
      setStatus: () => {},
      notify: () => {},
      requestRender: () => {},
      select: async () => undefined,
      input: async () => undefined,
      custom: async () => undefined,
      terminal: { columns: 120, rows: 40 },
    },
  };
}

describe("pi-todo runtime wiring to the pi-tasks guard", () => {
  it("with real pi-todo loaded, TaskStart refuses a task whose parent TODO is blocked", async () => {
    const mock = mockPi();
    (registerTasks as unknown as (pi: unknown) => void)(mock.pi);
    (registerTodo as unknown as (pi: unknown) => void)(mock.pi);

    const ctx = sessionWithBlockedTodo();
    await mock.fireLifecycle("session_start", {}, ctx);

    const taskId = createdId(
      await mock.executeToolRaw("TaskCreate", { subject: "s", description: "d", todoId: "t1" }, ctx),
    );
    expect(textOf(await mock.executeToolRaw("TaskStart", { taskId }, ctx))).toMatch(
      /Parent TODO t1 is blocked; task cannot start/,
    );
  });

  it("control: without pi-todo there is no todo:updated source, so the guard does not fire", async () => {
    const mock = mockPi();
    (registerTasks as unknown as (pi: unknown) => void)(mock.pi);

    const taskId = createdId(
      await mock.executeToolRaw("TaskCreate", { subject: "s", description: "d", todoId: "t1" }),
    );
    expect(textOf(await mock.executeToolRaw("TaskStart", { taskId }))).not.toMatch(
      /cannot start/,
    );
  });
});
