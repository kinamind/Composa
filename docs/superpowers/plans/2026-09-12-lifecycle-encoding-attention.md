# Lifecycle, Web Encoding, and Attention Frontstage Plan

**Goal:** Repair the three production failures seen on September 11–12: preserve every meaningful lifecycle boundary, decode public web pages before HTML parsing, and make proactive daily plans pass through the same attention frontstage as ordinary turns.

**Architecture:** Durable scheduling remains mechanical while lifecycle outcomes remain Agent judgments. An item may own independent event-end, deadline, work-plan-end, and Agent-chosen progress schedules; updating the item reconciles only the appropriate lanes. Web responses are streamed through a charset-aware UTF-8 normalizer before `HTMLRewriter`. Daily planning keeps a rich backstage plan but exposes only an attention-selected brief, with a compact safe fallback if foreground generation fails.

**Tech stack:** TypeScript, Cloudflare Workers, Agents SDK scheduled tasks, D1, HTMLRewriter, Vitest.

---

### Task 1: Preserve independent lifecycle boundaries

**Files:** `src/agent/followups.ts`, `src/agent/composa-agent.ts`, `src/agent/tools/write.ts`, `src/core/lifecycle-backfill.ts`, lifecycle tests.

- [x] Add regression tests for a work session ending before a fixed deadline and prove both reviews remain scheduled.
- [x] Derive deadline reviews from every valid explicit due boundary, including legacy items whose temporal role was not normalized.
- [x] Add schedule lanes so replacing one automatic boundary cannot erase another or the Agent-owned progress review.
- [x] Reconcile all automatic boundary lanes after writes and run a new one-time future-only backfill without waking historical records.
- [x] Keep callback language factual and let the Agent decide completion, continuation, or a lightweight question from current context.

### Task 2: Normalize webpage character encodings

**Files:** `src/url/fetch.ts`, `test/url.test.ts`.

- [x] Add failing coverage for legacy CJK charset declarations and malformed UTF-8 bytes.
- [x] Decode the response stream with the declared charset (falling back safely), then re-encode valid UTF-8 before `HTMLRewriter`.
- [x] Apply the same charset handling to plain text while preserving byte limits, redirect checks, and streaming behavior.

### Task 3: Put daily plans behind the attention boundary

**Files:** `src/core/daily-plan.ts`, `src/agent/attention.ts`, `src/ai/prompts.ts`, daily-plan and attention tests.

- [x] Keep the full item/calendar state available to the backstage planner.
- [x] Send the backstage result through the existing director-renderer boundary before delivery.
- [x] Explicitly treat “X is not for today” as attention consumption; expose it only when deferral itself needs a decision or has an immediate consequence.
- [x] If foreground generation fails, return a compact selected plan rather than reopening the raw long backstage output.

### Task 4: Validate and ship

- [x] Run focused tests, the full suite, type generation/checking, lint, and Worker dry run with Node 22.
- [x] Review the diff for fixed scenario keywords, arbitrary limits, stale schedules, secret exposure, and regressions in contextual judgment.
- [ ] Commit the isolated branch and publish the tested change through the repository's normal review/deployment path.
