/**
 * dsh-todo-progress-guard — a Host-only DSH bundle.
 *
 * DSH's `todo_write` tool replaces the whole task list and never advances on its
 * own: the `todos` session projection only changes when the model calls
 * `todo_write` again. Long tool-heavy turns therefore tend to keep a plan frozen
 * at its first item, and a turn that ends with a final reply leaves the panel
 * showing `in_progress` / `pending` entries forever.
 *
 * This bundle closes both gaps without touching DSH core:
 *
 * 1. Mid-turn progress reminder (`tools/post-execute`): when a turn owns an
 *    incomplete todo list and the agent runs several steps/calls without calling
 *    `todo_write`, one compact notice is injected into the next step through
 *    `PostToolDecision.additionalContexts`. The notice repeats the current list
 *    verbatim so the model can update it in parallel with its next tool call,
 *    without re-reading distant history.
 *
 * 2. Turn-end auto-completion (`agent/turn-stopping`): when a turn is about to
 *    close normally after real work, leftover `in_progress` / `pending` items are
 *    written back as `completed` through a final `todo/write` snapshot, so the
 *    panel can never outlive the work it describes.
 *
 * The plugin imports no DSH package at runtime, so it loads identically from a
 * registry install and from a local `link:` checkout. Configuration is validated
 * internally with documented defaults.
 *
 * @module dsh-todo-progress-guard
 */

/** Stable Cordis plugin name used by Loader diagnostics. */
export const name = "todo-progress-guard";

/**
 * Host services required before the plugin activates. `sessions` provides the
 * committed log snapshot, and `sessionProjections` reads the `todos` unit that
 * `@deepseek-ai/dsh-tool-todo` registers.
 */
export const inject = ["sessions", "sessionProjections"];

/** `user/message` source kind stamped on every reminder this plugin injects. */
const REMINDER_SOURCE_KIND = "todo-progress-reminder";

/**
 * Tools that deliberately suspend the turn on the human. Auto-completing a plan
 * while one of them just ran would blame tasks the user has not answered yet.
 */
const INTERACTIVE_STOP_TOOLS = new Set(["ask_user_question", "exit_plan_mode"]);

const DEFAULT_STEP_THRESHOLD = 2;
const DEFAULT_CALL_THRESHOLD = 5;

/** Deep-freeze a plain JSON message object in place. */
function deepFreeze(value) {
  if (value === null || typeof value !== "object") {
    return value;
  }
  Object.freeze(value);
  for (const key of Object.keys(value)) {
    deepFreeze(value[key]);
  }
  return value;
}

/**
 * Build an immutable `UserMessage` accepted by `PostToolDecision.additionalContexts`.
 * @param text - full reminder body the model reads.
 * @param summary - one-line label the Chat UI shows for the collapsed notice row.
 * @returns a frozen, JSON-serializable message.
 */
function createReminderMessage(text, summary) {
  return deepFreeze({
    id: globalThis.crypto.randomUUID(),
    role: "user",
    content: [{ type: "text", text }],
    source: {
      kind: REMINDER_SOURCE_KIND,
      form: "notice",
      summary
    }
  });
}

/** Whether a todo list exists and has at least one non-completed item. */
function hasIncompleteTodos(todos) {
  return Array.isArray(todos) && todos.some((item) => item !== null && item.status !== "completed");
}

/**
 * Render the reminder body. The list is repeated with exact item text because
 * `todo_write` replaces the whole list; the model then never has to reconstruct
 * older entries from distant history.
 */
function formatReminderText(todos, stepsSince, callsSince) {
  const done = todos.filter((item) => item.status === "completed").length;
  const lines = todos.map((item, index) => `${index + 1}. [${item.status}] ${item.content}`).join("\n");
  return [
    `Task progress reminder (${done}/${todos.length} completed; ${stepsSince} step(s) / ${callsSince} tool call(s) since the last todo_write):`,
    lines,
    "If any task above is now completed or in progress, call `todo_write` with the COMPLETE updated list in your next step. It can run in parallel alongside your next tool call at no extra step cost, or mark every finished task `completed` before your final reply."
  ].join("\n");
}

/** Short one-line summary for the collapsed notice row. */
function formatReminderSummary(todos) {
  const done = todos.filter((item) => item.status === "completed").length;
  const active = todos.find((item) => item.status === "in_progress");
  return active === undefined
    ? `${done}/${todos.length} completed`
    : `${done}/${todos.length} completed · ${active.content}`;
}

/** Create a fresh per-session tracking state. */
function createEmptyState() {
  return {
    /** Highest session seq folded in; guards against double-application. */
    lastSeq: -1,
    openTurn: null,
    openStep: null,
    lastTodos: null,
    workToolsAfterFirstTodo: 0,
    stepsSinceTodoWrite: 0,
    callsSinceTodoWrite: 0,
    expectedToolCallsInStep: 0,
    seenPostExecuteInStep: 0,
    currentStepHasTodoWrite: false,
    currentStepReminded: false,
    lastStepHadInteractiveStop: false,
    lastAssistantInterrupted: false
  };
}

