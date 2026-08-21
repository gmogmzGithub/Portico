# Ask User Question

## Status

This feature now targets the current Electron-native control-plane stack. The old inline Open WebUI / Svelte / continuation-job design is obsolete and should not be used as implementation guidance.

## Current Architecture

The flow matches the existing OAuth and guided-config patterns:

1. `skills_ask_user_question` runs in the Rust `skills-server`.
2. The Rust tool calls the Electron REST API:
   - `POST /api/trigger-user-question-flow`
   - `GET /api/user-question-flow-status/:flowId`
3. Electron broadcasts `user-question-requested` to renderer windows.
4. The renderer opens a native modal above the OWUI browser view using the same overlay suppression / macOS drag-no-drag pattern as the OAuth wizard.
5. The renderer sends `user-question-completed` back to the Electron main process when the user submits or dismisses.
6. Electron stores the terminal result and the Rust tool polls until it can return that result to the model.

## Tool Contract

`skills_ask_user_question` accepts:

- `questions`: 1-5 questions
- each question includes:
  - `id`
  - `header`
  - `question`
  - `options`: 2-5 concrete single-select choices
  - optional `freeform_placeholder`
- optional `timeout_seconds`

The modal automatically appends one generic `Something else` option using the
stable reserved id `none_of_the_above`. Callers must not provide generic
fallback choices such as `Something else`, `Other`, or `None of the above`.
Caller-supplied choices should be concrete and distinct, not options whose only
purpose is for the user to describe, specify, or customize the answer in notes.

The tool blocks until it returns one terminal result:

- `status: "submitted"` with one answer per question
- `status: "dismissed"`
- `status: "timeout"`
- `status: "error"`

Each submitted answer includes:

- `question_id`
- `selected_option_id`
- `selected_option_label`
- `freeform_text`

## UX Requirements

- Use the same visual shell and layering strategy as the OAuth / guided-config modals.
- Keep the modal above the OWUI browser view.
- Support multiple questions in a single flow.
- Let the user move between questions, edit answers, and review everything before submitting.
- Provide an optional freeform notes field for each question.
- Do not allow accidental backdrop dismissal for backend-requested flows.

## Guidance Updates

The shipped guidance should steer models toward `skills_ask_user_question` when they need a short blocking user decision, especially for publishing flows such as choosing a marketplace target.
