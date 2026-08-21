const DEFAULT_USER_QUESTION_TIMEOUT_SECONDS = 60 * 60;
const MIN_USER_QUESTION_TIMEOUT_SECONDS = 30;
const MAX_USER_QUESTION_TIMEOUT_SECONDS = 60 * 60;
const MAX_USER_QUESTION_COUNT = 5;
const MAX_USER_QUESTION_OPTIONS = 5;
const MIN_USER_QUESTION_OPTIONS = 2;
const DEFAULT_FREEFORM_PLACEHOLDER = "Add any extra context for this answer (optional).";
const USER_QUESTION_NONE_OF_THE_ABOVE_OPTION_ID = "none_of_the_above";
const USER_QUESTION_NONE_OF_THE_ABOVE_OPTION_LABEL = "Something else";
const USER_QUESTION_NONE_OF_THE_ABOVE_OPTION_DESCRIPTION =
  "Use this if the listed choices do not fit. Add details below.";

function requireTrimmedString(value, fieldName, { maxLength = 1000 } = {}) {
  if (value == null) {
    throw new Error(`${fieldName} is required`);
  }
  if (typeof value !== "string") {
    throw new Error(`${fieldName} must be a string`);
  }

  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${fieldName} is required`);
  }
  if (trimmed.length > maxLength) {
    throw new Error(`${fieldName} must be ${maxLength} characters or fewer`);
  }
  return trimmed;
}

function optionalTrimmedString(value, fieldName, { maxLength = 1000 } = {}) {
  if (value == null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`${fieldName} must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.length > maxLength) {
    throw new Error(`${fieldName} must be ${maxLength} characters or fewer`);
  }
  return trimmed;
}

function normalizeTimeoutSeconds(rawTimeoutSeconds) {
  if (rawTimeoutSeconds == null) {
    return DEFAULT_USER_QUESTION_TIMEOUT_SECONDS;
  }

  if (!Number.isInteger(rawTimeoutSeconds)) {
    throw new Error("timeout_seconds must be an integer");
  }
  if (
    rawTimeoutSeconds < MIN_USER_QUESTION_TIMEOUT_SECONDS ||
    rawTimeoutSeconds > MAX_USER_QUESTION_TIMEOUT_SECONDS
  ) {
    throw new Error(
      `timeout_seconds must be between ${MIN_USER_QUESTION_TIMEOUT_SECONDS} and ${MAX_USER_QUESTION_TIMEOUT_SECONDS}`,
    );
  }

  return rawTimeoutSeconds;
}

function ensureOptionIdIsNotReserved(optionId, fieldName) {
  if (optionId === USER_QUESTION_NONE_OF_THE_ABOVE_OPTION_ID) {
    throw new Error(
      `${fieldName} cannot use reserved option id "${USER_QUESTION_NONE_OF_THE_ABOVE_OPTION_ID}"`,
    );
  }
}

const USER_QUESTION_COMPONENT_TYPES = new Set([
  "skill_picker",
  "mcp_server_picker",
  "model_picker",
  "reasoning_effort_picker",
]);
const MAX_USER_QUESTION_COMPONENTS = 4;
const MAX_USER_QUESTION_COMPONENT_DEFAULT_IDS = 20;

