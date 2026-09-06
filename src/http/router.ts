import { z } from "zod";
import { getAgentByName } from "agents";
import { getConfig, isAIEnabled } from "../config";
import { getChannelAdapter } from "../channels/registry";
import { processIncoming } from "../core/processor";
import { agentSessionName, submitAgentMessage } from "../agent/ingress";
import { buildDailyPlan, runDailyPlan } from "../core/daily-plan";
import { scheduleReminder } from "../core/reminder-service";
import { localDate } from "../core/time";
import { getAIRequests } from "../db/ai-usage";
import { archiveItem, completeItem, getItem, restoreItem, searchItems } from "../db/items";
import { cancelOpenReminders } from "../db/reminders";
import { log } from "../observability/log";
import { constantTimeEqual } from "../security/crypto";

const itemTypeSchema = z.enum(["resource", "idea", "task", "note", "project"]);
const adminReminderSchema = z.object({
  remindAt: z.string().datetime(),
  kind: z.string().trim().min(1).max(80).default("admin_reschedule"),
});

export async function routeRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.startsWith("/desk/") ? url.pathname.slice("/desk".length) : url.pathname;
  try {
    if (request.method === "GET" && path === "/health") {
      const result = await env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>();
      const config = getConfig(env);
      const aiConfigured = isAIEnabled(env);
      const successfulAIRequests = aiConfigured
        ? await getAIRequests(env.DB, localDate(new Date(), config.timezone), "openai-compatible")
        : 0;
      return Response.json({
        ok: result?.ok === 1,
        service: config.appName,
        version: "0.1.0",
        timezone: config.timezone,
        channels: {
          telegram: Boolean(env.TELEGRAM_BOT_TOKEN && config.telegramAllowedUserIds.size),
          qq: Boolean(config.qqAppId && env.QQ_APP_SECRET && config.qqAllowedUserOpenIds.size),
        },
        integrations: {
          xiaohongshu: { configured: Boolean(env.XHS_COOKIE?.trim()) },
        },
        ai: { configured: aiConfigured, verified: successfulAIRequests > 0 },
      });
    }

    if (request.method === "POST" && (path === "/webhooks/telegram" || path === "/webhooks/qq")) {
      const channel = path.endsWith("telegram") ? "telegram" : "qq";
      const adapter = getChannelAdapter(env, channel);
      const parsed = await adapter.parseWebhook(request);
      if (parsed.kind === "unauthorized") return Response.json({ error: "Forbidden" }, { status: 403 });
      if (parsed.kind === "challenge") return parsed.response;
      if (parsed.kind === "ignored") return parsed.response ?? Response.json({ ok: true });
      ctx.waitUntil(parsed.message.eventType === "callback"
        ? processIncoming(env, parsed.message)
        : submitAgentMessage(env, parsed.message));
      return Response.json({ ok: true });
    }

    if (path.startsWith("/api/")) {
      const authorized = await authorizeAdmin(request, env.ADMIN_API_TOKEN);
      if (!authorized) return Response.json({ error: "Unauthorized" }, { status: 401 });

      if (request.method === "GET" && path === "/api/items") {
        const typeParam = url.searchParams.get("type");
        const type = typeParam ? itemTypeSchema.parse(typeParam) : undefined;
        const keyword = url.searchParams.get("q")?.trim() || undefined;
        const status = url.searchParams.get("status")?.trim();
        const items = await searchItems(env.DB, {
          ...(type ? { type } : {}),
          ...(keyword ? { keyword } : {}),
          ...(status ? { statuses: [status] } : {}),
          limit: Number.parseInt(url.searchParams.get("limit") ?? "20", 10),
        });
        return Response.json({ items });
      }

      const itemMatch = path.match(/^\/api\/items\/([0-9a-f-]+)$/i);
      if (request.method === "GET" && itemMatch?.[1]) {
        const item = await getItem(env.DB, itemMatch[1]);
        return item ? Response.json({ item }) : Response.json({ error: "Not found" }, { status: 404 });
      }

      const completeMatch = path.match(/^\/api\/items\/([0-9a-f-]+)\/complete$/i);
      if (request.method === "POST" && completeMatch?.[1]) {
        const changed = await completeItem(env.DB, completeMatch[1]);
        await cancelOpenReminders(env.DB, completeMatch[1]);
        return Response.json({ ok: true, changed });
      }

      const archiveMatch = path.match(/^\/api\/items\/([0-9a-f-]+)\/archive$/i);
      if (request.method === "POST" && archiveMatch?.[1]) {
        const changed = await archiveItem(env.DB, archiveMatch[1]);
        await cancelOpenReminders(env.DB, archiveMatch[1]);
        return Response.json({ ok: true, changed });
      }

      const restoreMatch = path.match(/^\/api\/items\/([0-9a-f-]+)\/restore$/i);
      if (request.method === "POST" && restoreMatch?.[1]) {
        const changed = await restoreItem(env.DB, restoreMatch[1]);
        return Response.json({ ok: true, changed });
      }

      const reminderMatch = path.match(/^\/api\/items\/([0-9a-f-]+)\/reminder$/i);
      if (reminderMatch?.[1] && request.method === "POST") {
        const item = await getItem(env.DB, reminderMatch[1]);
        if (!item) return Response.json({ error: "Not found" }, { status: 404 });
        const parsed = adminReminderSchema.safeParse(await request.json());
        if (!parsed.success) return Response.json({ error: "Invalid reminder" }, { status: 400 });
        const remindAt = new Date(parsed.data.remindAt);
        if (remindAt.getTime() <= Date.now()) {
          return Response.json({ error: "Reminder must be in the future" }, { status: 400 });
        }
        const reminder = await scheduleReminder(env, {
          itemId: item.id,
          remindAt: remindAt.toISOString(),
          kind: parsed.data.kind,
          target: { channel: item.sourceChannel, userId: item.sourceUserId },
        });
        await cancelOpenReminders(env.DB, item.id, reminder.id);
        return Response.json({ ok: true, remindAt: reminder.remindAt });
      }
      if (reminderMatch?.[1] && request.method === "DELETE") {
        const item = await getItem(env.DB, reminderMatch[1]);
        if (!item) return Response.json({ error: "Not found" }, { status: 404 });
        await cancelOpenReminders(env.DB, item.id);
        return Response.json({ ok: true, canceled: true });
      }

      const lifecycleReviewMatch = path.match(/^\/api\/items\/([0-9a-f-]+)\/lifecycle-review$/i);
      if (request.method === "POST" && lifecycleReviewMatch?.[1]) {
        const item = await getItem(env.DB, lifecycleReviewMatch[1]);
        if (!item) return Response.json({ error: "Not found" }, { status: 404 });
        const name = await agentSessionName(item.sourceChannel, item.sourceUserId);
        const agent = await getAgentByName(env.COMPOSA_AGENT, name);
        const result = await agent.synchronizeLifecycleReviewForItem(
          item.id,
          item.sourceChannel,
          item.sourceUserId,
        );
        return Response.json({ ok: true, lifecycleReview: result });
      }

      if (request.method === "POST" && path === "/api/daily-plan") {
        if (url.searchParams.get("send") === "1") {
          ctx.waitUntil(runDailyPlan(env, new Date(), fetch, true));
          return Response.json({ ok: true, queued: true }, { status: 202 });
        }
        return Response.json({ plan: await buildDailyPlan(env) });
      }
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log("error", "http_request_failed", { method: request.method, path: url.pathname, error: message });
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

async function authorizeAdmin(request: Request, token: string): Promise<boolean> {
  if (!token) return false;
  const provided = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  return constantTimeEqual(provided, token);
}
