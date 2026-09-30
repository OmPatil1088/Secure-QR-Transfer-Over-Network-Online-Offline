import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';
import type { Connect } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

type PairingSession = {
  code: string;
  sessionId: string;
  offer: unknown;
  answer: unknown | null;
  shareMode: string;
  createdAt: number;
  expiresAt: number;
};

const pairingSessions = new Map<string, PairingSession>();
const pairingTtlMs = 10 * 60 * 1000;

function createPairingCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function removeExpiredSessions(): void {
  const now = Date.now();
  for (const [code, session] of pairingSessions) {
    if (session.expiresAt <= now) {
      pairingSessions.delete(code);
    }
  }
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
      if (body.length > 512 * 1024) {
        reject(new Error('Request body is too large.'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) as Record<string, unknown> : {});
      } catch {
        reject(new Error('Invalid JSON body.'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

function signalingPlugin() {
  return {
    name: 'qr-file-sharing-signaling',
    configureServer(server: { middlewares: Connect.Server }) {
      server.middlewares.use(async (req, res, next) => {
        removeExpiredSessions();
        const url = new URL(req.url ?? '/', 'http://localhost');
        const sessionMatch = url.pathname.match(/^\/api\/sessions\/([0-9]{6})(?:\/answer)?$/);

        try {
          if (req.method === 'POST' && url.pathname === '/api/sessions') {
            const body = await readJsonBody(req);
            if (!body.offer || typeof body.sessionId !== 'string' || typeof body.shareMode !== 'string') {
              sendJson(res, 400, { error: 'offer, sessionId, and shareMode are required.' });
              return;
            }

            let code = createPairingCode();
            while (pairingSessions.has(code)) {
              code = createPairingCode();
            }

            const now = Date.now();
            const session: PairingSession = {
              code,
              sessionId: body.sessionId,
              offer: body.offer,
              answer: null,
              shareMode: body.shareMode,
              createdAt: now,
              expiresAt: now + pairingTtlMs,
            };

            pairingSessions.set(code, session);
            sendJson(res, 201, { code, sessionId: session.sessionId, expiresAt: session.expiresAt });
            return;
          }

          if (sessionMatch && req.method === 'GET' && !url.pathname.endsWith('/answer')) {
            const session = pairingSessions.get(sessionMatch[1]);
            if (!session) {
              sendJson(res, 404, { error: 'Pairing code is invalid or expired.' });
              return;
            }

            sendJson(res, 200, {
              offer: session.offer,
              sessionId: session.sessionId,
              shareMode: session.shareMode,
              expiresAt: session.expiresAt,
            });
            return;
          }

          if (sessionMatch && req.method === 'POST' && url.pathname.endsWith('/answer')) {
            const session = pairingSessions.get(sessionMatch[1]);
            if (!session) {
              sendJson(res, 404, { error: 'Pairing code is invalid or expired.' });
              return;
            }

            const body = await readJsonBody(req);
            if (!body.answer) {
              sendJson(res, 400, { error: 'answer is required.' });
              return;
            }

            session.answer = body.answer;
            sendJson(res, 200, { ok: true });
            return;
          }

          if (sessionMatch && req.method === 'GET' && url.pathname.endsWith('/answer')) {
            const session = pairingSessions.get(sessionMatch[1]);
            if (!session) {
              sendJson(res, 404, { error: 'Pairing code is invalid or expired.' });
              return;
            }

            sendJson(res, 200, { answer: session.answer, expiresAt: session.expiresAt });
            return;
          }
        } catch (error) {
          sendJson(res, 400, { error: error instanceof Error ? error.message : 'Signaling request failed.' });
          return;
        }

        next();
      });
    },
  };
}

const certificateDirectory = path.resolve('.cert');
const trustedCertificate = path.join(certificateDirectory, 'lan.pem');
const trustedKey = path.join(certificateDirectory, 'lan-key.pem');
const hasTrustedCertificate = fs.existsSync(trustedCertificate) && fs.existsSync(trustedKey);

export default defineConfig({
  plugins: [react(), ...(hasTrustedCertificate ? [] : [basicSsl()]), signalingPlugin()],
  server: {
    host: true,
    ...(hasTrustedCertificate
      ? {
          https: {
            cert: fs.readFileSync(trustedCertificate),
            key: fs.readFileSync(trustedKey),
          },
        }
      : {}),
  },
});