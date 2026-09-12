import type { UIMessage } from "ai";
import { getChannelAdapter } from "../channels/registry";
import type { ChannelName, DeliveryReceipt } from "../core/types";
import { failMessageBySource, finishMessageBySource } from "../db/messages";
import { log } from "../observability/log";
import type { AgentPrincipal } from "./context";
import type { VerifiedTurnEffect } from "./effects";

interface DeliveryRow extends Record<string, SqlStorageValue> {
  request_id: string;
  event_id: string;
  channel: ChannelName;
  user_id: string;
  reply_to_message_id: string | null;
  response_text: string | null;
  delivery_status: "waiting" | "sending" | "sent" | "failed";
  attempts: number;
  created_at: string;
}

interface TurnEffectRow extends Record<string, SqlStorageValue> {
  tool_name: string;
  success: number;
  outcome_json: string;
}

export function migrateAgentDelivery(sql: SqlStorage): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS composa_turn_origins (
      request_id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL UNIQUE,
      channel TEXT NOT NULL CHECK (channel IN ('telegram', 'qq')),
      user_id TEXT NOT NULL,
      reply_to_message_id TEXT,
      response_text TEXT,
      delivery_status TEXT NOT NULL DEFAULT 'waiting'
        CHECK (delivery_status IN ('waiting', 'sending', 'sent', 'failed')),
      attempts INTEGER NOT NULL DEFAULT 0,
      delivery_receipt TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_composa_delivery_status
      ON composa_turn_origins(delivery_status, updated_at);
    CREATE TABLE IF NOT EXISTS composa_turn_effects (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      success INTEGER NOT NULL CHECK (success IN (0, 1)),
      outcome_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(event_id, tool_call_id)
    );
    CREATE INDEX IF NOT EXISTS idx_composa_turn_effects_event
      ON composa_turn_effects(event_id, sequence);
  `);
}

export function rememberTurnEffect(
  sql: SqlStorage,
  eventId: string,
  toolCallId: string,
  effect: VerifiedTurnEffect,
): void {
  sql.exec(
    `INSERT OR REPLACE INTO composa_turn_effects (
      event_id, tool_call_id, tool_name, success, outcome_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)`,
    eventId,
    toolCallId,
    effect.toolName,
    effect.success ? 1 : 0,
    JSON.stringify(effect.outcome),
    new Date().toISOString(),
  );
}

export function listTurnEffects(sql: SqlStorage, eventId: string): VerifiedTurnEffect[] {
  return sql.exec<TurnEffectRow>(
    `SELECT tool_name, success, outcome_json
     FROM composa_turn_effects
     WHERE event_id = ?
     ORDER BY sequence ASC`,
    eventId,
  ).toArray().map((row) => ({
    toolName: row.tool_name,
    success: row.success === 1,
    outcome: parseEffectOutcome(row.outcome_json),
  }));
}

function parseEffectOutcome(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export function rememberTurnOrigin(sql: SqlStorage, requestId: string, principal: AgentPrincipal): void {
  const now = new Date().toISOString();
  sql.exec(
    `INSERT OR IGNORE INTO composa_turn_origins (
      request_id, event_id, channel, user_id, reply_to_message_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    requestId,
    principal.eventId,
    principal.channel,
    principal.userId,
    principal.replyToMessageId ?? null,
    now,
    now,
  );
}

export function getTurnOriginPrincipal(sql: SqlStorage, requestId: string): AgentPrincipal | null {
  const row = sql.exec<DeliveryRow>(
    "SELECT * FROM composa_turn_origins WHERE request_id = ? LIMIT 1",
    requestId,
  ).toArray()[0];
  if (!row || (row.channel !== "telegram" && row.channel !== "qq")) return null;
  return {
    channel: row.channel,
    userId: row.user_id,
    eventId: row.event_id,
    receivedAt: row.created_at,
    ...(row.reply_to_message_id ? { replyToMessageId: row.reply_to_message_id } : {}),
  };
}

export function messageText(message: UIMessage): string {
  return message.parts
    .filter((part): part is Extract<UIMessage["parts"][number], { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim();
}

export async function deliverTurnResponse(
  env: Env,
  sql: SqlStorage,
  requestId: string,
  responseText: string,
): Promise<boolean> {
  const current = sql.exec<DeliveryRow>(
    "SELECT * FROM composa_turn_origins WHERE request_id = ? LIMIT 1",
    requestId,
  ).toArray()[0];
  if (!current) return false;
  if (current.delivery_status === "sent") return true;

  const text = responseText.trim() || "这次没有生成有效回复，我没有擅自操作。";
  const startedAt = new Date().toISOString();
  sql.exec(
    `UPDATE composa_turn_origins
     SET response_text = ?, delivery_status = 'sending', attempts = attempts + 1,
         last_error = NULL, updated_at = ?
     WHERE request_id = ? AND delivery_status != 'sent'`,
    text,
    startedAt,
    requestId,
  );

  try {
    const receipt: DeliveryReceipt = await getChannelAdapter(env, current.channel).send(
      { channel: current.channel, userId: current.user_id },
      {
        text,
        ...(current.reply_to_message_id ? { replyToMessageId: current.reply_to_message_id } : {}),
      },
    );
    sql.exec(
      `UPDATE composa_turn_origins
       SET delivery_status = 'sent', delivery_receipt = ?, updated_at = ?
       WHERE request_id = ?`,
      JSON.stringify(receipt),
      new Date().toISOString(),
      requestId,
    );
    log("info", "agent_reply_delivered", {
      requestId,
      eventId: current.event_id,
      channel: current.channel,
      attempts: current.attempts + 1,
    });
    try {
      await finishMessageBySource(env.DB, current.channel, current.event_id, text);
    } catch (error) {
      log("error", "agent_message_audit_finish_failed", {
        requestId,
        eventId: current.event_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sql.exec(
      `UPDATE composa_turn_origins
       SET delivery_status = 'failed', last_error = ?, updated_at = ?
       WHERE request_id = ?`,
      message.slice(0, 1_000),
      new Date().toISOString(),
      requestId,
    );
    log("error", "agent_reply_delivery_failed", {
      requestId,
      eventId: current.event_id,
      channel: current.channel,
      error: message,
    });
    try {
      await failMessageBySource(env.DB, current.channel, current.event_id, `delivery: ${message}`);
    } catch (auditError) {
      log("error", "agent_message_audit_fail_failed", {
        requestId,
        eventId: current.event_id,
        error: auditError instanceof Error ? auditError.message : String(auditError),
      });
    }
    return false;
  }
}

export async function retryFailedDeliveryForEvent(env: Env, sql: SqlStorage, eventId: string): Promise<boolean> {
  const row = sql.exec<DeliveryRow>(
    `SELECT * FROM composa_turn_origins
     WHERE event_id = ? AND delivery_status = 'failed' AND response_text IS NOT NULL
     LIMIT 1`,
    eventId,
  ).toArray()[0];
  if (!row?.response_text) return false;
  return deliverTurnResponse(env, sql, row.request_id, row.response_text);
}
