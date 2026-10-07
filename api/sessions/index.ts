import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createPairingCode, saveSession, type PairingSession, ttlSeconds } from '../_lib/sessionStore';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  const body = req.body as { offer?: unknown; sessionId?: unknown; shareMode?: unknown };
  if (!body.offer || typeof body.sessionId !== 'string' || typeof body.shareMode !== 'string') {
    return res.status(400).json({ error: 'offer, sessionId, and shareMode are required.' });
  }

  let code = createPairingCode();
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

  await saveSession(session);
  return res.status(201).json({ code, sessionId: session.sessionId, expiresAt: session.expiresAt });
}