/** Reset turn-scoped counters when a new turn opens. */
function resetForTurn(state, turn) {
  state.openTurn = turn;
  state.openStep = null;
  state.lastTodos = null;
  state.workToolsAfterFirstTodo = 0;
  state.stepsSinceTodoWrite = 0;
  state.callsSinceTodoWrite = 0;
  state.expectedToolCallsInStep = 0;
  state.seenPostExecuteInStep = 0;
  state.currentStepHasTodoWrite = false;
  state.currentStepReminded = false;
  state.lastStepHadInteractiveStop = false;
  state.lastAssistantInterrupted = false;
}

/**
 * Advance tracking state from one committed session event. Events arrive in
 * order, so a seq guard makes the fold idempotent: seeding a live session from
 * its snapshot and then receiving the same event again changes nothing.
 */
function advanceState(state, event) {
  if (typeof event.seq === "number") {
    if (event.seq <= state.lastSeq) {
      return;
    }
    state.lastSeq = event.seq;
  }

  switch (event.type) {
    case "turn/start":
      resetForTurn(state, event.data.turn);
      break;
    case "turn/end":
      state.openTurn = null;
      state.openStep = null;
      break;
    case "step/start":
      state.openStep = event.data.step;
      state.expectedToolCallsInStep = 0;
      state.seenPostExecuteInStep = 0;
      state.currentStepHasTodoWrite = false;
      state.currentStepReminded = false;
      break;
    case "step/end":
      state.openStep = null;
      break;
    case "assistant/message": {
      state.lastAssistantInterrupted = event.data.interrupted === true;
      const content = Array.isArray(event.data.message?.content) ? event.data.message.content : [];
      const toolCalls = content.filter((block) => block !== null && block.type === "tool-call");
      state.expectedToolCallsInStep = toolCalls.length;
      state.seenPostExecuteInStep = 0;
      if (toolCalls.length > 0) {
        const hasTodoWrite = toolCalls.some((block) => block.name === "todo_write");
        state.currentStepHasTodoWrite = hasTodoWrite;
        state.lastStepHadInteractiveStop = toolCalls.some((block) =>
          INTERACTIVE_STOP_TOOLS.has(block.name)
        );
        if (hasTodoWrite) {
          state.stepsSinceTodoWrite = 0;
          state.callsSinceTodoWrite = 0;
        } else if (hasIncompleteTodos(state.lastTodos)) {
          state.stepsSinceTodoWrite += 1;
        }
      }
      break;
    }
    case "todo/write":
      state.lastTodos = event.data.todos;
      state.currentStepHasTodoWrite = true;
      state.stepsSinceTodoWrite = 0;
      state.callsSinceTodoWrite = 0;
      break;
    case "tool/call":
    case "tool/ptc-dispatch-start": {
      const toolName = event.data?.name;
      if (toolName === "todo_write") {
        state.currentStepHasTodoWrite = true;
        state.stepsSinceTodoWrite = 0;
        state.callsSinceTodoWrite = 0;
      } else if (typeof toolName === "string" && state.lastTodos !== null) {
        state.workToolsAfterFirstTodo += 1;
        if (!state.currentStepHasTodoWrite && hasIncompleteTodos(state.lastTodos)) {
          state.callsSinceTodoWrite += 1;
        }
        if (INTERACTIVE_STOP_TOOLS.has(toolName)) {
          state.lastStepHadInteractiveStop = true;
        }
      }
      break;
    }
    default:
      break;
  }
}

/**
 * Seed state from a session's committed log. Only the currently open turn
 * matters, so the fold starts at its `turn/start`.
 */
function seedSessionState(session) {
  const state = createEmptyState();
  try {
    const events = session.snapshotEvents();
    let startIndex = 0;
    for (let index = events.length - 1; index >= 0; index -= 1) {
      if (events[index]?.type === "turn/start") {
        startIndex = index;
        break;
      }
    }
    for (let index = startIndex; index < events.length; index += 1) {
      advanceState(state, events[index]);
    }
  } catch {
    // A cold or disposed session has no readable log; tracking restarts empty.
  }
  return state;
}

/** Prepend our reminder while preserving every downstream context. */
function prependContext(ours, theirs) {
  return [ours, ...(theirs ?? [])];
}

/** Read one positive-integer config value, falling back to its default. */
function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value >= 1 ? value : fallback;
}

/**
 * Register the guard's listeners.
 * @param ctx - Cordis context carrying the session and tools services.
 * @param rawConfig - the row's `config`, validated here rather than by a
 *   Schemastery `Config` export so the bundle keeps zero runtime dependencies.
 */
