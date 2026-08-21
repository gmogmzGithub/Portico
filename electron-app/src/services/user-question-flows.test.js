const test = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizeUserQuestionRequest,
  buildUserQuestionSubmittedResult,
  buildUserQuestionDismissedResult,
  buildUserQuestionTimeoutResult,
  buildUserQuestionCancelledResult,
  USER_QUESTION_NONE_OF_THE_ABOVE_OPTION_ID,
  USER_QUESTION_NONE_OF_THE_ABOVE_OPTION_LABEL,
} = require("./user-question-flows");

test("buildUserQuestionCancelledResult is terminal with empty answers", () => {
  const cancelled = buildUserQuestionCancelledResult(
    { flowId: "flow-q-1" },
    "poll_error",
  );
  assert.equal(cancelled.success, false);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.flow_id, "flow-q-1");
  assert.deepEqual(cancelled.answers, []);
  assert.match(cancelled.error, /cancelled before the user answered \(poll_error\)/);
});

test("normalizeUserQuestionRequest validates and normalizes the modal payload", () => {
  const normalized = normalizeUserQuestionRequest({
    chat_id: "chat-publish-1",
    questions: [
      {
        id: "marketplace",
        header: "Marketplace",
        question: "Which marketplace should receive this skill?",
        options: [
          {
            id: "marketplace-1",
            label: "Marketplace 1",
            description: "First ranked choice.",
          },
          {
            id: "marketplace-2",
            label: "Marketplace 2",
          },
          {
            id: "marketplace-3",
            label: "Marketplace 3",
          },
          {
            id: "marketplace-4",
            label: "Marketplace 4",
          },
          {
            id: "new-gitlab-repository",
            label: "New GitLab repository",
          },
        ],
      },
    ],
  });

  assert.equal(normalized.chatId, "chat-publish-1");
  assert.equal(normalized.timeoutSeconds, 3600);
  assert.equal(normalized.questions.length, 1);
  assert.equal(normalized.questions[0].options.length, 6);
  assert.equal(
    normalized.questions[0].freeform_placeholder,
    "Add any extra context for this answer (optional).",
  );
  assert.deepEqual(
    normalized.questions[0].options[normalized.questions[0].options.length - 1],
    {
      id: USER_QUESTION_NONE_OF_THE_ABOVE_OPTION_ID,
      label: USER_QUESTION_NONE_OF_THE_ABOVE_OPTION_LABEL,
      description: "Use this if the listed choices do not fit. Add details below.",
    },
  );
});

test("normalizeUserQuestionRequest rejects duplicate ids and invalid option counts", () => {
  assert.throws(
    () =>
      normalizeUserQuestionRequest({
        chat_id: "chat-publish-1",
        questions: [
          {
            id: "duplicate",
            header: "One",
            question: "First question?",
            options: [
              { id: "a", label: "A" },
              { id: "b", label: "B" },
            ],
          },
          {
            id: "duplicate",
            header: "Two",
            question: "Second question?",
            options: [
              { id: "c", label: "C" },
              { id: "d", label: "D" },
            ],
          },
        ],
      }),
    /Duplicate question id/,
  );

  assert.throws(
    () =>
      normalizeUserQuestionRequest({
        chat_id: "chat-publish-1",
        questions: [
          {
            id: "single-option",
            header: "Header",
            question: "Question?",
            options: [{ id: "only", label: "Only" }],
          },
        ],
      }),
    /must contain between 2 and 5 items/,
  );

  assert.throws(
    () =>
      normalizeUserQuestionRequest({
        chat_id: "chat-publish-1",
        questions: [
          {
            id: "too-many-options",
            header: "Header",
            question: "Question?",
            options: [
              { id: "a", label: "A" },
              { id: "b", label: "B" },
              { id: "c", label: "C" },
              { id: "d", label: "D" },
              { id: "e", label: "E" },
              { id: "f", label: "F" },
            ],
          },
        ],
      }),
    /must contain between 2 and 5 items/,
  );

  assert.throws(
    () =>
      normalizeUserQuestionRequest({
        chat_id: "chat-publish-1",
        questions: [
          {
            id: "reserved-option",
            header: "Header",
            question: "Question?",
            options: [
              { id: USER_QUESTION_NONE_OF_THE_ABOVE_OPTION_ID, label: "Reserved" },
              { id: "b", label: "B" },
            ],
          },
        ],
      }),
    /cannot use reserved option id/,
  );

  assert.throws(
    () =>
      normalizeUserQuestionRequest({
        chat_id: "chat-publish-1",
        timeout_seconds: 3601,
        questions: [
          {
            id: "marketplace",
            header: "Marketplace",
            question: "Question?",
            options: [
              { id: "a", label: "A" },
              { id: "b", label: "B" },
            ],
          },
        ],
      }),
    /must be between 30 and 3600/,
  );

  assert.throws(
    () =>
      normalizeUserQuestionRequest({
        questions: [
          {
            id: "marketplace",
            header: "Marketplace",
            question: "Question?",
            options: [
              { id: "a", label: "A" },
              { id: "b", label: "B" },
            ],
          },
        ],
      }),
    /chat_id is required/,
  );
});

