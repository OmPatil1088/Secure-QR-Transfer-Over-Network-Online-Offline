import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createPairingCode, getSession, saveSession, type PairingSession, ttlSeconds } from '../_lib/sessionStore';

async function createUniquePairingCode(maxAttempts = 25): Promise<string> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const code = createPairingCode();
    const existing = await getSession(code);
    if (!existing) return code;
  }
  throw new Error('Could not allocate a unique pairing code.');
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  const body = req.body as { offer?: unknown; sessionId?: unknown; shareMode?: unknown; networkMode?: unknown };
  const hasValidNetworkMode = body.networkMode === 'offline' || body.networkMode === 'online';
  if (!body.offer || typeof body.sessionId !== 'string' || typeof body.shareMode !== 'string' || !hasValidNetworkMode) {
    return res.status(400).json({ error: 'offer, sessionId, shareMode, and networkMode are required.' });
  }

  let code: string;
  try {
    code = await createUniquePairingCode();
  } catch {
    return res.status(503).json({ error: 'Could not create a new pairing session.' });
  }
  const now = Date.now();
  const session: PairingSession = {
    code,
    sessionId: body.sessionId,
    offer: body.offer,
    answer: null,
    shareMode: body.shareMode,
    networkMode: body.networkMode,
    createdAt: now,
    expiresAt: now + ttlSeconds * 1000,
  };

  await saveSession(session);
  return res.status(201).json({ code, sessionId: session.sessionId, expiresAt: session.expiresAt });
}