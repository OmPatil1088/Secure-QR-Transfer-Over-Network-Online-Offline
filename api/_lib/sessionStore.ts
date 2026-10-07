import { Redis } from '@upstash/redis';

export type PairingSession = {
  code: string;
  sessionId: string;
  offer: unknown;
  answer: unknown | null;
  shareMode: string;
  networkMode: 'offline' | 'online';
  createdAt: number;
  expiresAt: number;
};

const ttlSeconds = 10 * 60;
const memorySessions = new Map<string, PairingSession>();
const redis = process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
  ? Redis.fromEnv()
  : null;

export function createPairingCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

export function isPairingCode(value: string): boolean {
  return /^\d{6}$/.test(value);
}

export async function saveSession(session: PairingSession): Promise<void> {
  if (redis) {
    await redis.set(`qrfs:session:${session.code}`, session, { ex: ttlSeconds });
    return;
  }

  memorySessions.set(session.code, session);
}

export async function getSession(code: string): Promise<PairingSession | null> {
  const session = redis
    ? await redis.get<PairingSession>(`qrfs:session:${code}`)
    : memorySessions.get(code) ?? null;

  if (!session || session.expiresAt <= Date.now()) {
    if (!redis) {
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