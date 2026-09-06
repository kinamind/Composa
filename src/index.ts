import { routeRequest } from "./http/router";
import { runDailyPlan } from "./core/daily-plan";
import { runLifecycleBoundaryBackfill } from "./core/lifecycle-backfill";
export { ReminderWorkflow } from "./workflows/reminder";
export { ComposaAgent } from "./agent/composa-agent";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return routeRequest(request, env, ctx);
  },

  scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): void {
    ctx.waitUntil(runDailyPlan(env));
    ctx.waitUntil(runLifecycleBoundaryBackfill(env));
  },
} satisfies ExportedHandler<Env>;
