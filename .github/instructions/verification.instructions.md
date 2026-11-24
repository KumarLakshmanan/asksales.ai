---
applyTo: '**'
---

# Verification Command Instructions

This document explains the mandatory `vscode_askQuestions` verification flow used by Copilot and other assistants in this repository.

Summary

- The `vscode_askQuestions` verification step is REQUIRED and ABSOLUTE for every change made to this repository. It must be executed and cannot be skipped.
- When creating or updating TODO lists via `manage_todo_list`, always append the verification question as the final TODO item. The verification TODO must remain the last item and must not be removed or bypassed.

Usage

- Use the `vscode_askQuestions` helper to ask a single, clear verification question after completing changes. Example:

```js
await vscode_askQuestions({
  questions: [
    {
      header: 'verification',
      question: 'Have all requested fixes been completed successfully?',
      options: [
        { label: 'Yes', value: 'yes' },
        { label: 'No', value: 'no' },
      ],
      allowFreeformInput: true
    }
  ]
});
```

- The verification question should be specific to the change when appropriate. For example, when creating this file, the question could be:

```js
await vscode_askQuestions({
  questions: [
    {
      header: 'verification',
      question: 'Has .github/instructions/verification.instructions.md been created with the required verification guidance and the verification-as-final-TODO rule?',
      options: [
        { label: 'Yes', value: 'yes' },
        { label: 'No', value: 'no' },
      ],
      allowFreeformInput: true
    }
  ]
});
```

TODO Lists

- When adding or updating a `todoList` via the `manage_todo_list` tool, always append the verification TODO as the last item. Example structure:

```js
await manage_todo_list({
  todoList: [
    { id: 1, title: 'Create verification.instructions.md', status: 'completed' },
    { id: 2, title: 'Run vscode_askQuestions verification (must be final TODO)', status: 'in-progress' }
  ]
});
```

- The verification TODO must be answered "Yes" before marking the overall task as completed. If the verification answer is "No" or returns additional notes, address the issues immediately and re-run the verification check until it returns "Yes".

Rules & Best Practices

- Keep the `questions` array structure intact; use `header: 'verification'` and include at least the two options shown above (`Yes` / `No`).
- The verification step is the authoritative signal that work is complete. Do not mark changes as done without a successful verification answer.

Contact

If you're unsure how to phrase a verification question for a particular change, ask the repository owner or core maintainer for guidance.
