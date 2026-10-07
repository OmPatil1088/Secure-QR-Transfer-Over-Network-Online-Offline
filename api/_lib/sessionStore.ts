import { Redis } from '@upstash/redis';

export type PairingSession = {
  code: string;
  sessionId: string;
  offer: unknown;
  answer: unknown | null;
  shareMode: string;
  createdAt: number;
  expiresAt: number;
};

const ttlSeconds = 10 * 60;
const memorySessions = new Map<string, PairingSession>();
let redis: Redis | null | undefined;

function getRedis(): Redis | null {
  if (redis !== undefined) {
    return redis;
  }

  const redisUrl = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
  redis = redisUrl && redisToken
    ? new Redis({ url: redisUrl, token: redisToken })
    : null;
  return redis;
}

export function createPairingCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

export function isPairingCode(value: string): boolean {
  return /^\d{6}$/.test(value);
}

export async function saveSession(session: PairingSession): Promise<void> {
  const redisClient = getRedis();
  if (redisClient) {
    await redisClient.set(`qrfs:session:${session.code}`, session, { ex: ttlSeconds });
    return;
  }

  memorySessions.set(session.code, session);
}

export async function getSession(code: string): Promise<PairingSession | null> {
  const redisClient = getRedis();
  const session = redisClient
    ? await redisClient.get<PairingSession>(`qrfs:session:${code}`)
    : memorySessions.get(code) ?? null;

  if (!session || session.expiresAt <= Date.now()) {
    if (!redisClient) {
      memorySessions.delete(code);
    }
    return null;
  }

  return session;
}

export async function updateSession(session: PairingSession): Promise<void> {
  await saveSession(session);
}

export { ttlSeconds };