test("buildUserQuestionSubmittedResult validates answers and carries labels forward", () => {
  const flowEntry = {
    flowId: "flow-123",
    questions: [
      {
        id: "marketplace",
        options: [
          { id: "my-agent-skills", label: "My Agent Skills" },
          { id: "portico-ai-marketplace", label: "portico-ai-marketplace" },
        ],
      },
    ],
  };

  const submitted = buildUserQuestionSubmittedResult(flowEntry, [
    {
      question_id: "marketplace",
      selected_option_id: "my-agent-skills",
      freeform_text: "Use my repo for now.",
    },
  ]);

  assert.equal(submitted.success, true);
  assert.equal(submitted.status, "submitted");
  assert.deepEqual(submitted.answers, [
    {
      question_id: "marketplace",
      selected_option_id: "my-agent-skills",
      selected_option_label: "My Agent Skills",
      freeform_text: "Use my repo for now.",
    },
  ]);
});

test("shared user-question lifecycle allows multiple active agentic flows", () => {
  const state = require("./shared-state");
  const flowIds = ["flow-concurrent-a", "flow-concurrent-b"];

  function cleanup() {
    for (const flowId of flowIds) {
      const entry = state.userQuestionFlowResults.get(flowId);
      if (entry?.timeoutHandle) clearTimeout(entry.timeoutHandle);
      if (entry?.cleanupHandle) clearTimeout(entry.cleanupHandle);
      state.userQuestionFlowResults.delete(flowId);
      state.userQuestionFlowState.activeFlowIds?.delete?.(flowId);
    }
    if (flowIds.includes(state.userQuestionFlowState.activeFlowId)) {
      state.userQuestionFlowState.activeFlowId = null;
    }
  }

  cleanup();
  try {
    state.startUserQuestionFlow({
      flowId: flowIds[0],
      status: "in_progress",
      chatId: "chat-a",
      questions: [],
      result: null,
      startedAt: Date.now(),
    });
    state.startUserQuestionFlow({
      flowId: flowIds[1],
      status: "in_progress",
      chatId: "chat-b",
      questions: [],
      result: null,
      startedAt: Date.now(),
    });

    assert.equal(state.userQuestionFlowResults.get(flowIds[0]).status, "in_progress");
    assert.equal(state.userQuestionFlowResults.get(flowIds[1]).status, "in_progress");
    assert.equal(state.userQuestionFlowState.activeFlowIds.has(flowIds[0]), true);
    assert.equal(state.userQuestionFlowState.activeFlowIds.has(flowIds[1]), true);

    state.completeUserQuestionFlow(flowIds[0], {
      success: true,
      status: "submitted",
      flow_id: flowIds[0],
      answers: [],
    });

    assert.equal(state.userQuestionFlowResults.get(flowIds[0]).status, "completed");
    assert.equal(state.userQuestionFlowResults.get(flowIds[1]).status, "in_progress");
    assert.equal(state.userQuestionFlowState.activeFlowIds.has(flowIds[0]), false);
    assert.equal(state.userQuestionFlowState.activeFlowIds.has(flowIds[1]), true);
  } finally {
    cleanup();
  }
});

