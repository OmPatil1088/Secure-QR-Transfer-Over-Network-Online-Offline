import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createPairingCode, saveSession, type PairingSession, ttlSeconds } from './_lib/sessionStore.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  const body = req.body as { offer?: unknown; sessionId?: unknown; shareMode?: unknown } | undefined;
  if (!body || typeof body !== 'object' || !body.offer || typeof body.sessionId !== 'string' || typeof body.shareMode !== 'string') {
    return res.status(400).json({ error: 'offer, sessionId, and shareMode are required.' });
  }

  const code = createPairingCode();
  const now = Date.now();
  const session: PairingSession = {
    code,
    sessionId: body.sessionId,
    offer: body.offer,
    answer: null,
    shareMode: body.shareMode,
    createdAt: now,
    expiresAt: now + ttlSeconds * 1000,
  };

  try {
    await saveSession(session);
  } catch (error) {
    console.error('Failed to save pairing session.', error);
    return res.status(503).json({ error: 'Signaling storage is unavailable. Check the Redis environment variables.' });
  }

  return res.status(201).json({ code, sessionId: session.sessionId, expiresAt: session.expiresAt });
}
