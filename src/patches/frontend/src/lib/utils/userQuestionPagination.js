// PORTICO-348: one question at a time, with pagination.
//
// The inline card first rendered every question of a flow as one long list, so
// a five-step wizard ("Help me build an agent") arrived as a wall of controls
// with a single Send at the bottom. The blocking modal it replaced had always
// paged one question at a time; this restores that, inline.
//
// The rules live here rather than in the .svelte file because Svelte cannot be
// compiled or rendered locally (the frontend builds in Docker), so component
// logic is only executable in tests once it is extracted.
//
// Model:
//  - default position is question 1, and the forward control walks 1 -> 2 -> 3
//    whether the current question was answered or skipped;
//  - every question stays reachable in both directions, so a skipped one can be
//    returned to;
//  - Send never submits a partial flow. The host rejects an answer set with a
//    hole in it (buildUserQuestionSubmittedResult throws "Missing answer for
//    question ..."), so a skipped question must be answered before sending.

export const QUESTION_STEP_ANSWERED = 'answered';
export const QUESTION_STEP_SKIPPED = 'skipped';
export const QUESTION_STEP_PENDING = 'pending';

export const FORWARD_ACTION_NEXT = 'next';
export const FORWARD_ACTION_SKIP = 'skip';

export const clampQuestionIndex = (index, count) => {
  const total = Number.isFinite(count) ? Math.trunc(count) : 0;
  if (total <= 0) return 0;
  const wanted = Number.isFinite(index) ? Math.trunc(index) : 0;
  if (wanted <= 0) return 0;
  return wanted > total - 1 ? total - 1 : wanted;
};

const toIdSet = (value) => {
  if (value instanceof Set) return value;
  return new Set(Array.isArray(value) ? value : []);
};

// Leaving an unanswered question marks it skipped, which is what lets the pager
// show it as outstanding work rather than as never-visited. Answering it later
// wins automatically -- status resolves `answered` before it looks at this set,
// so the mark never has to be cleared.
//
// Returns the original set when nothing changed so callers can assign
// unconditionally without churning downstream reactivity.
export const markQuestionSkipped = (skippedIds, question, answered) => {
  const current = toIdSet(skippedIds);
  const id = question?.id;
  if (!id || answered || current.has(id)) {
    return current;
  }
  const next = new Set(current);
  next.add(id);
  return next;
};

export const buildQuestionStepperModel = (questions, state = {}) => {
  const list = Array.isArray(questions) ? questions : [];
  const total = list.length;
  const currentIndex = clampQuestionIndex(state.currentIndex, total);
  const isAnswered =
    typeof state.isAnswered === 'function' ? state.isAnswered : () => false;
  const skipped = toIdSet(state.skippedIds);
  // When supplied, visitedIds controls only the dots' visual completion state.
  // A prefilled default remains a valid answer for navigation and submission,
  // but does not make an unopened question look completed.
  const visited = state.visitedIds == null ? null : toIdSet(state.visitedIds);

  const steps = list.map((question, index) => {
    const id = question?.id ?? `question-${index}`;
    const answered = Boolean(isAnswered(question, index));
    return {
      index,
      id,
      active: index === currentIndex,
      answered,
      status:
        answered && (visited == null || visited.has(id))
          ? QUESTION_STEP_ANSWERED
          : skipped.has(question?.id)
            ? QUESTION_STEP_SKIPPED
            : QUESTION_STEP_PENDING
    };
  });

  const answeredCount = steps.filter(
    (step) => step.answered
  ).length;
  const allAnswered = total > 0 && answeredCount === total;
  const isLast = total === 0 || currentIndex === total - 1;
  const canGoForward = currentIndex < total - 1;
  const currentStatus = steps[currentIndex]?.status ?? QUESTION_STEP_PENDING;
  const currentAnswered = steps[currentIndex]?.answered ?? false;

  return {
    total,
    currentIndex,
    steps,
    currentStatus,
    // A single-question flow keeps the pre-pagination layout: no counter, no
    // step dots, no Back/Next -- just the question and its actions.
    paginated: total > 1,
    answeredCount,
    unansweredCount: total - answeredCount,
    allAnswered,
    isLast,
    canGoBack: currentIndex > 0,
    canGoForward,
    // The one forward control carries both meanings the user asked for:
    // "answered -> next question" and "skipped -> next question".
    forwardAction: canGoForward
      ? currentAnswered
        ? FORWARD_ACTION_NEXT
        : FORWARD_ACTION_SKIP
      : null,
    // Send stays reachable once everything is answered even while paged back to
    // review an earlier answer -- the modal behaved the same way.
    showSend: isLast || allAnswered,
    sendEnabled: allAnswered
  };
};
