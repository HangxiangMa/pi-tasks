import { describe, expect, it } from "vitest";
import { mockPi } from "./helpers/mock-pi";
import registerTasks from "../src/index";

// Contract: TODO owns lifecycle state. A task whose parent TODO is blocked or
// completed must not start. These tests drive the real registered tools and
// the real todo:updated channel, not a copy of the guard logic.

async function setup() {
  const mock = mockPi();
  (registerTasks as unknown as (pi: unknown) => void)(mock.pi);
  return mock;
}

// TaskCreate reports its id only in the text body ("Task #<id> created ...").
function createdId(result: any): string {
  const text = String(result?.content?.[0]?.text ?? "");
  const match = /Task #(\S+) created/.exec(text);
  if (!match) throw new Error(`TaskCreate did not report an id: ${text}`);
  return match[1];
}

function startText(result: any): string {
  return String(result?.content?.[0]?.text ?? "");
}

describe("TaskStart parent TODO guard", () => {
  it("refuses to start a task whose parent TODO is blocked", async () => {
    const mock = await setup();
    mock.pi.events.emit("todo:updated", {
      todos: [{ id: "t1", step: "x", status: "blocked", reason: "waiting" }],
    });
    const taskId = createdId(
      await mock.executeToolRaw("TaskCreate", { subject: "s", description: "d", todoId: "t1" }),
    );
    const text = startText(await mock.executeToolRaw("TaskStart", { taskId }));
    expect(text).toMatch(/blocked; task cannot start/);
  });

  it("refuses to start a task whose parent TODO is completed", async () => {
    const mock = await setup();
    mock.pi.events.emit("todo:updated", { todos: [{ id: "t2", step: "x", status: "completed" }] });
    const taskId = createdId(
      await mock.executeToolRaw("TaskCreate", { subject: "s", description: "d", todoId: "t2" }),
    );
    const text = startText(await mock.executeToolRaw("TaskStart", { taskId }));
    expect(text).toMatch(/completed; task cannot start/);
  });
});
