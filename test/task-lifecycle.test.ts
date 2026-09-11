import { afterEach, beforeEach, describe, expect, it } from "vitest";
import initExtension from "../src/index.js";
import { mockPi } from "./helpers/mock-pi.js";

beforeEach(() => {
  process.env.PI_TASKS = "off";
});

afterEach(() => {
  delete process.env.PI_TASKS;
});

describe("task lifecycle enforcement", () => {
  it("blocks work until a pending task is started", async () => {
    const mock = mockPi();
    initExtension(mock.pi as any);

    await mock.executeTool("TaskCreate", { subject: "Do work", description: "Desc" });
    expect(await mock.fireLifecycle("tool_call", { toolName: "bash" })).toEqual([{
      block: true,
      reason: "A task is pending. Call TaskStart for the task you are beginning before using work tools.",
    }]);

    await mock.executeToolRaw("TaskStart", { taskId: "1" });
    expect(await mock.fireLifecycle("tool_call", { toolName: "bash" })).toEqual([undefined]);
  });

  it("blocks more work after a stale reminder until the agent checks task state", async () => {
    const mock = mockPi();
    initExtension(mock.pi as any);

    await mock.executeTool("TaskCreate", { subject: "Do work", description: "Desc" });
    await mock.executeToolRaw("TaskStart", { taskId: "1" });

    await mock.fireLifecycle("turn_start", {}, {});
    await mock.fireLifecycle("tool_result", { toolName: "read" });
    expect(await mock.fireLifecycle("context", { messages: [] })).toEqual([{}]);

    await mock.fireLifecycle("turn_start", {}, {});
    await mock.fireLifecycle("tool_result", { toolName: "bash" });
    const reminderResult = await mock.fireLifecycle("context", { messages: [] });
    const reminder = reminderResult[0];
    expect(reminder.messages.at(-1).content[0].text).toContain("call TaskUpdate");

    expect(await mock.fireLifecycle("tool_call", { toolName: "bash" })).toEqual([{
      block: true,
      reason: "A task status checkpoint is required before more work. Call TaskUpdate now; if the task is complete, mark it completed with non-empty verification evidence.",
    }]);

    // Reading tasks alone is not progress and cannot bypass the checkpoint.
    await mock.executeTool("TaskList", {});
    await mock.fireLifecycle("tool_result", { toolName: "TaskList" });
    expect(await mock.fireLifecycle("tool_call", { toolName: "bash" })).toEqual([{
      block: true,
      reason: "A task status checkpoint is required before more work. Call TaskUpdate now; if the task is complete, mark it completed with non-empty verification evidence.",
    }]);

    // TaskUpdate satisfies checkpoint without auto-completing the task.
    await mock.executeTool("TaskUpdate", { taskId: "1", metadata: { checkpoint: "reviewed" } });
    await mock.fireLifecycle("tool_result", { toolName: "TaskUpdate" });
    expect((await mock.executeTool("TaskGet", { taskId: "1" })).content[0].text).toContain("Status: in_progress");
    expect(await mock.fireLifecycle("tool_call", { toolName: "bash" })).toEqual([undefined]);
  });

  it("routes compatibility in_progress updates through blocker checks", async () => {
    const mock = mockPi();
    initExtension(mock.pi as any);

    await mock.executeTool("TaskCreate", { subject: "Blocker", description: "Desc" });
    await mock.executeTool("TaskCreate", { subject: "Blocked", description: "Desc" });
    await mock.executeToolRaw("TaskUpdate", { taskId: "2", addBlockedBy: ["1"] });

    const result = await mock.executeToolRaw("TaskUpdate", { taskId: "2", status: "in_progress" });
    expect(result.content[0].text).toContain("Task #2 is blocked by #1");
  });

  it("releases uncompleted local tasks when the session shuts down", async () => {
    const mock = mockPi();
    initExtension(mock.pi as any);

    await mock.executeTool("TaskCreate", { subject: "Local work", description: "Desc" });
    await mock.executeToolRaw("TaskStart", { taskId: "1" });
    expect((await mock.executeTool("TaskGet", { taskId: "1" })).content[0].text).toContain("Status: in_progress");

    await mock.fireLifecycle("session_shutdown", {});

    const task = await mock.executeTool("TaskGet", { taskId: "1" });
    expect(task.content[0].text).toContain("Status: pending");
  });

  it("does not release agent-backed tasks before their completion event", async () => {
    const mock = mockPi();
    initExtension(mock.pi as any);

    await mock.executeTool("TaskCreate", {
      subject: "Agent work",
      description: "Desc",
      metadata: { agentId: "agent-1" },
    });
    await mock.executeToolRaw("TaskStart", { taskId: "1" });

    await mock.fireLifecycle("session_shutdown", {});

    const task = await mock.executeTool("TaskGet", { taskId: "1" });
    expect(task.content[0].text).toContain("Status: in_progress");
  });

  it("requires active status and verification evidence before completion", async () => {
    const mock = mockPi();
    initExtension(mock.pi as any);

    await mock.executeTool("TaskCreate", { subject: "Verify", description: "Desc" });
    const pending = await mock.executeToolRaw("TaskUpdate", {
      taskId: "1",
      status: "completed",
      verification: ["tests passed"],
    });
    expect(pending.content[0].text).toContain("can only complete from in_progress");

    await mock.executeToolRaw("TaskStart", { taskId: "1" });
    const missing = await mock.executeToolRaw("TaskUpdate", { taskId: "1", status: "completed" });
    expect(missing.content[0].text).toContain("requires non-empty verification evidence");

    const blank = await mock.executeToolRaw("TaskUpdate", {
      taskId: "1",
      status: "completed",
      verification: ["  "],
    });
    expect(blank.content[0].text).toContain("requires non-empty verification evidence");

    await mock.executeToolRaw("TaskUpdate", {
      taskId: "1",
      status: "completed",
      verification: ["  tests passed  "],
    });
    expect(await mock.fireLifecycle("tool_call", { toolName: "bash" })).toEqual([undefined]);
  });
});
