import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSession, isPairingCode, updateSession, type PairingSession } from '../../_lib/sessionStore';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const code = String(req.query.code ?? '');
  if (!isPairingCode(code)) {
    return res.status(400).json({ error: 'Pairing code must contain six digits.' });
  }

  let session: PairingSession | null;
  try {
    session = await getSession(code);
  } catch (error) {
    console.error('Failed to load pairing session.', error);
    return res.status(503).json({ error: 'Signaling storage is unavailable. Check the Redis environment variables.' });
  }

  if (!session) {
    return res.status(404).json({ error: 'Pairing code is invalid or expired.' });
  }

  if (req.method === 'POST') {
    const body = req.body as { answer?: unknown } | undefined;
    if (!body || typeof body !== 'object' || !body.answer) {
      return res.status(400).json({ error: 'answer is required.' });
    }

    session.answer = body.answer;
    try {
      await updateSession(session);
    } catch (error) {
      console.error('Failed to update pairing session.', error);
      return res.status(503).json({ error: 'Signaling storage is unavailable. Check the Redis environment variables.' });
    }

    return res.status(200).json({ ok: true });
  }

  if (req.method === 'GET') {
    return res.status(200).json({ answer: session.answer, expiresAt: session.expiresAt });
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed.' });
}