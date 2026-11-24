---
applyTo: '**'
---

# Copilot Instructions

This document guides how GitHub Copilot operates in this repository. Always follow these rules when performing tasks.

## Workflow Summary
1. **Understand the request:** Read the user’s prompt and clarify the goals, requirements, constraints, and success criteria. Craft the task accordingly.
2. **Explore before acting:** If a requested file is unfamiliar, open and read it before proposing any modifications.
3. **Implement changes directly:** Apply edits without asking for confirmation. Before editing, show a one-line summary of the intended change.
4. **Shell commands must start at repo root:** Always prefix with a `cd` to the workspace root.

   ```bash
   cd /Users/lakshmananr/projects/salesmarketing; **your command here**
   ```

## Verification Process
After completing the work:

- Use `vscode_askQuestions` to confirm success instead of manually inspecting files. This verification step is REQUIRED and ABSOLUTE — it must be executed for every change and must not be skipped or treated as optional.
- When creating or updating TODO tasks, always append the verification question as the final TODO item; the verification step must remain the last task and must not be removed or bypassed.
- Example:

  ```js
  await vscode_askQuestions({
    questions: [
      {
        header: 'verification',
        question: 'Have all requested fixes been completed successfully?',
        options: [
          { label: 'Yes', recommended: true },
          { label: 'No' },
        ],
        allowFreeformInput: true
      }
    ]
  });
  ```

- Interpret verification as successful only when the response is clearly affirmative (`Yes` selected or free text equivalent like `yes`, `done`, `fixed`).
- If the response is `No`, unclear, or includes additional requested work, address the feedback immediately and re-run `vscode_askQuestions`.
- Do not claim completion until verification returns a clean affirmative response with no pending follow-ups.

## Critical Rules
- **Never bypass verification.** Always run the ask-questions check before claiming completion.
 - **Verification enforcement:** The `vscode_askQuestions` verification command is mandatory for every change and must be included as the final TODO task when adding or updating TODO lists. Do not mark a change as complete until verification returns a clean "yes".
- **Handle follow-up tasks promptly.** New issues surfaced during verification must be fixed without debate.
- **Maintain the ask-questions structure exactly**; keep `header: 'verification'`, preserve `allowFreeformInput: true`, and keep `Yes/No` options.
- **Flutter code:** Do not run or build unless explicitly instructed—analysis only.

## Dirty Worktree Handling
- If unrelated files are already modified, continue and finalize the requested task on the target files.
- Do not interrupt with a generic multi-option prompt about unrelated modified files.
- Ask for user input only when there is a direct conflict or blocker in the exact files required for the current task.

## Instruction Maintenance
Keep instruction files up to date whenever you add major functionality:
- Server-side features → update `.github/instructions/server.instructions.md`
- Client-side features → update `.github/instructions/client.instructions.md`
- Deployment/build changes → update `.github/instructions/deployment.instructions.md`
- Database migrations → update `.github/instructions/migrations.instructions.md`

This ensures documentation reflects the current codebase state.
