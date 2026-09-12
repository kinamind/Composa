import { z } from "zod";
import type { ChannelTarget } from "./core/types";

const timePattern = /^([01]\d|2[0-3]):([0-5]\d)$/;

const configSchema = z.object({
  appName: z.string().min(1),
  locale: z.string().min(2),
  timezone: z.string().min(1),
  dailyPlanTime: z.string().regex(timePattern),
  aiBaseUrl: z.string().url(),
  aiModel: z.string().min(1),
  aiEmbeddingModel: z.string(),
  aiMaxTokens: z.number().int().min(64).max(4096),
  aiTimeoutMs: z.number().int().min(1000).max(600_000),
  aiDailyPlanTimeoutMs: z.number().int().min(1000).max(600_000),
  aiDailyRequestLimit: z.number().int().min(0).max(10_000),
  urlFetchTimeoutMs: z.number().int().min(500).max(60_000),
  urlMaxTextBytes: z.number().int().min(16_384).max(8_388_608),
  mediaMaxBytes: z.number().int().min(262_144).max(25_000_000),
  xhsMaxBytes: z.number().int().min(262_144).max(16_000_000),
  telegramAllowedUserIds: z.set(z.string()),
  qqAllowedUserOpenIds: z.set(z.string()),
  dailyPlanTargets: z.array(z.object({ channel: z.enum(["telegram", "qq"]), userId: z.string().min(1) })),
  qqAppId: z.string(),
  qqApiBaseUrl: z.string().url(),
});

export type RuntimeConfig = z.infer<typeof configSchema>;

function csvSet(value: string): Set<string> {
  return new Set(value.split(",").map((entry) => entry.trim()).filter(Boolean));
}

function parseInteger(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseTargets(value: string): ChannelTarget[] {
  const targets: ChannelTarget[] = [];
  for (const entry of value.split(",").map((part) => part.trim()).filter(Boolean)) {
    const separator = entry.indexOf(":");
    if (separator < 1) continue;
    const channel = entry.slice(0, separator);
    const userId = entry.slice(separator + 1).trim();
    if ((channel === "telegram" || channel === "qq") && userId) {
      targets.push({ channel, userId });
    }
  }
  return targets;
}

export function getConfig(env: Env): RuntimeConfig {
  const aiBaseUrl = env.AI_BASE_URL || "https://api.openai.com/v1";
  return configSchema.parse({
    appName: env.APP_NAME,
    locale: env.APP_LOCALE,
    timezone: env.TIMEZONE,
    dailyPlanTime: env.DAILY_PLAN_TIME,
    aiBaseUrl: aiBaseUrl.replace(/\/$/, ""),
    aiModel: env.AI_MODEL || "gpt-4.1-mini",
    aiEmbeddingModel: env.AI_EMBEDDING_MODEL,
    aiMaxTokens: parseInteger(env.AI_MAX_TOKENS, 600),
    aiTimeoutMs: parseInteger(env.AI_TIMEOUT_MS, 180_000),
    aiDailyPlanTimeoutMs: parseInteger(env.AI_DAILY_PLAN_TIMEOUT_MS, 180_000),
    aiDailyRequestLimit: parseInteger(env.AI_DAILY_REQUEST_LIMIT, 0),
    urlFetchTimeoutMs: parseInteger(env.URL_FETCH_TIMEOUT_MS, 20_000),
    urlMaxTextBytes: parseInteger(env.URL_MAX_TEXT_BYTES, 524_288),
    mediaMaxBytes: parseInteger(env.MEDIA_MAX_BYTES, 20_000_000),
    xhsMaxBytes: parseInteger(env.XHS_MAX_BYTES, 8_000_000),
    telegramAllowedUserIds: csvSet(env.TELEGRAM_ALLOWED_USER_IDS || ""),
    qqAllowedUserOpenIds: csvSet(env.QQ_ALLOWED_USER_OPENIDS || ""),
    dailyPlanTargets: parseTargets(env.DAILY_PLAN_TARGETS || ""),
    qqAppId: env.QQ_APP_ID || "",
    qqApiBaseUrl: env.QQ_API_BASE_URL.replace(/\/$/, ""),
  });
}

export function isAIEnabled(env: Env): boolean {
  return Boolean(env.AI_API_KEY?.trim() && env.AI_MODEL?.trim());
}
