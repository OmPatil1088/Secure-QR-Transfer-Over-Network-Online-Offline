import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSession, isPairingCode } from '../_lib/sessionStore';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  const code = String(req.query.code ?? '');
  if (!isPairingCode(code)) {
    return res.status(400).json({ error: 'Pairing code must contain six digits.' });
  }

  const session = await getSession(code);
  if (!session) {
    return res.status(404).json({ error: 'Pairing code is invalid or expired.' });
  }

  return res.status(200).json({
    offer: session.offer,
    sessionId: session.sessionId,
    shareMode: session.shareMode,
    networkMode: session.networkMode,
    expiresAt: session.expiresAt,
  });
}