test("native-input snapshots expose inline questions but keep secure modal payloads private", () => {
  const state = require("./shared-state");
  const entries = [
    [state.userQuestionFlowResults, "native-question"],
    [state.sensitiveInfoFlowResults, "native-sensitive"],
    [state.chatWorkspaceConsentFlowResults, "native-workspace"],
  ];
  const cleanup = () => {
    for (const [collection, flowId] of entries) {
      const entry = collection.get(flowId);
      if (entry?.cleanupHandle) clearTimeout(entry.cleanupHandle);
      collection.delete(flowId);
      state.userQuestionFlowState.activeFlowIds?.delete?.(flowId);
    }
  };

  cleanup();
  try {
    state.startUserQuestionFlow({
      flowId: "native-question",
      status: "in_progress",
      chatId: "chat-native",
      questions: [{ id: "q1", question: "PRIVATE QUESTION" }],
      ownerWindowId: 42,
      presentation: "hidden",
      startedAt: 1,
    });
    state.startSensitiveInfoFlow({
      flowId: "native-sensitive",
      status: "in_progress",
      chatId: "chat-native",
      prompt: "PRIVATE PROMPT",
      preamble: "PRIVATE PREAMBLE",
      result: { sensitive_value: "TOP_SECRET_VALUE" },
      ownerWindowId: 42,
      presentation: "visible",
      startedAt: 2,
    });
    state.startChatWorkspaceConsentFlow({
      flowId: "native-workspace",
      status: "in_progress",
      chatId: "chat-native",
      hostPath: "/Users/private/.snowflake",
      preamble: "PRIVATE WORKSPACE PREAMBLE",
      ownerWindowId: 42,
      presentation: "hidden",
      startedAt: 3,
    });

    assert.equal(
      state.setNativeInputFlowPresentation("sensitive_info", "native-sensitive", "visible", 7),
      null,
    );
    const snapshot = state.buildNativeInputPresentationSnapshot(42);
    assert.deepEqual(snapshot, {
      version: 1,
      flows: [
        {
          kind: "user_question",
          flow_id: "native-question",
          chat_id: "chat-native",
          presentation: "hidden",
          item_count: 1,
          questions: [
            {
              id: "q1",
              header: undefined,
              question: "PRIVATE QUESTION",
              freeform_placeholder: null,
              options: [],
              components: [],
              components_gated_by_option_id: null,
            },
          ],
        },
        {
          kind: "sensitive_info",
          flow_id: "native-sensitive",
          chat_id: "chat-native",
          presentation: "visible",
          item_count: 1,
        },
        {
          kind: "chat_workspace_consent",
          flow_id: "native-workspace",
          chat_id: "chat-native",
          presentation: "hidden",
          item_count: 1,
        },
      ],
    });
    assert.doesNotMatch(
      JSON.stringify(snapshot),
      /TOP_SECRET_VALUE|snowflake|PRIVATE PROMPT|PRIVATE PREAMBLE|prompt|preamble|hostPath|sensitive_value/,
    );

    state.completeSensitiveInfoFlow("native-sensitive", { status: "submitted" });
    assert.equal(
      state.buildNativeInputPresentationSnapshot(42).flows.some(
        (flow) => flow.flow_id === "native-sensitive",
      ),
      false,
    );
  } finally {
    cleanup();
  }
});

test("buildUserQuestionSubmittedResult accepts the built-in fallback option", () => {
  const flowEntry = {
    flowId: "flow-123",
    questions: [
      {
        id: "marketplace",
        options: [
          { id: "my-agent-skills", label: "My Agent Skills" },
          {
            id: USER_QUESTION_NONE_OF_THE_ABOVE_OPTION_ID,
            label: USER_QUESTION_NONE_OF_THE_ABOVE_OPTION_LABEL,
          },
        ],
      },
    ],
  };

  const submitted = buildUserQuestionSubmittedResult(flowEntry, [
    {
      question_id: "marketplace",
      selected_option_id: USER_QUESTION_NONE_OF_THE_ABOVE_OPTION_ID,
      freeform_text: "Use a different repo instead.",
    },
  ]);

  assert.deepEqual(submitted.answers, [
    {
      question_id: "marketplace",
      selected_option_id: USER_QUESTION_NONE_OF_THE_ABOVE_OPTION_ID,
      selected_option_label: USER_QUESTION_NONE_OF_THE_ABOVE_OPTION_LABEL,
      freeform_text: "Use a different repo instead.",
    },
  ]);
});

test("buildUserQuestionSubmittedResult auto-selects fallback for freeform-only answers", () => {
  const flowEntry = {
    flowId: "flow-123",
    questions: [
      {
        id: "marketplace",
        options: [
          { id: "my-agent-skills", label: "My Agent Skills" },
          {
            id: USER_QUESTION_NONE_OF_THE_ABOVE_OPTION_ID,
            label: USER_QUESTION_NONE_OF_THE_ABOVE_OPTION_LABEL,
          },
        ],
      },
    ],
  };

  const submitted = buildUserQuestionSubmittedResult(flowEntry, [
    {
      question_id: "marketplace",
      selected_option_id: null,
      freeform_text: "Use a marketplace that is not listed.",
    },
  ]);

  assert.deepEqual(submitted.answers, [
    {
      question_id: "marketplace",
      selected_option_id: USER_QUESTION_NONE_OF_THE_ABOVE_OPTION_ID,
      selected_option_label: USER_QUESTION_NONE_OF_THE_ABOVE_OPTION_LABEL,
      freeform_text: "Use a marketplace that is not listed.",
    },
  ]);
});

