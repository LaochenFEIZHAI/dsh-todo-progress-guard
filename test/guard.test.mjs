import assert from "node:assert/strict";
import test from "node:test";

import { apply } from "../index.js";

/**
 * Build a Host stand-in: one session with a real event log, one agent, and a
 * `todos` projection whose value is kept in step with `todo/write` events.
 */
function createHarness({ config = {}, projection = true, seedEvents = [], listSessions = false } = {}) {
  const listeners = new Map();
  const events = [];
  let projectedTodos = null;

  const session = {
    snapshotEvents: () => [...events],
    append(type, data) {
      const event = { type, data, seq: events.length };
      events.push(event);
      if (type === "todo/write") {
        projectedTodos = data.todos;
      }
      for (const listener of listeners.get("session/event") ?? []) {
        listener(session, event);
      }
      return event;
    }
  };

  const agent = { session, inbox: { nextStep: [] } };

  for (const [type, data] of seedEvents) {
    events.push({ type, data, seq: events.length });
    if (type === "todo/write") {
      projectedTodos = data.todos;
    }
  }

  const ctx = {
    sessions: { list: () => (listSessions ? [session] : []) },
    sessionProjections: { stateOf: () => (projection ? projectedTodos : undefined) },
    logger: { warn() {} },
    on(eventName, listener) {
      const bucket = listeners.get(eventName) ?? [];
      bucket.push(listener);
      listeners.set(eventName, bucket);
    }
  };

  apply(ctx, config);

  return {
    agent,
    events,
    session,
    append: (type, data) => session.append(type, data),
    /** Run the post-execute waterfall for one call and return its decision. */
    runTool(name, { parent, downstream } = {}) {
      const listener = listeners.get("tools/post-execute")[0];
      return listener(
        { name, agent, parent },
        { isError: false },
        downstream ?? (async () => ({ kind: "accept" }))
      );
    },
    /** Dispatch the turn-stopping hook the way AgentLoop does before `turn/end`. */
    stopTurn(turn, { aborted = false } = {}) {
      const controller = new AbortController();
      if (aborted) {
        controller.abort();
      }
      for (const listener of listeners.get("agent/turn-stopping") ?? []) {
        listener({ agent, turn, signal: controller.signal });
      }
    },
    /** Last `todo/write` snapshot in the log. */
    lastWrite() {
      for (let index = events.length - 1; index >= 0; index -= 1) {
        if (events[index].type === "todo/write") {
          return events[index].data.todos;
        }
      }
      return undefined;
    }
  };
}

/** Log one completed step: the assistant message, then a call per tool name. */
function runStep(harness, turn, step, toolNames) {
  harness.append("step/start", { turn, step });
  harness.append("assistant/message", {
    turn,
    step,
    message: {
      content: toolNames.map((name, index) => ({
        type: "tool-call",
        name,
        id: `${name}-${turn}-${step}-${index}`
      }))
    }
  });
  for (const [index, name] of toolNames.entries()) {
    harness.append("tool/call", { turn, step, name, callId: `${name}-${turn}-${step}-${index}` });
  }
}

const PLAN = [
  { content: "Recon the repository", status: "completed" },
  { content: "Implement the fix", status: "in_progress" },
  { content: "Run the test suite", status: "pending" }
];

test("reminds once the step threshold is crossed without a todo_write", async () => {
  const harness = createHarness();
  harness.append("turn/start", { turn: 1 });

  runStep(harness, 1, 1, ["todo_write", "read"]);
  harness.append("todo/write", { todos: PLAN });
  assert.equal((await harness.runTool("todo_write")).additionalContexts, undefined);
  assert.equal((await harness.runTool("read")).additionalContexts, undefined);
  harness.append("step/end", { turn: 1, step: 1 });

  // One step since the last write: still under the default threshold of 2.
  runStep(harness, 1, 2, ["bash"]);
  assert.equal((await harness.runTool("bash")).additionalContexts, undefined);
  harness.append("step/end", { turn: 1, step: 2 });

  // Two steps since the last write: the reminder rides the step's last result.
  runStep(harness, 1, 3, ["bash"]);
  const decision = await harness.runTool("bash");
  assert.equal(decision.additionalContexts.length, 1);
  const [reminder] = decision.additionalContexts;
  assert.equal(reminder.role, "user");
  assert.equal(reminder.source.kind, "todo-progress-reminder");
  assert.equal(reminder.source.form, "notice");
  const text = reminder.content[0].text;
  assert.match(text, /1\/3 completed/);
  assert.match(text, /2\. \[in_progress\] Implement the fix/);
  assert.match(text, /3\. \[pending\] Run the test suite/);
  // The injected message is frozen, so a later listener cannot rewrite it.
  assert.ok(Object.isFrozen(reminder));
  assert.ok(Object.isFrozen(reminder.content[0]));
});

