// PORTICO-348: the inline question card pages one question at a time. These cover
// the stepper rules the card renders from: default position, forward/back
// reach, skipped-vs-pending status, and the Send gate (the host rejects an
// answer set with a hole in it, so a skipped question must block Send).

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

let mod;
test.before(async () => {
  mod = await import(
    pathToFileURL(
      path.resolve(
        __dirname,
        "..",
        "src/patches/frontend/src/lib/utils/userQuestionPagination.js",
      ),
    ).href
  );
});

const questions = (...ids) => ids.map((id) => ({ id }));

// Builds a model where the ids listed in `answered` count as answered.
const model = (
  ids,
  { currentIndex = 0, answered = [], skipped = [], visited } = {},
) =>
  mod.buildQuestionStepperModel(questions(...ids), {
    currentIndex,
    skippedIds: new Set(skipped),
    visitedIds: visited == null ? undefined : new Set(visited),
    isAnswered: (question) => answered.includes(question.id),
  });

test("a fresh multi-question flow starts on question 1 with nowhere to go back to", () => {
  const stepper = model(["a", "b", "c"]);
  assert.equal(stepper.currentIndex, 0);
  assert.equal(stepper.total, 3);
  assert.equal(stepper.paginated, true);
  assert.equal(stepper.canGoBack, false);
  assert.equal(stepper.canGoForward, true);
  assert.equal(stepper.isLast, false);
  assert.deepEqual(
    stepper.steps.map((step) => step.active),
    [true, false, false],
  );
});

test("a single-question flow keeps the unpaginated layout", () => {
  const stepper = model(["only"]);
  assert.equal(stepper.paginated, false, "no counter, no dots, no Back/Next");
  assert.equal(stepper.canGoBack, false);
  assert.equal(stepper.canGoForward, false);
  assert.equal(stepper.isLast, true);
  assert.equal(stepper.showSend, true);
  assert.equal(stepper.forwardAction, null);
});

test("the forward control reads Next once the current question is answered, Skip while it is not", () => {
  assert.equal(model(["a", "b"], { answered: [] }).forwardAction, mod.FORWARD_ACTION_SKIP);
  assert.equal(
    model(["a", "b"], { answered: ["a"] }).forwardAction,
    mod.FORWARD_ACTION_NEXT,
  );
  assert.equal(
    model(["a", "b"], { currentIndex: 1, answered: ["a"] }).forwardAction,
    null,
    "there is nowhere forward from the last question",
  );
});

test("the middle of a flow can move in both directions", () => {
  const stepper = model(["a", "b", "c"], { currentIndex: 1 });
  assert.equal(stepper.canGoBack, true);
  assert.equal(stepper.canGoForward, true);
  assert.equal(stepper.isLast, false);
});

test("a skipped question is distinguishable from one that was never visited", () => {
  const stepper = model(["a", "b", "c"], { currentIndex: 1, skipped: ["a"] });
  assert.deepEqual(
    stepper.steps.map((step) => step.status),
    [
      mod.QUESTION_STEP_SKIPPED,
      mod.QUESTION_STEP_PENDING,
      mod.QUESTION_STEP_PENDING,
    ],
  );
});

test("answering a question that was skipped earlier clears the skip", () => {
  const stepper = model(["a", "b"], {
    currentIndex: 1,
    skipped: ["a"],
    answered: ["a"],
  });
  assert.equal(stepper.steps[0].status, mod.QUESTION_STEP_ANSWERED);
});

test("a default answer stays visually pending until its question is visited", () => {
  const stepper = model(["a", "b", "c"], {
    currentIndex: 0,
    answered: ["a", "b"],
    visited: ["a"],
  });
  assert.deepEqual(
    stepper.steps.map((step) => step.status),
    [
      mod.QUESTION_STEP_ANSWERED,
      mod.QUESTION_STEP_PENDING,
      mod.QUESTION_STEP_PENDING,
    ],
  );
  assert.equal(stepper.answeredCount, 2, "the unopened default remains a valid answer");
  assert.equal(stepper.unansweredCount, 1);
  assert.equal(stepper.forwardAction, mod.FORWARD_ACTION_NEXT);
});

test("Send is offered on the last question but stays disabled while anything is unanswered", () => {
  const skippedFirst = model(["a", "b"], {
    currentIndex: 1,
    skipped: ["a"],
    answered: ["b"],
  });
  assert.equal(skippedFirst.showSend, true, "reachable, so the gate is visible");
  assert.equal(
    skippedFirst.sendEnabled,
    false,
    "the host rejects a submission with a missing answer",
  );
  assert.equal(skippedFirst.unansweredCount, 1);

  const complete = model(["a", "b"], { currentIndex: 1, answered: ["a", "b"] });
  assert.equal(complete.sendEnabled, true);
  assert.equal(complete.unansweredCount, 0);
});

test("Send appears early once everything is answered, even paged back to review", () => {
  const stepper = model(["a", "b", "c"], {
    currentIndex: 0,
    answered: ["a", "b", "c"],
  });
  assert.equal(stepper.isLast, false);
  assert.equal(stepper.showSend, true, "no need to page to the end to submit");
  assert.equal(stepper.sendEnabled, true);
  assert.equal(
    stepper.canGoForward,
    true,
    "reviewing forward stays available alongside Send",
  );
});

test("Send is withheld mid-flow while answers are outstanding", () => {
  const stepper = model(["a", "b", "c"], { currentIndex: 0, answered: ["a"] });
  assert.equal(stepper.showSend, false);
});

test("an out-of-range index lands on a real question instead of rendering nothing", () => {
  assert.equal(mod.clampQuestionIndex(9, 3), 2);
  assert.equal(mod.clampQuestionIndex(-4, 3), 0);
  assert.equal(mod.clampQuestionIndex(1, 0), 0);
  assert.equal(mod.clampQuestionIndex(Number.NaN, 3), 0);
  // A flow that shrinks under a paged-forward card must not blank out.
  assert.equal(model(["a"], { currentIndex: 4 }).currentIndex, 0);
});

test("markQuestionSkipped only marks questions left unanswered", () => {
  const empty = new Set();
  assert.deepEqual([...mod.markQuestionSkipped(empty, { id: "a" }, false)], ["a"]);
  assert.equal(
    mod.markQuestionSkipped(empty, { id: "a" }, true),
    empty,
    "leaving an answered question is not a skip",
  );
  const already = new Set(["a"]);
  assert.equal(
    mod.markQuestionSkipped(already, { id: "a" }, false),
    already,
    "re-skipping returns the same set so nothing downstream churns",
  );
  assert.equal(mod.markQuestionSkipped(empty, null, false), empty);
});

test("an empty flow degrades without throwing", () => {
  const stepper = mod.buildQuestionStepperModel(null, {});
  assert.equal(stepper.total, 0);
  assert.equal(stepper.paginated, false);
  assert.equal(stepper.allAnswered, false, "nothing to send");
  assert.equal(stepper.sendEnabled, false);
});
