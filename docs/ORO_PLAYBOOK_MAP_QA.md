# Oro Circle playbook map — 22 September 2026

## Inspection

Read-only inspection of Oro Circle's live Playbooks screen found Hospitality Sales & Enquiries, published version 13, with 56 steps and 43 questions. Three proposal playbooks were paused. The map fitted the entire hospitality graph into a small viewport, used 190–230px cards, and exposed technical field/capability identifiers. Several parallel connections shared the same label position.

## UI changes

- Repair absent, invalid or crowded coordinates with deterministic left-to-right columns and separated branches. Keep cycles and disconnected steps visible.
- Use 280×176px cards with readable titles, customer prompts and plain-language descriptions of business actions.
- Label branches with configured option names and understandable conditions; separate labels for parallel connections.
- Open large maps near their starting steps at a readable scale. Add Jump to step, Start here, Show whole flow and Auto arrange controls.
- Highlight connections around the selected step and show the full explanation in the inspector. Closing the inspector restores canvas space.
- Keep mobile controls readable and hide the minimap on narrow screens.
- Ignore React Flow measurement/selection notifications when updating drafts. Browsing alone must not edit the graph.

This is a shared editor change, not a change to customer intent detection. Runtime IDs, conditions, priorities, questions, actions and publishing controls are preserved. Viewing repairs the display locally; only an explicit draft edit/save persists positions. No live account writes or deployment were performed.

## Verification

- 27 unit/component tests passed across five playbook suites.
- Client TypeScript check passed.
- An isolated browser preview of the actual current hospitality template (57 steps, including its newer Spa request step) passed desktop (1440px) and mobile (390px) checks: no node overlap, Spa selection and explanation, correct next-step labels, no horizontal page overflow, overview, auto-arrange, return to start and inspector closure. No browser page errors were recorded. Screenshots were visually reviewed.
- Full-page app checks were attempted but blocked at the local app loading screen before reaching the editor. They are not counted as passing. The new `client/e2e/playbook-map.spec.ts` retains a 56-node regression test for the full app once that environment is healthy.
- This is not production verification. Release and a final Oro Circle account check remain pending.