export function apply(ctx, rawConfig = {}) {
  const stepThreshold = positiveInteger(rawConfig?.stepThreshold, DEFAULT_STEP_THRESHOLD);
  const callThreshold = positiveInteger(rawConfig?.callThreshold, DEFAULT_CALL_THRESHOLD);
  const autoCompleteOnTurnEnd =
    typeof rawConfig?.autoCompleteOnTurnEnd === "boolean"
      ? rawConfig.autoCompleteOnTurnEnd
      : true;

  const states = new WeakMap();

  /** Read the tracking state of one session, seeding it from the log on first use. */
  function stateFor(session) {
    let state = states.get(session);
    if (state === undefined) {
      state = seedSessionState(session);
      states.set(session, state);
    }
    return state;
  }

  /** The live plan: the `todos` projection when mounted, else the folded events. */
  function currentTodos(session, state) {
    try {
      const projected = ctx.sessionProjections.stateOf(session, "todos");
      if (projected !== undefined) {
        return projected;
      }
    } catch {
      // The projection registry may be absent in a minimal composition.
    }
    return state.lastTodos;
  }

  for (const session of ctx.sessions.list()) {
    states.set(session, seedSessionState(session));
  }

  ctx.on("session/created", (session) => {
    states.set(session, seedSessionState(session));
  });

  ctx.on("session/disposed", (session) => {
    states.delete(session);
  });

  ctx.on("session/event", (session, event) => {
    advanceState(stateFor(session), event);
  });

  ctx.on("tools/post-execute", async (exec, _result, next) => {
    const downstream = await next();

    const agent = exec.agent;
    if (agent === undefined || agent.session === undefined) {
      return downstream;
    }
    // Nested `run_code` sub-calls report their own post-execute; only the
    // top-level call marks the end of a step's batch.
    if (exec.parent !== undefined) {
      return downstream;
    }

    const session = agent.session;
    const state = stateFor(session);
    state.seenPostExecuteInStep += 1;

    if (exec.name === "todo_write" || state.currentStepHasTodoWrite) {
      return downstream;
    }
    if (state.currentStepReminded || state.lastStepHadInteractiveStop) {
      return downstream;
    }
    // Wait for the last call of a parallel batch so a `todo_write` racing in the
    // same step is never reported as missing.
    if (
      state.expectedToolCallsInStep > 0 &&
      state.seenPostExecuteInStep < state.expectedToolCallsInStep
    ) {
      return downstream;
    }

    const todos = currentTodos(session, state);
    if (!hasIncompleteTodos(todos)) {
      return downstream;
    }

    const hitStepThreshold = state.stepsSinceTodoWrite >= stepThreshold;
    const hitCallThreshold =
      state.stepsSinceTodoWrite >= 1 && state.callsSinceTodoWrite >= callThreshold;
    if (!hitStepThreshold && !hitCallThreshold) {
      return downstream;
    }

    const stepsSince = state.stepsSinceTodoWrite;
    const callsSince = state.callsSinceTodoWrite;
    state.currentStepReminded = true;
    state.stepsSinceTodoWrite = 0;
    state.callsSinceTodoWrite = 0;

    const reminder = createReminderMessage(
      formatReminderText(todos, stepsSince, callsSince),
      formatReminderSummary(todos)
    );

    if (downstream.kind === "block") {
      return {
        kind: "block",
        feedback: downstream.feedback,
        additionalContexts: prependContext(reminder, downstream.additionalContexts)
      };
    }
    return {
      ...downstream,
      additionalContexts: prependContext(reminder, downstream.additionalContexts)
    };
  });

  ctx.on("agent/turn-stopping", ({ agent, turn, signal }) => {
    if (!autoCompleteOnTurnEnd || signal.aborted) {
      return;
    }
    // Fresh steering means another step is already queued; the turn is not over.
    if (agent.inbox.nextStep.length > 0) {
      return;
    }

    const session = agent.session;
    if (session === undefined) {
      return;
    }

    const state = stateFor(session);
    // Only a committed, uninterrupted turn whose steps are all closed qualifies.
    if (state.openTurn !== turn || state.openStep !== null) {
      return;
    }
    if (state.lastAssistantInterrupted || state.lastStepHadInteractiveStop) {
      return;
    }

    const todos = currentTodos(session, state);
    if (!hasIncompleteTodos(todos)) {
      return;
    }

    // A plan created but never acted on is a stated intention, not finished work.
    const completedAny = todos.some((item) => item.status === "completed");
    if (state.workToolsAfterFirstTodo <= 0 && !completedAny) {
      return;
    }

    const completedTodos = todos.map((item) => ({
      content: String(item.content).trim(),
      status: "completed"
    }));

    try {
      session.append("todo/write", { todos: completedTodos });
    } catch (error) {
      ctx.logger?.warn?.(
        `todo-progress-guard: could not complete todos at turn end: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  });
}