// Normalize an optional list of default-selection ids (a component's
// default_selected, or one value of an option's component_defaults map).
// Absent/null — and, unless keepEmpty, an empty list — normalize to null so
// legacy payloads stay byte-identical. keepEmpty preserves an explicit []
// where it is meaningful ("reveal this picker empty"). Mirrors the Rust
// validator in skills-server questions.rs.
function normalizeDefaultIdList(value, fieldName, { keepEmpty = false } = {}) {
  if (value === undefined || value === null) {
    return null;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${fieldName} must be an array of strings`);
  }
  if (value.length === 0) {
    return keepEmpty ? [] : null;
  }
  if (value.length > MAX_USER_QUESTION_COMPONENT_DEFAULT_IDS) {
    throw new Error(
      `${fieldName} must contain at most ${MAX_USER_QUESTION_COMPONENT_DEFAULT_IDS} items`,
    );
  }
  const seen = new Set();
  return value.map((entry, entryIndex) => {
    const id = requireTrimmedString(entry, `${fieldName}[${entryIndex}]`, {
      maxLength: 200,
    });
    if (seen.has(id)) {
      throw new Error(`Duplicate id in ${fieldName}: ${id}`);
    }
    seen.add(id);
    return id;
  });
}

// An option "reveals" the question's components when it carries picker seeds.
// Shared by the answer-side gating rule; the renderer mirrors this helper.
function optionHasComponentDefaults(option) {
  return Boolean(
    option &&
      option.component_defaults &&
      typeof option.component_defaults === "object" &&
      !Array.isArray(option.component_defaults) &&
      Object.keys(option.component_defaults).length > 0,
  );
}

// Normalize the optional curated capability pickers on a question. Accepts the
// Rust-normalized shape ({type,id,label,multiple}) and re-validates so the
// modal always receives a clean list.
function normalizeQuestionComponents(rawComponents, questionIndex) {
  if (rawComponents === undefined || rawComponents === null) {
    return [];
  }
  if (!Array.isArray(rawComponents)) {
    throw new Error(`questions[${questionIndex}].components must be an array`);
  }
  if (rawComponents.length === 0) {
    return [];
  }
  if (rawComponents.length > MAX_USER_QUESTION_COMPONENTS) {
    throw new Error(
      `questions[${questionIndex}].components must contain at most ${MAX_USER_QUESTION_COMPONENTS} items`,
    );
  }
  const seen = new Set();
  return rawComponents.map((component, componentIndex) => {
    if (!component || typeof component !== "object" || Array.isArray(component)) {
      throw new Error(
        `questions[${questionIndex}].components[${componentIndex}] must be an object`,
      );
    }
    const type = requireTrimmedString(
      component.type,
      `questions[${questionIndex}].components[${componentIndex}].type`,
      { maxLength: 60 },
    );
    if (!USER_QUESTION_COMPONENT_TYPES.has(type)) {
      throw new Error(
        `questions[${questionIndex}].components[${componentIndex}].type "${type}" is not supported`,
      );
    }
    const componentId = requireTrimmedString(
      component.id,
      `questions[${questionIndex}].components[${componentIndex}].id`,
      { maxLength: 120 },
    );
    if (seen.has(componentId)) {
      throw new Error(
        `Duplicate component id in questions[${questionIndex}]: ${componentId}`,
      );
    }
    seen.add(componentId);
    return {
      type,
      id: componentId,
      label: optionalTrimmedString(
        component.label,
        `questions[${questionIndex}].components[${componentIndex}].label`,
        { maxLength: 200 },
      ),
      multiple: component.multiple !== false,
      // Optional seed applied when the picker is shown ungated (or when the
      // revealing option carries no component_defaults entry for it).
      default_selected: normalizeDefaultIdList(
        component.default_selected,
        `questions[${questionIndex}].components[${componentIndex}].default_selected`,
      ),
    };
  });
}

function normalizeUserQuestionRequest(payload = {}) {
  const chatId = requireTrimmedString(payload?.chat_id, "chat_id", {
    maxLength: 120,
  });
  const questions = Array.isArray(payload?.questions) ? payload.questions : null;
  if (!questions) {
    throw new Error("questions must be an array");
  }
  if (questions.length < 1 || questions.length > MAX_USER_QUESTION_COUNT) {
    throw new Error(`questions must contain between 1 and ${MAX_USER_QUESTION_COUNT} items`);
  }

  const seenQuestionIds = new Set();
  const normalizedQuestions = questions.map((question, questionIndex) => {
    if (!question || typeof question !== "object" || Array.isArray(question)) {
      throw new Error(`questions[${questionIndex}] must be an object`);
    }

    const id = requireTrimmedString(question.id, `questions[${questionIndex}].id`, {
      maxLength: 120,
    });
    if (seenQuestionIds.has(id)) {
      throw new Error(`Duplicate question id: ${id}`);
    }
    seenQuestionIds.add(id);

    const header = requireTrimmedString(
      question.header,
      `questions[${questionIndex}].header`,
      { maxLength: 80 },
    );
    const prompt = requireTrimmedString(
      question.question,
      `questions[${questionIndex}].question`,
      { maxLength: 1000 },
    );
    const freeformPlaceholder =
      optionalTrimmedString(
        question.freeform_placeholder,
        `questions[${questionIndex}].freeform_placeholder`,
        { maxLength: 200 },
      ) || DEFAULT_FREEFORM_PLACEHOLDER;

    // Curated capability pickers (skill/mcp/model) the modal renders instead of
    // or alongside plain options. When present, options become optional.
    const components = normalizeQuestionComponents(question.components, questionIndex);
    const hasComponents = components.length > 0;
    const hasOptionsArray = Array.isArray(question.options);
    if (!hasOptionsArray && !hasComponents) {
      throw new Error(
        `questions[${questionIndex}] must provide either options (${MIN_USER_QUESTION_OPTIONS}-${MAX_USER_QUESTION_OPTIONS}) or components`,
      );
    }
    // Options obey the 2-5 bound whenever provided (mirrors the Rust
    // validator); an empty array alongside components means component-only.
    if (hasOptionsArray && (question.options.length > 0 || !hasComponents)) {
      if (
        question.options.length < MIN_USER_QUESTION_OPTIONS ||
        question.options.length > MAX_USER_QUESTION_OPTIONS
      ) {
        throw new Error(
          `questions[${questionIndex}].options must contain between ${MIN_USER_QUESTION_OPTIONS} and ${MAX_USER_QUESTION_OPTIONS} items`,
        );
      }
    }

    const seenOptionIds = new Set();
    const options = (hasOptionsArray ? question.options : []).map((option, optionIndex) => {
      if (!option || typeof option !== "object" || Array.isArray(option)) {
        throw new Error(
          `questions[${questionIndex}].options[${optionIndex}] must be an object`,
        );
      }

      const optionId = requireTrimmedString(
        option.id,
        `questions[${questionIndex}].options[${optionIndex}].id`,
        { maxLength: 120 },
      );
      ensureOptionIdIsNotReserved(
        optionId,
        `questions[${questionIndex}].options[${optionIndex}].id`,
      );
      if (seenOptionIds.has(optionId)) {
        throw new Error(`Duplicate option id for question ${id}: ${optionId}`);
      }
      seenOptionIds.add(optionId);

      // Optional per-option picker seeds: choosing this option reveals the
      // question's components prefilled with these ids. Keys must name
      // declared component ids. Mirrors the Rust validator.
      let componentDefaults = null;
      const rawDefaults = option.component_defaults;
      if (rawDefaults !== undefined && rawDefaults !== null) {
        if (typeof rawDefaults !== "object" || Array.isArray(rawDefaults)) {
          throw new Error(
            `questions[${questionIndex}].options[${optionIndex}].component_defaults must be an object`,
          );
        }
        const defaultKeys = Object.keys(rawDefaults);
        if (defaultKeys.length > 0) {
          if (!hasComponents) {
            throw new Error(
              `questions[${questionIndex}].options[${optionIndex}].component_defaults requires components`,
            );
          }
          const componentIds = new Set(components.map((component) => component.id));
          componentDefaults = {};
          for (const key of defaultKeys) {
            if (!componentIds.has(key)) {
              throw new Error(
                `questions[${questionIndex}].options[${optionIndex}].component_defaults key "${key}" does not match any component id`,
              );
            }
            componentDefaults[key] =
              normalizeDefaultIdList(
                rawDefaults[key],
                `questions[${questionIndex}].options[${optionIndex}].component_defaults.${key}`,
                { keepEmpty: true },
              ) || [];
          }
        }
      }

      return {
        id: optionId,
        label: requireTrimmedString(
          option.label,
          `questions[${questionIndex}].options[${optionIndex}].label`,
          { maxLength: 120 },
        ),
        description: optionalTrimmedString(
          option.description,
          `questions[${questionIndex}].options[${optionIndex}].description`,
          { maxLength: 280 },
        ),
        component_defaults: componentDefaults,
      };
    });
    // The "Something else" fallback only makes sense for option-driven
    // questions. Component-only questions collect their answer from the picker.
    if (options.length > 0) {
      options.push({
        id: USER_QUESTION_NONE_OF_THE_ABOVE_OPTION_ID,
        label: USER_QUESTION_NONE_OF_THE_ABOVE_OPTION_LABEL,
        description: USER_QUESTION_NONE_OF_THE_ABOVE_OPTION_DESCRIPTION,
      });
    }

    // Optional gate: the components stay hidden until the user selects this
    // caller-supplied option. seenOptionIds only holds caller ids, so the
    // reserved fallback can never gate. Mirrors the Rust validator.
    const componentsGatedByOptionId = optionalTrimmedString(
      question.components_gated_by_option_id,
      `questions[${questionIndex}].components_gated_by_option_id`,
      { maxLength: 120 },
    );
    if (componentsGatedByOptionId) {
      if (!hasComponents) {
        throw new Error(
          `questions[${questionIndex}].components_gated_by_option_id requires components`,
        );
      }
      if (seenOptionIds.size === 0) {
        throw new Error(
          `questions[${questionIndex}].components_gated_by_option_id requires options`,
        );
      }
      if (!seenOptionIds.has(componentsGatedByOptionId)) {
        throw new Error(
          `questions[${questionIndex}].components_gated_by_option_id "${componentsGatedByOptionId}" does not match any option id`,
        );
      }
    }

    return {
      id,
      header,
      question: prompt,
      freeform_placeholder: freeformPlaceholder,
      options,
      components,
      components_gated_by_option_id: componentsGatedByOptionId || null,
    };
  });

  return {
    chatId,
    questions: normalizedQuestions,
    timeoutSeconds: normalizeTimeoutSeconds(payload?.timeout_seconds),
  };
}

function buildUserQuestionSubmittedResult(flowEntry, answers) {
  if (!flowEntry || !Array.isArray(flowEntry.questions)) {
    throw new Error("Active flow questions are unavailable");
  }
  if (!Array.isArray(answers)) {
    throw new Error("answers must be an array");
  }

  const answerMap = new Map();
  for (const rawAnswer of answers) {
    if (!rawAnswer || typeof rawAnswer !== "object" || Array.isArray(rawAnswer)) {
      throw new Error("Each answer must be an object");
    }

    const questionId = requireTrimmedString(rawAnswer.question_id, "answer.question_id", {
      maxLength: 120,
    });
    if (answerMap.has(questionId)) {
      throw new Error(`Duplicate answer for question ${questionId}`);
    }

    const selectedOptionId = optionalTrimmedString(
      rawAnswer.selected_option_id,
      `answer.selected_option_id (${questionId})`,
      { maxLength: 120 },
    );
    const freeformText = optionalTrimmedString(
      rawAnswer.freeform_text,
      `answer.freeform_text (${questionId})`,
      { maxLength: 4000 },
    );

    answerMap.set(questionId, {
      selectedOptionId,
      freeformText,
      componentSelections:
        rawAnswer.component_selections &&
        typeof rawAnswer.component_selections === "object" &&
        !Array.isArray(rawAnswer.component_selections)
          ? rawAnswer.component_selections
          : null,
    });
  }

  // Translate a picker selection back into the answer contract. Returns a
  // { [componentId]: [selected ids] } map validated against the question's
  // declared components; unknown/extra keys are ignored.
  function resolveComponentSelections(question, answer) {
    const raw = answer.componentSelections || {};
    const resolved = {};
    for (const component of question.components) {
      const value = raw[component.id];
      const ids = Array.isArray(value)
        ? value
            .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
            .filter(Boolean)
        : [];
      resolved[component.id] = component.multiple ? ids : ids.slice(0, 1);
    }
    return resolved;
  }

  function resolveSubmittedOption(question, answer) {
    if (answer.selectedOptionId) {
      const option = question.options.find(
        (candidate) => candidate.id === answer.selectedOptionId,
      );
      if (!option) {
        throw new Error(
          `Answer for question ${question.id} used unknown option ${answer.selectedOptionId}`,
        );
      }
      if (
        option.id === USER_QUESTION_NONE_OF_THE_ABOVE_OPTION_ID &&
        !answer.freeformText
      ) {
        throw new Error(
          `Answer for question ${question.id} selected ${USER_QUESTION_NONE_OF_THE_ABOVE_OPTION_LABEL} without an explanation`,
        );
      }
      return option;
    }

    if (!answer.freeformText) {
      throw new Error(`Answer for question ${question.id} is missing a response`);
    }

    const fallbackOption = question.options.find(
      (candidate) => candidate.id === USER_QUESTION_NONE_OF_THE_ABOVE_OPTION_ID,
    );
    if (!fallbackOption) {
      throw new Error(
        `Answer for question ${question.id} omitted selected_option_id, but the built-in fallback option is unavailable`,
      );
    }

    return fallbackOption;
  }

  // Reveal rule (the renderer mirrors it): with a gate or any option carrying
  // component_defaults, the components are option-driven — only the gate
  // option or a defaults-bearing option carries picker output; any other (or
  // no) option answers as a plain option, dropping client-sent
  // component_selections and skipping the model_picker mandate. Without
  // either, components are always active (legacy, incl. component-only
  // questions).
  function areComponentsActiveForAnswer(question, answer) {
    if (!Array.isArray(question.components) || question.components.length === 0) {
      return false;
    }
    const gate = question.components_gated_by_option_id;
    const hasGate = typeof gate === "string" && Boolean(gate);
    const options = Array.isArray(question.options) ? question.options : [];
    if (!hasGate && !options.some(optionHasComponentDefaults)) {
      return true;
    }
    if (!answer.selectedOptionId) {
      return false;
    }
    if (hasGate && answer.selectedOptionId === gate) {
      return true;
    }
    return optionHasComponentDefaults(
      options.find((option) => option.id === answer.selectedOptionId),
    );
  }

  const normalizedAnswers = flowEntry.questions.map((question) => {
    const answer = answerMap.get(question.id);
    if (!answer) {
      throw new Error(`Missing answer for question ${question.id}`);
    }

    // Component-driven questions return the picker selection instead of an option.
    if (areComponentsActiveForAnswer(question, answer)) {
      const componentSelections = resolveComponentSelections(question, answer);
      // Mirrors the renderer gate: the base model must come from the model
      // picker — notes or a plain option can't stand in for it.
      const missingModelPick = question.components.find(
        (component) =>
          component.type === "model_picker" &&
          componentSelections[component.id].length === 0,
      );
      if (missingModelPick) {
        throw new Error(
          `Answer for question ${question.id} is missing a selection for ${missingModelPick.id}`,
        );
      }
      // Mixed options+components: a clicked option rides along with the
      // picker selections.
      const selectedOption =
        answer.selectedOptionId && question.options.length > 0
          ? resolveSubmittedOption(question, answer)
          : null;
      const anySelected = Object.values(componentSelections).some((ids) => ids.length > 0);
      if (!anySelected && !answer.freeformText && !selectedOption) {
        throw new Error(`Answer for question ${question.id} is missing a selection`);
      }
      return {
        question_id: question.id,
        ...(selectedOption
          ? {
              selected_option_id: selectedOption.id,
              selected_option_label: selectedOption.label,
            }
          : {}),
        component_selections: componentSelections,
        freeform_text: answer.freeformText,
      };
    }

    const option = resolveSubmittedOption(question, answer);

    return {
      question_id: question.id,
      selected_option_id: option.id,
      selected_option_label: option.label,
      freeform_text: answer.freeformText,
    };
  });

  if (answerMap.size !== flowEntry.questions.length) {
    throw new Error("Answers contained unknown question ids");
  }

  return {
    success: true,
    status: "submitted",
    flow_id: flowEntry.flowId,
    answers: normalizedAnswers,
    message:
      normalizedAnswers.length === 1
        ? "User submitted 1 answer."
        : `User submitted ${normalizedAnswers.length} answers.`,
  };
}

function buildUserQuestionDismissedResult(flowEntry) {
  return {
    success: false,
    status: "dismissed",
    flow_id: flowEntry?.flowId || null,
    answers: [],
    error: "User dismissed the question modal",
    message: "The user dismissed the question modal without submitting answers.",
  };
}

function buildUserQuestionTimeoutResult(flowEntry) {
  return {
    success: false,
    status: "timeout",
    flow_id: flowEntry?.flowId || null,
    answers: [],
    error: "User did not submit answers before the modal timed out",
    message: "The question modal timed out before the user submitted answers.",
  };
}

function buildUserQuestionCancelledResult(flowEntry, reason) {
  const detail =
    typeof reason === "string" && reason.trim() ? ` (${reason.trim()})` : "";
  return {
    success: false,
    status: "cancelled",
    flow_id: flowEntry?.flowId || null,
    answers: [],
    error: `The question request was cancelled before the user answered${detail}`,
    message:
      "The requesting tool call ended before the user answered, so the question modal was closed.",
  };
}

function buildUserQuestionErrorResult(flowEntry, error) {
  const message =
    typeof error === "string" && error.trim()
      ? error.trim()
      : "Question flow failed";

  return {
    success: false,
    status: "error",
    flow_id: flowEntry?.flowId || null,
    answers: [],
    error: message,
    message,
  };
}

module.exports = {
  DEFAULT_FREEFORM_PLACEHOLDER,
  DEFAULT_USER_QUESTION_TIMEOUT_SECONDS,
  USER_QUESTION_NONE_OF_THE_ABOVE_OPTION_ID,
  USER_QUESTION_NONE_OF_THE_ABOVE_OPTION_LABEL,
  normalizeUserQuestionRequest,
  buildUserQuestionSubmittedResult,
  buildUserQuestionDismissedResult,
  buildUserQuestionTimeoutResult,
  buildUserQuestionCancelledResult,
  buildUserQuestionErrorResult,
};