test("buildUserQuestionSubmittedResult rejects answers without an option or freeform text", () => {
  const flowEntry = {
    flowId: "flow-123",
    questions: [
      {
        id: "marketplace",
        options: [
          { id: "my-agent-skills", label: "My Agent Skills" },
          {
            id: USER_QUESTION_NONE_OF_THE_ABOVE_OPTION_ID,
            label: USER_QUESTION_NONE_OF_THE_ABOVE_OPTION_LABEL,
          },
        ],
      },
    ],
  };

  assert.throws(
    () =>
      buildUserQuestionSubmittedResult(flowEntry, [
        {
          question_id: "marketplace",
          selected_option_id: null,
          freeform_text: "   ",
        },
      ]),
    /missing a response/,
  );

  assert.throws(
    () =>
      buildUserQuestionSubmittedResult(flowEntry, [
        {
          question_id: "marketplace",
          selected_option_id: USER_QUESTION_NONE_OF_THE_ABOVE_OPTION_ID,
          freeform_text: "   ",
        },
      ]),
    /Something else without an explanation/,
  );
});

test("dismissed and timeout helpers produce terminal results", () => {
  const flowEntry = { flowId: "flow-123" };

  assert.deepEqual(buildUserQuestionDismissedResult(flowEntry), {
    success: false,
    status: "dismissed",
    flow_id: "flow-123",
    answers: [],
    error: "User dismissed the question modal",
    message:
      "The user dismissed the question modal without submitting answers.",
  });

  assert.deepEqual(buildUserQuestionTimeoutResult(flowEntry), {
    success: false,
    status: "timeout",
    flow_id: "flow-123",
    answers: [],
    error: "User did not submit answers before the modal timed out",
    message: "The question modal timed out before the user submitted answers.",
  });
});

// ── Batch 8 item 7: curated component pickers ──────────────────────────────

test("normalizeUserQuestionRequest accepts a component-only question and adds no fallback option", () => {
  const normalized = normalizeUserQuestionRequest({
    chat_id: "chat-c",
    questions: [
      {
        id: "caps",
        header: "Capabilities",
        question: "What capabilities should your agent have?",
        components: [
          { type: "skill_picker", id: "skills", label: "Skills" },
          { type: "mcp_server_picker", id: "servers", multiple: true },
        ],
      },
    ],
  });
  const q = normalized.questions[0];
  assert.equal(q.options.length, 0); // no "Something else" fallback for component-only
  assert.equal(q.components.length, 2);
  assert.deepEqual(
    q.components.map((c) => c.type),
    ["skill_picker", "mcp_server_picker"],
  );
});

test("normalizeUserQuestionRequest allows options and components together (options keep the fallback)", () => {
  const normalized = normalizeUserQuestionRequest({
    chat_id: "chat-c",
    questions: [
      {
        id: "mix",
        header: "Mix",
        question: "Pick or choose a model",
        options: [
          { id: "a", label: "A" },
          { id: "b", label: "B" },
        ],
        components: [{ type: "model_picker", id: "model", multiple: false }],
      },
    ],
  });
  const q = normalized.questions[0];
  assert.equal(q.components.length, 1);
  assert.equal(q.options.at(-1).id, USER_QUESTION_NONE_OF_THE_ABOVE_OPTION_ID);
});

test("normalizeUserQuestionRequest rejects a question with neither options nor components", () => {
  assert.throws(
    () =>
      normalizeUserQuestionRequest({
        chat_id: "c",
        questions: [{ id: "x", header: "H", question: "Q?" }],
      }),
    /either options .* or components/,
  );
});

test("normalizeUserQuestionRequest rejects an unsupported component type", () => {
  assert.throws(
    () =>
      normalizeUserQuestionRequest({
        chat_id: "c",
        questions: [
          {
            id: "x",
            header: "H",
            question: "Q?",
            components: [{ type: "wat_picker", id: "w" }],
          },
        ],
      }),
    /is not supported/,
  );
});

test("buildUserQuestionSubmittedResult round-trips a picker selection into component_selections", () => {
  const flow = normalizeUserQuestionRequest({
    chat_id: "chat-c",
    questions: [
      {
        id: "caps",
        header: "Capabilities",
        question: "What capabilities?",
        components: [
          { type: "skill_picker", id: "skills", multiple: true },
          { type: "model_picker", id: "model", multiple: false },
        ],
      },
    ],
  });
  const flowEntry = { flowId: "f1", questions: flow.questions };
  const result = buildUserQuestionSubmittedResult(flowEntry, [
    {
      question_id: "caps",
      component_selections: {
        skills: ["company-knowledge", "web-search"],
        model: ["atlas-sonnet-5", "extra-ignored"],
      },
      freeform_text: "make it fast",
    },
  ]);
  const answer = result.answers[0];
  assert.deepEqual(answer.component_selections.skills, ["company-knowledge", "web-search"]);
  // single-select component caps to one id.
  assert.deepEqual(answer.component_selections.model, ["atlas-sonnet-5"]);
  assert.equal(answer.freeform_text, "make it fast");
  assert.equal(answer.selected_option_id, undefined);
});

