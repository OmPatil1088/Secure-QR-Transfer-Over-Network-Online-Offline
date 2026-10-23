import type { VercelRequest, VercelResponse } from '@vercel/node';

type IceServer = {
  urls: string | string[];
  username?: string;
  credential?: string;
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  const apiKey = process.env.METERED_API_KEY;
  const appName = process.env.METERED_APP_NAME;
  if (!apiKey || !appName) {
    return res.status(503).json({ error: 'Metered ICE server credentials are not configured.' });
  }

  try {
    const response = await fetch(
      `https://${appName}.metered.live/api/v1/turn/credentials?apiKey=${encodeURIComponent(apiKey)}`,
    );
    if (!response.ok) {
      console.error('Metered ICE credentials request failed.', response.status);
      return res.status(502).json({ error: 'Metered ICE credentials are unavailable.' });
    }

    const iceServers = (await response.json()) as unknown;
    if (
      !Array.isArray(iceServers) ||
      !iceServers.every(
        (server): server is IceServer =>
          typeof server === 'object' &&
          server !== null &&
          ('urls' in server) &&
          (typeof server.urls === 'string' || Array.isArray(server.urls)),
      )
    ) {
      console.error('Metered returned an invalid ICE server response.');
      return res.status(502).json({ error: 'Metered returned invalid ICE server data.' });
    }

    return res.status(200).json(iceServers);
  } catch (error) {
    console.error('Failed to fetch Metered ICE credentials.', error);
    return res.status(502).json({ error: 'Could not contact Metered.' });
  }
}