test("waits for the last call of a parallel batch before reminding", async () => {
  const harness = createHarness();
  harness.append("turn/start", { turn: 1 });

  runStep(harness, 1, 1, ["todo_write"]);
  harness.append("todo/write", { todos: PLAN });
  harness.append("step/end", { turn: 1, step: 1 });

  runStep(harness, 1, 2, ["bash"]);
  await harness.runTool("bash");
  harness.append("step/end", { turn: 1, step: 2 });

  runStep(harness, 1, 3, ["read", "grep"]);
  const first = await harness.runTool("read");
  assert.equal(first.additionalContexts, undefined, "the batch is still running");
  const second = await harness.runTool("grep");
  assert.equal(second.additionalContexts.length, 1);
});

test("never reminds when the same step already called todo_write", async () => {
  const harness = createHarness();
  harness.append("turn/start", { turn: 1 });

  runStep(harness, 1, 1, ["todo_write"]);
  harness.append("todo/write", { todos: PLAN });
  harness.append("step/end", { turn: 1, step: 1 });
  runStep(harness, 1, 2, ["bash"]);
  await harness.runTool("bash");
  harness.append("step/end", { turn: 1, step: 2 });

  // `edit` is subject to the reminder rules; `todo_write` is in the same step,
  // so the batch must stay silent even though `edit` settles first.
  runStep(harness, 1, 3, ["edit", "todo_write"]);
  const decision = await harness.runTool("edit");
  assert.equal(decision.additionalContexts, undefined);
});

test("stays silent once every item is completed", async () => {
  const harness = createHarness();
  harness.append("turn/start", { turn: 1 });

  runStep(harness, 1, 1, ["todo_write"]);
  harness.append("todo/write", {
    todos: PLAN.map((item) => ({ ...item, status: "completed" }))
  });
  harness.append("step/end", { turn: 1, step: 1 });

  for (const step of [2, 3, 4, 5]) {
    runStep(harness, 1, step, ["bash"]);
    assert.equal((await harness.runTool("bash")).additionalContexts, undefined);
    harness.append("step/end", { turn: 1, step });
  }
});

test("completes leftover items when a finished turn stops", async () => {
  const harness = createHarness();
  harness.append("turn/start", { turn: 1 });

  runStep(harness, 1, 1, ["todo_write"]);
  harness.append("todo/write", { todos: PLAN });
  harness.append("step/end", { turn: 1, step: 1 });

  runStep(harness, 1, 2, ["bash"]);
  await harness.runTool("bash");
  harness.append("step/end", { turn: 1, step: 2 });

  // Final reply with no tool calls at all, then the turn boundary.
  runStep(harness, 1, 3, []);
  harness.append("step/end", { turn: 1, step: 3 });

  harness.stopTurn(1);

  assert.deepEqual(harness.lastWrite(), [
    { content: "Recon the repository", status: "completed" },
    { content: "Implement the fix", status: "completed" },
    { content: "Run the test suite", status: "completed" }
  ]);
});

test("leaves an already-complete plan untouched at the turn boundary", async () => {
  const harness = createHarness();
  harness.append("turn/start", { turn: 1 });

  const complete = PLAN.map((item) => ({ ...item, status: "completed" }));
  runStep(harness, 1, 1, ["todo_write"]);
  harness.append("todo/write", { todos: complete });
  harness.append("step/end", { turn: 1, step: 1 });
  runStep(harness, 1, 2, []);
  harness.append("step/end", { turn: 1, step: 2 });

  const before = harness.events.length;
  harness.stopTurn(1);
  assert.equal(harness.events.length, before, "no write is appended");
});

test("does not complete tasks when the turn was aborted", async () => {
  const harness = createHarness();
  harness.append("turn/start", { turn: 1 });

  runStep(harness, 1, 1, ["todo_write"]);
  harness.append("todo/write", { todos: PLAN });
  harness.append("step/end", { turn: 1, step: 1 });
  runStep(harness, 1, 2, ["bash"]);
  await harness.runTool("bash");
  harness.append("step/end", { turn: 1, step: 2 });

  const before = harness.events.length;
  harness.stopTurn(1, { aborted: true });
  assert.equal(harness.events.length, before);
});