test("buildUserQuestionSubmittedResult requires a selection or freeform for a component question", () => {
  const flow = normalizeUserQuestionRequest({
    chat_id: "chat-c",
    questions: [
      {
        id: "caps",
        header: "Capabilities",
        question: "What capabilities?",
        components: [{ type: "skill_picker", id: "skills" }],
      },
    ],
  });
  const flowEntry = { flowId: "f1", questions: flow.questions };
  assert.throws(
    () =>
      buildUserQuestionSubmittedResult(flowEntry, [
        { question_id: "caps", component_selections: { skills: [] } },
      ]),
    /missing a selection/,
  );
});

test("buildUserQuestionSubmittedResult requires a model pick and carries mixed option answers", () => {
  const flow = normalizeUserQuestionRequest({
    chat_id: "chat-c",
    questions: [
      {
        id: "model",
        header: "Model",
        question: "Which model?",
        components: [
          { type: "model_picker", id: "model" },
          { type: "reasoning_effort_picker", id: "effort", multiple: false },
        ],
      },
      {
        id: "caps",
        header: "Capabilities",
        question: "What capabilities?",
        options: [
          { id: "recommended", label: "Recommended set" },
          { id: "custom", label: "Custom" },
        ],
        components: [{ type: "skill_picker", id: "skills", multiple: false }],
      },
    ],
  });
  const flowEntry = { flowId: "f1", questions: flow.questions };

  // A note alone can't stand in for the model pick — the rule keys on the
  // component type, so it holds even without an explicit multiple:false.
  assert.throws(
    () =>
      buildUserQuestionSubmittedResult(flowEntry, [
        {
          question_id: "model",
          component_selections: { model: [], effort: [] },
          freeform_text: "whatever is cheapest",
        },
        {
          question_id: "caps",
          selected_option_id: "recommended",
          component_selections: { skills: [] },
        },
      ]),
    /missing a selection for model/,
  );

  const result = buildUserQuestionSubmittedResult(flowEntry, [
    {
      question_id: "model",
      component_selections: { model: ["atlas-sonnet-5"], effort: [] },
    },
    {
      question_id: "caps",
      selected_option_id: "recommended",
      component_selections: { skills: [] },
      freeform_text: "no extras needed",
    },
  ]);
  // Empty reasoning slider is fine (it is disabled for non-reasoning models).
  assert.deepEqual(result.answers[0].component_selections.model, ["atlas-sonnet-5"]);
  assert.equal(result.answers[0].selected_option_id, undefined);
  // Mixed question: the clicked option rides along with the picker answer,
  // and an empty single-select skill picker is allowed.
  assert.equal(result.answers[1].selected_option_id, "recommended");
  assert.equal(result.answers[1].selected_option_label, "Recommended set");
  assert.deepEqual(result.answers[1].component_selections.skills, []);
});

test("normalizeUserQuestionRequest bounds options even when components are present", () => {
  assert.throws(
    () =>
      normalizeUserQuestionRequest({
        chat_id: "chat-c",
        questions: [
          {
            id: "q1",
            header: "Pick",
            question: "Pick one",
            options: [{ id: "only", label: "Only" }],
            components: [{ type: "skill_picker", id: "skills" }],
          },
        ],
      }),
    /options must contain between 2 and 5 items/,
  );
});

// ── Optional component gate (components_gated_by_option_id) ─────────────────

function buildGatedCapabilitiesQuestion(overrides = {}) {
  return {
    id: "capabilities",
    header: "Capabilities",
    question: "What capabilities should your agent have?",
    options: [
      { id: "let_agent_decide", label: "Let the agent enable capabilities as needed" },
      { id: "specify", label: "I'll specify capabilities" },
    ],
    components: [
      { type: "skill_picker", id: "skills", label: "Skills" },
      { type: "mcp_server_picker", id: "servers", label: "Tool servers" },
    ],
    components_gated_by_option_id: "specify",
    ...overrides,
  };
}

test("normalizeUserQuestionRequest passes a valid component gate through (absent stays null)", () => {
  const normalized = normalizeUserQuestionRequest({
    chat_id: "chat-c",
    questions: [buildGatedCapabilitiesQuestion()],
  });
  assert.equal(normalized.questions[0].components_gated_by_option_id, "specify");

  const ungated = normalizeUserQuestionRequest({
    chat_id: "chat-c",
    questions: [buildGatedCapabilitiesQuestion({ components_gated_by_option_id: undefined })],
  });
  assert.equal(ungated.questions[0].components_gated_by_option_id, null);
});

