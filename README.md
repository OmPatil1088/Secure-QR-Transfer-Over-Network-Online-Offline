# QR File Sharing

Local-first file sharing app that pairs devices by QR code and transfers files directly over WebRTC. The QR codes only carry signaling data; the file contents move peer-to-peer, so the flow does not depend on internet access.

## What it supports

- One-time sessions that close after the first transfer.
- Reusable sessions that stay open for multiple transfers.
- QR-based offer/answer exchange for pairing.
- Six-digit LAN pairing code as an alternative to QR scanning.
- Manual paste support for browsers that do not expose a camera scanner API.

## Run it

1. Install Node.js.
2. Run `npm install`.
3. Run `npm run dev -- --host 0.0.0.0`.
4. Open the printed `https://` LAN URL on the receiver device.
5. For quick development, accept the local certificate warning once in Chrome. For a warning-free LAN setup, follow the trusted certificate steps below.

## Notes

- The transfer path is WebRTC with `iceServers: []`, so both devices must be able to reach each other directly on the same LAN.
- The sender publishes a temporary six-digit pairing code through the local Vite signaling middleware. Codes expire after ten minutes.
- Sender QR codes open the app URL with the pairing code, so a phone camera can redirect directly to the receiver page.
- QR scanning and manual paste remain available when code pairing is not convenient.
- Camera access requires HTTPS or localhost. On Android, accept the certificate warning first, then allow camera permission.
- A six-digit code is temporary convenience pairing, not strong authentication.
- Use `Offline LAN` when both devices share the same local network and internet access is not desired.
- Use `Online` when devices may be on different networks; this enables configured STUN servers and may require TURN for restrictive networks.

## Warning-free Android HTTPS

The default Vite certificate is self-signed, so Chrome correctly displays a security warning. To remove it on your local network:

1. Install `mkcert` on the sender computer.
2. Run `mkcert -install`.
3. Run `mkcert -key-file .cert/lan-key.pem -cert-file .cert/lan.pem localhost 127.0.0.1 192.168.1.172` and replace the IP with the sender's LAN IP.
4. Export the `mkcert` root CA and install it on the Android phone as a trusted CA certificate.
5. Restart the dev server and open the HTTPS LAN URL again.

Without installing the local CA on Android, the browser warning is expected and cannot be removed by webpage code.

## Deploy to Vercel

The same project supports localhost and Vercel:

1. Push the project to GitHub.
2. Import the repository into Vercel.
3. Keep the default Vite build settings.
4. Create an Upstash Redis database through the Vercel integration.
5. Add these environment variables to the Vercel project:

```text
UPSTASH_REDIS_REST_URL
UPSTASH_REDIS_REST_TOKEN
```

Redeploy after adding or changing these variables. They must be configured for the
same Vercel environment used by the deployment (Production, Preview, or
Development). Vercel serverless functions do not share in-memory state, so the
Redis variables are required for pairing sessions to work reliably in production.

Vercel uses the functions in `api/sessions`. File contents continue to move directly between browsers; Vercel only stores temporary offer/answer signaling data for ten minutes. Localhost uses the Vite middleware and does not require Redis.

## Online ICE configuration

Online mode uses public STUN defaults. For a production deployment, optional Vercel environment variables can configure your own ICE services:

```text
VITE_STUN_URLS=stun:your-stun-host:3478
VITE_TURN_URL=turn:your-turn-host:3478
VITE_TURN_USERNAME=your-username
VITE_TURN_CREDENTIAL=your-credential
```

Offline mode never contacts these services.