test("does not complete tasks while the turn is waiting on the human", async () => {
  const harness = createHarness();
  harness.append("turn/start", { turn: 1 });

  runStep(harness, 1, 1, ["todo_write"]);
  harness.append("todo/write", { todos: PLAN });
  harness.append("step/end", { turn: 1, step: 1 });

  runStep(harness, 1, 2, ["ask_user_question"]);
  await harness.runTool("ask_user_question");
  harness.append("step/end", { turn: 1, step: 2 });

  const before = harness.events.length;
  harness.stopTurn(1);
  assert.equal(harness.events.length, before);
});

test("treats a plan with no work behind it as an intention, not a result", async () => {
  const harness = createHarness();
  harness.append("turn/start", { turn: 1 });

  runStep(harness, 1, 1, ["todo_write"]);
  harness.append("todo/write", {
    todos: [
      { content: "First task", status: "in_progress" },
      { content: "Second task", status: "pending" }
    ]
  });
  harness.append("step/end", { turn: 1, step: 1 });
  runStep(harness, 1, 2, []);
  harness.append("step/end", { turn: 1, step: 2 });

  const before = harness.events.length;
  harness.stopTurn(1);
  assert.equal(harness.events.length, before);
});

test("seeds tracking from a pre-existing log after activation", async () => {
  // The plugin activates mid-turn: steps 1-2 already happened, and step 3 is
  // the second step since the recorded todo_write.
  const harness = createHarness({
    listSessions: true,
    seedEvents: [
      ["turn/start", { turn: 1 }],
      ["step/start", { turn: 1, step: 1 }],
      [
        "assistant/message",
        { turn: 1, step: 1, message: { content: [{ type: "tool-call", name: "todo_write" }] } }
      ],
      ["tool/call", { turn: 1, step: 1, name: "todo_write" }],
      ["todo/write", { todos: PLAN }],
      ["step/end", { turn: 1, step: 1 }],
      ["step/start", { turn: 1, step: 2 }],
      [
        "assistant/message",
        { turn: 1, step: 2, message: { content: [{ type: "tool-call", name: "bash" }] } }
      ],
      ["tool/call", { turn: 1, step: 2, name: "bash" }],
      ["step/end", { turn: 1, step: 2 }]
    ]
  });

  runStep(harness, 1, 3, ["bash"]);
  const decision = await harness.runTool("bash");
  assert.equal(decision.additionalContexts?.length, 1, "the seeded counters must survive");
});

test("falls back to the folded log when the projection is unavailable", async () => {
  const harness = createHarness({ projection: false });
  harness.append("turn/start", { turn: 1 });

  runStep(harness, 1, 1, ["todo_write"]);
  harness.append("todo/write", { todos: PLAN });
  harness.append("step/end", { turn: 1, step: 1 });
  runStep(harness, 1, 2, ["bash"]);
  await harness.runTool("bash");
  harness.append("step/end", { turn: 1, step: 2 });
  runStep(harness, 1, 3, ["bash"]);

  const decision = await harness.runTool("bash");
  assert.equal(decision.additionalContexts?.length, 1);
});

test("honours configured thresholds and can disable turn-end completion", async () => {
  const harness = createHarness({
    config: { stepThreshold: 1, callThreshold: 100, autoCompleteOnTurnEnd: false }
  });
  harness.append("turn/start", { turn: 1 });

  runStep(harness, 1, 1, ["todo_write"]);
  harness.append("todo/write", { todos: PLAN });
  harness.append("step/end", { turn: 1, step: 1 });

  runStep(harness, 1, 2, ["bash"]);
  const decision = await harness.runTool("bash");
  assert.equal(decision.additionalContexts?.length, 1, "stepThreshold 1 reminds immediately");
  harness.append("step/end", { turn: 1, step: 2 });

  const before = harness.events.length;
  harness.stopTurn(1);
  assert.equal(harness.events.length, before, "auto-completion is switched off");
});

test("preserves a blocked downstream decision and prepends the reminder", async () => {
  const harness = createHarness();
  harness.append("turn/start", { turn: 1 });

  runStep(harness, 1, 1, ["todo_write"]);
  harness.append("todo/write", { todos: PLAN });
  harness.append("step/end", { turn: 1, step: 1 });
  runStep(harness, 1, 2, ["bash"]);
  await harness.runTool("bash");
  harness.append("step/end", { turn: 1, step: 2 });
  runStep(harness, 1, 3, ["bash"]);

  const feedback = [{ type: "text", text: "blocked by a downstream guard" }];
  const decision = await harness.runTool("bash", {
    downstream: async () => ({ kind: "block", feedback })
  });

  assert.equal(decision.kind, "block");
  assert.equal(decision.feedback, feedback, "the downstream verdict is untouched");
  assert.equal(decision.additionalContexts.length, 1);
  assert.equal(decision.additionalContexts[0].source.kind, "todo-progress-reminder");
});