test("normalizeUserQuestionRequest rejects invalid component gates", () => {
  // Unknown option id.
  assert.throws(
    () =>
      normalizeUserQuestionRequest({
        chat_id: "chat-c",
        questions: [
          buildGatedCapabilitiesQuestion({ components_gated_by_option_id: "wat" }),
        ],
      }),
    /components_gated_by_option_id "wat" does not match any option id/,
  );

  // A gate needs components to reveal.
  assert.throws(
    () =>
      normalizeUserQuestionRequest({
        chat_id: "chat-c",
        questions: [buildGatedCapabilitiesQuestion({ components: undefined })],
      }),
    /components_gated_by_option_id requires components/,
  );

  // A gate needs caller options to hide behind.
  assert.throws(
    () =>
      normalizeUserQuestionRequest({
        chat_id: "chat-c",
        questions: [buildGatedCapabilitiesQuestion({ options: undefined })],
      }),
    /components_gated_by_option_id requires options/,
  );

  // The reserved fallback is appended by the app, not the caller — it can
  // never be the gate.
  assert.throws(
    () =>
      normalizeUserQuestionRequest({
        chat_id: "chat-c",
        questions: [
          buildGatedCapabilitiesQuestion({
            components_gated_by_option_id: USER_QUESTION_NONE_OF_THE_ABOVE_OPTION_ID,
          }),
        ],
      }),
    /does not match any option id/,
  );
});

test("gated components are dropped when the user picks a non-gate option", () => {
  const flow = normalizeUserQuestionRequest({
    chat_id: "chat-c",
    questions: [buildGatedCapabilitiesQuestion()],
  });
  const flowEntry = { flowId: "f1", questions: flow.questions };

  const result = buildUserQuestionSubmittedResult(flowEntry, [
    {
      question_id: "capabilities",
      selected_option_id: "let_agent_decide",
      // Stray client-sent picker state must not leak into the answer.
      component_selections: { skills: ["stray-skill"], servers: ["server:stray"] },
    },
  ]);
  const answer = result.answers[0];
  assert.equal(answer.selected_option_id, "let_agent_decide");
  assert.equal(
    answer.selected_option_label,
    "Let the agent enable capabilities as needed",
  );
  assert.equal("component_selections" in answer, false);
});

test("gated components round-trip when the user picks the gate option", () => {
  const flow = normalizeUserQuestionRequest({
    chat_id: "chat-c",
    questions: [buildGatedCapabilitiesQuestion()],
  });
  const flowEntry = { flowId: "f1", questions: flow.questions };

  const result = buildUserQuestionSubmittedResult(flowEntry, [
    {
      question_id: "capabilities",
      selected_option_id: "specify",
      component_selections: {
        skills: ["company-knowledge"],
        servers: ["server:glean"],
      },
    },
  ]);
  const answer = result.answers[0];
  assert.equal(answer.selected_option_id, "specify");
  assert.equal(answer.selected_option_label, "I'll specify capabilities");
  assert.deepEqual(answer.component_selections.skills, ["company-knowledge"]);
  assert.deepEqual(answer.component_selections.servers, ["server:glean"]);
});

// ── Picker seeds (component default_selected / option component_defaults) ───

function buildSeededCapabilitiesQuestion(overrides = {}) {
  return {
    id: "capabilities",
    header: "Capabilities",
    question: "How should we set up capabilities?",
    options: [
      {
        id: "recommended",
        label: "Start from the recommended set (adjust below)",
        component_defaults: {
          skills: ["company-knowledge", "web-search"],
          servers: [],
        },
      },
      { id: "scratch", label: "Start from scratch" },
    ],
    components: [
      {
        type: "skill_picker",
        id: "skills",
        label: "Skills",
        default_selected: ["fallback-skill"],
      },
      { type: "mcp_server_picker", id: "servers", label: "Tool servers" },
    ],
    components_gated_by_option_id: "scratch",
    ...overrides,
  };
}

