import { getAgentByName } from "agents";
import { agentSessionName } from "../agent/ingress";
import type { ComposaAgent } from "../agent/composa-agent";
import type { ChannelName } from "./types";
import {
  claimLifecycleMaintenance,
  completeLifecycleMaintenance,
  failLifecycleMaintenance,
} from "../db/lifecycle-maintenance";
import { log } from "../observability/log";

const LIFECYCLE_BOUNDARY_BACKFILL = "future-deadlines-and-independent-boundaries-v2";

interface LifecycleBackfillCandidate {
  id: string;
  source_channel: ChannelName;
  source_user_id: string;
}

export async function runLifecycleBoundaryBackfill(env: Env, now = new Date()): Promise<{
  ran: boolean;
  synchronized: number;
}> {
  const claimed = await claimLifecycleMaintenance(env.DB, LIFECYCLE_BOUNDARY_BACKFILL, now);
  if (!claimed) return { ran: false, synchronized: 0 };

  try {
    const candidates = await env.DB.prepare(`
      SELECT DISTINCT i.id, i.source_channel, i.source_user_id
      FROM items i
      LEFT JOIN work_sessions w ON w.item_id = i.id AND w.status = 'planned'
      WHERE i.status IN ('open', 'raw', 'active') AND (
        (
          i.temporal_role = 'event'
          AND i.due_at IS NOT NULL
          AND i.estimated_duration IS NOT NULL
          AND julianday(i.due_at) + (i.estimated_duration / 1440.0) > julianday(?)
        )
        OR (
          i.temporal_role != 'event'
          AND i.due_at IS NOT NULL
          AND julianday(i.due_at) > julianday(?)
        )
        OR (w.end_at IS NOT NULL AND julianday(w.end_at) > julianday(?))
      )
    `).bind(now.toISOString(), now.toISOString(), now.toISOString()).all<LifecycleBackfillCandidate>();

    let synchronized = 0;
    for (const candidate of candidates.results) {
      const name = await agentSessionName(candidate.source_channel, candidate.source_user_id);
      const agent = await getAgentByName<Env, ComposaAgent>(env.COMPOSA_AGENT, name);
      const result = await agent.synchronizeLifecycleReviewForItem(
        candidate.id,
        candidate.source_channel,
        candidate.source_user_id,
      );
      if (result.scheduled) synchronized += 1;
    }
    await completeLifecycleMaintenance(env.DB, LIFECYCLE_BOUNDARY_BACKFILL, now);
    log("info", "lifecycle_boundary_backfill_completed", {
      candidates: candidates.results.length,
      synchronized,
    });
    return { ran: true, synchronized };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await failLifecycleMaintenance(env.DB, LIFECYCLE_BOUNDARY_BACKFILL, message);
    log("error", "lifecycle_boundary_backfill_failed", { error: message });
    throw error;
  }
}
