# Automatic Lifecycle Reviews Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure every bounded calendar event and planned work period reliably wakes Desk-IX after its expected end so the Agent can decide, from context, whether to complete it, continue tracking it, create follow-on work, or ask the user one lightweight question.

**Architecture:** Keep lifecycle judgment inside the Agent and move only wake-up reliability into infrastructure. Write actions derive a review boundary from structured calendar state, synchronize one durable alarm per item, and cancel or replace that alarm when the plan changes. The existing Durable Object callback re-enters the normal Agent loop with current memory and calendar context; it does not decide completion itself.

**Tech Stack:** TypeScript, Cloudflare Workers Agents SDK, Durable Objects scheduling, D1, Zod, Vitest.

---

### Task 1: Specify boundary derivation as a pure domain operation

**Files:**
- Modify: `src/agent/followups.ts`
- Test: `test/agent-followups.test.ts`

- [x] Add failing tests for a bounded event, an unbounded event, an ordinary task, and a planned work-session series.
- [x] Add `deriveItemLifecycleReview` and `deriveWorkSessionLifecycleReview` helpers. A bounded event reviews at `dueAt + estimatedDuration`; a work plan reviews at the end of its latest session. Return `null` when no meaningful end exists.
- [x] Keep the generated payload factual: include the item, owner/channel, review time, and the boundary that ended. Do not infer completion or encode event-category keywords.
- [x] Run `npm test -- test/agent-followups.test.ts` and confirm all cases pass.

### Task 2: Synchronize reviews whenever an item is created or changed

**Files:**
- Modify: `src/agent/tools/write.ts`
- Test: `test/agent-tools-write.test.ts`

- [x] Add failing tests proving that creating a bounded event schedules its end review, changing its time replaces the review, removing its event boundary cancels the review, and completing/archiving still cancels it.
- [x] Pass the existing `LifecycleFollowupController` into create and update actions.
- [x] After a successful item write, reload the canonical item and call one synchronization helper: `set` for a future derived boundary, `cancel` otherwise.
- [x] Return the persisted item plus lifecycle scheduling metadata to the Agent so the reply can be accurate without exposing internal IDs.
- [x] Run `npm test -- test/agent-tools-write.test.ts` and confirm all cases pass.

### Task 3: Cover planned work periods and replanning

**Files:**
- Modify: `src/agent/tools/write.ts`
- Test: `test/agent-tools-write.test.ts`

- [x] Add failing tests proving that saving sessions schedules one review after the final session, replanning replaces it, and cancelling the plan removes it or restores the item's bounded-event review when applicable.
- [x] Synchronize the lifecycle alarm only after the work-session transaction succeeds. Reuse the same deterministic item-level alarm rather than creating one alarm per session.
- [x] Preserve idempotency: retrying the same write must converge on the same review time and callback event ID.
- [x] Run focused write-action tests.

### Task 4: Make the Agent's lifecycle contract explicit without hard-coded outcomes

**Files:**
- Modify: `src/agent/followups.ts`
- Modify: `src/agent/prompt.ts`
- Modify: `src/agent/skills/calendar-review/SKILL.md`
- Test: `test/agent-followups.test.ts`
- Test: `test/agent-calendar-skills.test.ts`

- [x] State that the infrastructure wake-up is guaranteed but its outcome is not predetermined.
- [x] Tell the Agent to separate occurrence certainty from outcome certainty, use current conversation/context, complete silently obvious event-state transitions with a compact report, and ask only when uncertainty changes future planning.
- [x] Add assertions that prohibit category tables, keyword-based completion, and verbose retrospective summaries.
- [x] Run the focused prompt and skill tests.

### Task 5: Verify, deploy, and merge

**Files:**
- Modify only if validation identifies a concrete defect.

- [x] Run `npm run check`, `npm run lint`, the full test suite, and the Worker dry run.
- [x] Review the diff for accidental limits, fixed scenario mappings, stale-alarm paths, secret exposure, and unbounded async work.
- [x] Commit and push `codex/automatic-lifecycle-reviews`, create a PR, wait for CI, and merge it.
- [x] Deploy the merged Worker and verify `/health` plus the deployed version without creating synthetic user-facing messages.
- [x] Confirm production remains quiet for historical records; only newly created or materially replanned boundaries receive automatic lifecycle reviews.

### Task 6: Backfill already-planned future boundaries without historical noise

**Files:**
- Modify: `src/agent/ingress.ts`
- Modify: `src/agent/composa-agent.ts`
- Modify: `src/agent/tools/write.ts`
- Modify: `src/http/router.ts`
- Test: `test/http.test.ts`

- [x] Expose the existing per-user Agent session name and lifecycle synchronization operation for internal Worker use.
- [x] Add an administrator-authenticated per-item synchronization endpoint; it derives the boundary from canonical D1 state and schedules through the owning Durable Object without sending a user message.
- [x] Add a route test proving an existing future work plan receives a durable review at its final session end.
- [x] Merge and deploy the compatibility endpoint. Keep its administrator authentication intact; do not rotate production credentials when the locally stored credential is rejected.

### Task 7: Add independent, Agent-chosen progress synchronization

**Files:**
- Modify: `src/agent/followups.ts`
- Modify: `src/agent/composa-agent.ts`
- Modify: `src/agent/tools/write.ts`
- Modify: `src/agent/prompt.ts`
- Modify: `src/agent/skills/calendar-plan/SKILL.md`
- Modify: `src/agent/skills/calendar-review/SKILL.md`
- Test: `test/agent-followups.test.ts`
- Test: `test/agent-calendar-skills.test.ts`
- Test: `test/agent-runtime.test.ts`

- [x] Separate persistent lifecycle schedules into `boundary` and `progress` lanes so one cannot replace the other; terminal transitions still cancel both.
- [x] Keep automatic boundary derivation for fixed events and work plans, while making `lifecycle_followup_manage` the rolling progress lane.
- [x] Instruct the Agent to choose progress checkpoints from deadline risk, effort, dependencies, actual calendar, current state, and user preferences instead of fixed intervals or lead times.
- [x] At each progress checkpoint, let the Agent update directly when evidence is sufficient, ask only one decision-relevant question when needed, and choose the next checkpoint from fresh state.
- [x] Run focused and full validation, update the open PR, and deploy both lanes together.

### Task 8: Run the future-boundary backfill internally once

**Files:**
- Add: `migrations/0007_lifecycle_backfill.sql`
- Add: `src/db/lifecycle-maintenance.ts`
- Add: `src/core/lifecycle-backfill.ts`
- Modify: `src/index.ts`
- Test: `test/lifecycle-backfill.test.ts`

- [x] Add a durable D1 maintenance claim with completed, failed, and stale-running recovery states.
- [x] On the scheduled Worker trigger, claim one named backfill and find only open items whose fixed-event end or planned work-session end is still in the future.
- [x] Synchronize each candidate through its owning Agent Durable Object without creating conversation messages, then mark the maintenance run complete.
- [x] Prove the backfill schedules a future plan, ignores a past event, and is a no-op after successful completion.
- [ ] Apply the migration, merge and deploy the runner, then verify the one-time run completed and the expected future schedules exist.