test("normalizeUserQuestionRequest passes picker seeds through (empty lists normalize predictably)", () => {
  const normalized = normalizeUserQuestionRequest({
    chat_id: "chat-c",
    questions: [buildSeededCapabilitiesQuestion()],
  });
  const q = normalized.questions[0];
  assert.deepEqual(q.options[0].component_defaults, {
    skills: ["company-knowledge", "web-search"],
    // Explicit [] survives: it means "reveal this picker empty".
    servers: [],
  });
  assert.equal(q.options[1].component_defaults, null);
  // The appended "Something else" fallback keeps its legacy 3-key shape.
  assert.equal("component_defaults" in q.options.at(-1), false);
  assert.deepEqual(q.components[0].default_selected, ["fallback-skill"]);
  assert.equal(q.components[1].default_selected, null);

  // Empty default_selected and empty component_defaults maps normalize to null.
  const emptied = normalizeUserQuestionRequest({
    chat_id: "chat-c",
    questions: [
      buildSeededCapabilitiesQuestion({
        options: [
          { id: "recommended", label: "Recommended", component_defaults: {} },
          { id: "scratch", label: "Start from scratch" },
        ],
        components: [
          { type: "skill_picker", id: "skills", default_selected: [] },
          { type: "mcp_server_picker", id: "servers" },
        ],
      }),
    ],
  });
  assert.equal(emptied.questions[0].options[0].component_defaults, null);
  assert.equal(emptied.questions[0].components[0].default_selected, null);
});

test("native-input snapshots carry picker seeds through to the inline card", () => {
  const state = require("./shared-state");
  const flowId = "native-question-seeds";
  const cleanup = () => {
    const entry = state.userQuestionFlowResults.get(flowId);
    if (entry?.cleanupHandle) clearTimeout(entry.cleanupHandle);
    state.userQuestionFlowResults.delete(flowId);
    state.userQuestionFlowState.activeFlowIds?.delete?.(flowId);
  };

  const normalized = normalizeUserQuestionRequest({
    chat_id: "chat-seeds",
    questions: [buildSeededCapabilitiesQuestion()],
  });

  cleanup();
  try {
    state.startUserQuestionFlow({
      flowId,
      status: "in_progress",
      chatId: "chat-seeds",
      questions: normalized.questions,
      ownerWindowId: 7,
      presentation: "visible",
      startedAt: 1,
    });

    const question = state.buildNativeInputPresentationSnapshot(7).flows[0].questions[0];
    const [recommended, scratch] = question.options;
    assert.deepEqual(recommended, {
      id: "recommended",
      label: "Start from the recommended set (adjust below)",
      description: "",
      // Explicit [] survives the snapshot: it means "reveal this picker empty".
      component_defaults: { skills: ["company-knowledge", "web-search"], servers: [] },
    });
    assert.equal(scratch.component_defaults, null);
    assert.deepEqual(question.components, [
      {
        id: "skills",
        type: "skill_picker",
        label: "Skills",
        multiple: true,
        default_selected: ["fallback-skill"],
      },
      {
        id: "servers",
        type: "mcp_server_picker",
        label: "Tool servers",
        multiple: true,
        default_selected: null,
      },
    ]);
    assert.equal(question.components_gated_by_option_id, "scratch");
  } finally {
    cleanup();
  }
});

test("normalizeUserQuestionRequest rejects malformed picker seeds", () => {
  // Unknown component id key.
  assert.throws(
    () =>
      normalizeUserQuestionRequest({
        chat_id: "chat-c",
        questions: [
          buildSeededCapabilitiesQuestion({
            options: [
              {
                id: "recommended",
                label: "Recommended",
                component_defaults: { wat: ["company-knowledge"] },
              },
              { id: "scratch", label: "Start from scratch" },
            ],
          }),
        ],
      }),
    /component_defaults key "wat" does not match any component id/,
  );

  // Defaults need components to seed.
  assert.throws(
    () =>
      normalizeUserQuestionRequest({
        chat_id: "chat-c",
        questions: [
          buildSeededCapabilitiesQuestion({
            components: undefined,
            components_gated_by_option_id: undefined,
          }),
        ],
      }),
    /component_defaults requires components/,
  );

  // Not an object.
  assert.throws(
    () =>
      normalizeUserQuestionRequest({
        chat_id: "chat-c",
        questions: [
          buildSeededCapabilitiesQuestion({
            options: [
              {
                id: "recommended",
                label: "Recommended",
                component_defaults: ["skills"],
              },
              { id: "scratch", label: "Start from scratch" },
            ],
          }),
        ],
      }),
    /component_defaults must be an object/,
  );

  // Oversized and duplicate id lists.
  const tooMany = Array.from({ length: 21 }, (_, i) => `skill-${i}`);
  assert.throws(
    () =>
      normalizeUserQuestionRequest({
        chat_id: "chat-c",
        questions: [
          buildSeededCapabilitiesQuestion({
            components: [
              { type: "skill_picker", id: "skills", default_selected: tooMany },
              { type: "mcp_server_picker", id: "servers" },
            ],
          }),
        ],
      }),
    /default_selected must contain at most 20 items/,
  );
  assert.throws(
    () =>
      normalizeUserQuestionRequest({
        chat_id: "chat-c",
        questions: [
          buildSeededCapabilitiesQuestion({
            components: [
              {
                type: "skill_picker",
                id: "skills",
                default_selected: ["dup", "dup"],
              },
              { type: "mcp_server_picker", id: "servers" },
            ],
          }),
        ],
      }),
    /Duplicate id in/,
  );
});

test("an option with component_defaults reveals components and carries picker output", () => {
  // No gate at all: the defaults-bearing option alone drives the reveal.
  const flow = normalizeUserQuestionRequest({
    chat_id: "chat-c",
    questions: [
      buildSeededCapabilitiesQuestion({ components_gated_by_option_id: undefined }),
    ],
  });
  const flowEntry = { flowId: "f1", questions: flow.questions };

  const revealed = buildUserQuestionSubmittedResult(flowEntry, [
    {
      question_id: "capabilities",
      selected_option_id: "recommended",
      component_selections: {
        skills: ["company-knowledge"],
        servers: ["server:glean"],
      },
    },
  ]);
  assert.equal(revealed.answers[0].selected_option_id, "recommended");
  assert.deepEqual(revealed.answers[0].component_selections.skills, [
    "company-knowledge",
  ]);
  assert.deepEqual(revealed.answers[0].component_selections.servers, [
    "server:glean",
  ]);

  // A non-revealing option answers as a plain option; stray client-sent picker
  // state must not leak into the answer.
  const hidden = buildUserQuestionSubmittedResult(flowEntry, [
    {
      question_id: "capabilities",
      selected_option_id: "scratch",
      component_selections: { skills: ["stray-skill"] },
    },
  ]);
  assert.equal(hidden.answers[0].selected_option_id, "scratch");
  assert.equal("component_selections" in hidden.answers[0], false);
});

test("gate and component_defaults coexist: both reveal, other options stay plain", () => {
  const flow = normalizeUserQuestionRequest({
    chat_id: "chat-c",
    questions: [
      buildSeededCapabilitiesQuestion({
        options: [
          {
            id: "recommended",
            label: "Start from the recommended set (adjust below)",
            component_defaults: { skills: ["company-knowledge"] },
          },
          { id: "scratch", label: "Start from scratch" },
          { id: "let_agent_decide", label: "Let the agent decide" },
        ],
      }),
    ],
  });
  const flowEntry = { flowId: "f1", questions: flow.questions };

  // The gate option ("scratch") still reveals and round-trips selections.
  const viaGate = buildUserQuestionSubmittedResult(flowEntry, [
    {
      question_id: "capabilities",
      selected_option_id: "scratch",
      component_selections: { skills: ["hand-picked"], servers: [] },
    },
  ]);
  assert.deepEqual(viaGate.answers[0].component_selections.skills, ["hand-picked"]);

  // The defaults option reveals too.
  const viaDefaults = buildUserQuestionSubmittedResult(flowEntry, [
    {
      question_id: "capabilities",
      selected_option_id: "recommended",
      component_selections: { skills: ["company-knowledge"], servers: [] },
    },
  ]);
  assert.deepEqual(viaDefaults.answers[0].component_selections.skills, [
    "company-knowledge",
  ]);

  // Any other option stays a plain-option answer.
  const plain = buildUserQuestionSubmittedResult(flowEntry, [
    {
      question_id: "capabilities",
      selected_option_id: "let_agent_decide",
      component_selections: { skills: ["stray"] },
    },
  ]);
  assert.equal("component_selections" in plain.answers[0], false);
});

test("the model-picker mandate only applies while the gate option is selected", () => {
  const flow = normalizeUserQuestionRequest({
    chat_id: "chat-c",
    questions: [
      buildGatedCapabilitiesQuestion({
        components: [
          { type: "model_picker", id: "model", multiple: false },
          { type: "skill_picker", id: "skills" },
        ],
      }),
    ],
  });
  const flowEntry = { flowId: "f1", questions: flow.questions };

  // Gated off: no model pick required, the answer is the plain option.
  const result = buildUserQuestionSubmittedResult(flowEntry, [
    { question_id: "capabilities", selected_option_id: "let_agent_decide" },
  ]);
  assert.equal(result.answers[0].selected_option_id, "let_agent_decide");
  assert.equal("component_selections" in result.answers[0], false);

  // Gate selected: the mandate applies again.
  assert.throws(
    () =>
      buildUserQuestionSubmittedResult(flowEntry, [
        {
          question_id: "capabilities",
          selected_option_id: "specify",
          component_selections: { model: [], skills: [] },
        },
      ]),
    /missing a selection for model/,
  );
});
