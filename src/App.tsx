import { useEffect, useMemo, useRef, useState } from 'react';
import jsQR from 'jsqr';
import { createQrSvg } from './lib/qr';

type Role = 'sender' | 'receiver';
type ShareMode = 'single' | 'reusable';
type PairingMethod = 'qr' | 'code' | 'paste';
type NetworkMode = 'offline' | 'online';
type ConnectionStatus = 'idle' | 'generating' | 'waiting' | 'connecting' | 'connected' | 'closed' | 'error';

type SignalPacket = {
  kind: 'offer' | 'answer';
  sessionId: string;
  shareMode: ShareMode;
  sdp: RTCSessionDescriptionInit;
};

type ReceivedFile = {
  name: string;
  type: string;
  size: number;
  url: string;
  receivedAt: string;
  savedToDisk?: boolean;
};

type IncomingTransfer = {
  id: string;
  name: string;
  type: string;
  size: number;
  chunks: Uint8Array[];
  receivedBytes: number;
  writer?: FileSystemWritableFileStream;
};

type TransferProgress = {
  fileName: string;
  percent: number;
  bytesSent: number;
  totalBytes: number;
  speedMbps: number;
};

type TransferState = 'idle' | 'sending' | 'paused' | 'cancelled';

const chunkSize = 256 * 1024; // 256 KB chunk size for maximum speed
const maxFileSizeGb = 5;
const maxFileSizeBytes = maxFileSizeGb * 1024 * 1024 * 1024;

function createSessionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('').toUpperCase();
}

function encodeSignal(signal: SignalPacket): string {
  return `QRFS1.${btoa(JSON.stringify(signal))}`;
}

function decodeSignal(payload: string): SignalPacket {
  const trimmed = payload.trim();
  const encoded = trimmed.startsWith('QRFS1.') ? trimmed.slice(6) : trimmed;
  return JSON.parse(atob(encoded)) as SignalPacket;
}

function createPairingUrl(code: string): string {
  if (typeof window === 'undefined') {
    return `/pair?code=${encodeURIComponent(code)}`;
  }

  return `${window.location.origin}${window.location.pathname}?code=${encodeURIComponent(code)}`;
}

function extractPairingCode(value: string): string | null {
  try {
    const url = new URL(value);
    const code = url.searchParams.get('code');
    return code && /^\d{6}$/.test(code) ? code : null;
  } catch {
    return /^\d{6}$/.test(value.trim()) ? value.trim() : null;
  }
}

function buildPeerConnection(networkMode: NetworkMode): RTCPeerConnection {
  if (networkMode === 'offline') {
    return new RTCPeerConnection({ iceServers: [] });
  }

  const configuredStunServers = import.meta.env.VITE_STUN_URLS
    ?.split(',')
    .map((url: string) => url.trim())
    .filter(Boolean);
  const stunServers = configuredStunServers?.length
    ? configuredStunServers
    : ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'];

  const iceServers: RTCIceServer[] = [{ urls: stunServers }];
  if (import.meta.env.VITE_TURN_URL && import.meta.env.VITE_TURN_USERNAME && import.meta.env.VITE_TURN_CREDENTIAL) {
    iceServers.push({
      urls: import.meta.env.VITE_TURN_URL,
      username: import.meta.env.VITE_TURN_USERNAME,
      credential: import.meta.env.VITE_TURN_CREDENTIAL,
    });
  }

  return new RTCPeerConnection({ iceServers });
}

function waitForIceGatheringComplete(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      pc.removeEventListener('icegatheringstatechange', onStateChange);
      resolve();
    }, 2500);

    const onStateChange = () => {
      if (pc.iceGatheringState === 'complete') {
        clearTimeout(timeout);
        pc.removeEventListener('icegatheringstatechange', onStateChange);
        resolve();
      }
    };

    pc.addEventListener('icegatheringstatechange', onStateChange);
  });
}

async function waitForBufferedRoom(channel: RTCDataChannel): Promise<void> {
  const HIGH_WATER_MARK = 8 * 1024 * 1024; // 8 MB
  const LOW_WATER_MARK = 2 * 1024 * 1024;  // 2 MB

  if (channel.bufferedAmount <= HIGH_WATER_MARK) {
    return;
  }

  await new Promise<void>((resolve) => {
    channel.bufferedAmountLowThreshold = LOW_WATER_MARK;
    const onLow = () => {
      channel.removeEventListener('bufferedamountlow', onLow);
      resolve();
    };
    channel.addEventListener('bufferedamountlow', onLow);
  });
}

function readBlobAsDownloadUrl(blob: Blob): string {
  return URL.createObjectURL(blob);
}

export default function App() {
  const [role, setRole] = useState<Role>('sender');
  const [shareMode, setShareMode] = useState<ShareMode>('single');
  const [pairingMethod, setPairingMethod] = useState<PairingMethod>('qr');
  const [networkMode, setNetworkMode] = useState<NetworkMode>('offline');
  const [status, setStatus] = useState<ConnectionStatus>('idle');
  const [statusMessage, setStatusMessage] = useState('Create a QR session to pair devices offline.');
  const [sessionId, setSessionId] = useState('');
  const [offerText, setOfferText] = useState('');
  const [answerText, setAnswerText] = useState('');
  const [pendingSignalText, setPendingSignalText] = useState('');
  const [pickedFiles, setPickedFiles] = useState<File[]>([]);
  const [receivedFiles, setReceivedFiles] = useState<ReceivedFile[]>([]);
  const [connectedAt, setConnectedAt] = useState<string | null>(null);
  const [receiveFolderReady, setReceiveFolderReady] = useState(false);
  const [transferProgress, setTransferProgress] = useState<TransferProgress | null>(null);
  const [transferState, setTransferState] = useState<TransferState>('idle');
  const [isDragging, setIsDragging] = useState(false);
  const [pairingCode, setPairingCode] = useState('');
  const [pairingExpiresAt, setPairingExpiresAt] = useState<number | null>(null);
  const [scannerActive, setScannerActive] = useState(false);
  const [scannerSupported, setScannerSupported] = useState(false);

  const peerRef = useRef<RTCPeerConnection | null>(null);
  const channelRef = useRef<RTCDataChannel | null>(null);
  const incomingRef = useRef<IncomingTransfer | null>(null);
  const receivedUrlsRef = useRef<string[]>([]);
  const receiveDirectoryRef = useRef<FileSystemDirectoryHandle | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const scannerStreamRef = useRef<MediaStream | null>(null);
  const scannerFrameRef = useRef<number | null>(null);
  const scannerActiveRef = useRef(false);
  const pairingPollRef = useRef<number | null>(null);
  const currentShareModeRef = useRef<ShareMode>('single');
  const closedRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const transferPausedRef = useRef(false);
  const transferCancelledRef = useRef(false);
  const activeFileIdRef = useRef<string | null>(null);

  useEffect(() => {
    setScannerSupported(!!navigator.mediaDevices?.getUserMedia);

    const urlCode = new URLSearchParams(window.location.search).get('code');
    if (urlCode && /^\d{6}$/.test(urlCode)) {
      setRole('receiver');
      setPairingMethod('code');
      setPairingCode(urlCode);
      setStatusMessage('Pairing code loaded from the scanned QR. Tap Join with code to connect.');
    }

    // Auto-restore state on refresh
    const saved = sessionStorage.getItem('qrfs_session');
    if (saved) {
      try {
        const data = JSON.parse(saved);
        setSessionId(data.sessionId || '');
        setRole(data.role || 'sender');
        setShareMode(data.shareMode || 'single');
        setNetworkMode(data.networkMode || 'offline');
        setOfferText(data.offerText || '');
        setAnswerText(data.answerText || '');
        setPairingCode(data.pairingCode || '');
        setPairingExpiresAt(data.pairingExpiresAt || null);

        if (data.role === 'sender' && data.answerText) {
          setPendingSignalText(data.answerText);
          setStatusMessage('Session restored after refresh. Click "Apply answer" to reconnect.');
        } else if (data.role === 'receiver' && data.offerText) {
          setPendingSignalText(data.offerText);
          setStatusMessage('Session restored after refresh. Click "Generate answer QR" to reconnect.');
        }
      } catch {
        sessionStorage.removeItem('qrfs_session');
      }
    }
  }, []);

  // Sync state to sessionStorage for tab refresh support
  useEffect(() => {
    if (sessionId) {
      sessionStorage.setItem(
        'qrfs_session',
        JSON.stringify({
          sessionId,
          role,
          shareMode,
          networkMode,
          offerText,
          answerText,
          pairingCode,
          pairingExpiresAt,
        }),
      );
    }
  }, [sessionId, role, shareMode, networkMode, offerText, answerText, pairingCode, pairingExpiresAt]);

  const resetConnection = () => {
    closedRef.current = true;

    if (pairingPollRef.current !== null) {
      window.clearInterval(pairingPollRef.current);
      pairingPollRef.current = null;
    }

    if (channelRef.current) {
      channelRef.current.close();
      channelRef.current = null;
    }

    if (peerRef.current) {
      peerRef.current.ondatachannel = null;
      peerRef.current.onconnectionstatechange = null;
      peerRef.current.close();
      peerRef.current = null;
    }

    incomingRef.current = null;
    sessionStorage.removeItem('qrfs_session');
    setStatus('closed');
    setStatusMessage('Session closed. You can create a new one anytime.');
  };

  useEffect(() => {
    return () => {
      scannerActiveRef.current = false;

      if (pairingPollRef.current !== null) {
        window.clearInterval(pairingPollRef.current);
      }

      if (scannerFrameRef.current !== null) {
        cancelAnimationFrame(scannerFrameRef.current);
      }

      if (scannerStreamRef.current) {
        for (const track of scannerStreamRef.current.getTracks()) {
          track.stop();
        }
      }

      if (peerRef.current) {
        peerRef.current.close();
      }

      for (const url of receivedUrlsRef.current) {
        URL.revokeObjectURL(url);
      }
    };
  }, []);

  useEffect(() => {
    if (role !== 'receiver') {
      void stopScanner();
    }
  }, [role]);

  const qrMarkup = useMemo(() => {
    const text = role === 'sender' ? (pairingCode ? createPairingUrl(pairingCode) : offerText) : answerText;
    return text ? createQrSvg(text) : '';
  }, [answerText, offerText, pairingCode, role]);

  const setupSenderChannel = (channel: RTCDataChannel) => {
    channel.onopen = () => {
      setStatus('connected');
      setConnectedAt(new Date().toLocaleTimeString());
      setStatusMessage('Channel open. Send one or more files directly to the peer.');
    };

    channel.onclose = () => {
      if (!closedRef.current) {
        setStatus('closed');
        setStatusMessage('The peer connection closed.');
      }
    };

    channel.onerror = () => {
      setStatus('error');
      setStatusMessage('The data channel reported an error.');
    };

    channel.onmessage = (event) => {
      if (typeof event.data !== 'string') {
        return;
      }

      const message = JSON.parse(event.data) as { type: string; fileId?: string };
      if (message.type === 'received' && currentShareModeRef.current === 'single') {
        setStatusMessage('Receiver confirmed the transfer. One-time session complete.');
        resetConnection();
      }
    };
  };

  const setupReceiverChannel = (channel: RTCDataChannel) => {
    channel.onopen = () => {
      setStatus('connected');
      setConnectedAt(new Date().toLocaleTimeString());
      setStatusMessage('Channel open. Waiting for files.');
    };

    channel.onclose = () => {
      if (!closedRef.current) {
        setStatus('closed');
        setStatusMessage('The sender closed the connection.');
      }
    };

    channel.onerror = () => {
      setStatus('error');
      setStatusMessage('The data channel reported an error.');
    };

    channel.onmessage = async (event) => {
      if (typeof event.data === 'string') {
        const message = JSON.parse(event.data) as
          | { type: 'file-start'; fileId: string; name: string; mime: string; size: number }
          | { type: 'file-end'; fileId: string }
          | { type: 'transfer-cancel'; fileId: string }
          | { type: 'close' };

        if (message.type === 'file-start') {
          if (message.size > maxFileSizeBytes) {
            setStatus('error');
            setStatusMessage(`${message.name} is larger than the ${maxFileSizeGb} GB limit.`);
            channel.send(JSON.stringify({ type: 'close' }));
            resetConnection();
            return;
          }

          const cleanName = message.name.replace(/^\d+-/, '');

          let writer: FileSystemWritableFileStream | undefined;
          if (receiveDirectoryRef.current) {
            const fileHandle = await receiveDirectoryRef.current.getFileHandle(cleanName, { create: true });
            writer = await fileHandle.createWritable();
            setReceiveFolderReady(true);
          }

          incomingRef.current = {
            id: message.fileId,
            name: cleanName,
            type: message.mime,
            size: message.size,
            chunks: [],
            receivedBytes: 0,
            writer,
          };
          setStatusMessage(`Receiving ${cleanName}...`);
          return;
        }

        if (message.type === 'file-end' && incomingRef.current && incomingRef.current.id === message.fileId) {
          const incoming = incomingRef.current;
          let url = '';
          let savedToDisk = false;

          if (incoming.writer) {
            await incoming.writer.close();
            savedToDisk = true;
          } else {
            const blobParts = incoming.chunks.map((chunk) => new Uint8Array(chunk).buffer as ArrayBuffer);
            const blob = new Blob(blobParts, { type: incoming.type || 'application/octet-stream' });
            url = readBlobAsDownloadUrl(blob);
            receivedUrlsRef.current.push(url);
          }

          setReceivedFiles((current) => [
            {
              name: incoming.name,
              type: incoming.type,
              size: incoming.size,
              url,
              receivedAt: new Date().toLocaleTimeString(),
              savedToDisk,
            },
            ...current,
          ]);

          incomingRef.current = null;
          channel.send(JSON.stringify({ type: 'received', fileId: message.fileId }));

          if (currentShareModeRef.current === 'single') {
            setStatusMessage('First transfer completed. One-time session has been closed.');
            resetConnection();
          } else {
            setStatusMessage('File received. The session stays open for more transfers.');
          }
          return;
        }

        if (message.type === 'transfer-cancel' && incomingRef.current && incomingRef.current.id === message.fileId) {
          if (incomingRef.current.writer) {
            await incomingRef.current.writer.abort();
          }
          incomingRef.current = null;
          setStatusMessage('Transfer cancelled by the sender.');
          return;
        }

        if (message.type === 'close') {
          resetConnection();
        }

        return;
      }

      if (!incomingRef.current) {
        return;
      }

      const chunk = event.data instanceof ArrayBuffer ? new Uint8Array(event.data) : new Uint8Array(await event.data.arrayBuffer());
      if (incomingRef.current.writer) {
        await incomingRef.current.writer.write(chunk);
      } else {
        incomingRef.current.chunks.push(chunk);
      }
      incomingRef.current.receivedBytes += chunk.byteLength;
      setStatusMessage(
        `Receiving ${incomingRef.current.name}: ${Math.min(100, Math.round((incomingRef.current.receivedBytes / incomingRef.current.size) * 100))}%`,
      );
    };
  };

  const prepareReceiveFolder = async () => {
    try {
      if (!window.isSecureContext) {
        setStatus('error');
        setStatusMessage('Folder selection requires HTTPS or localhost (Secure Context).');
        return;
      }

      if (!('showDirectoryPicker' in window)) {
        setStatus('error');
        setStatusMessage('This browser/device does not support direct disk folder selection.');
        return;
      }

      const directoryHandle = await (window as Window & {
        showDirectoryPicker: () => Promise<FileSystemDirectoryHandle>;
      }).showDirectoryPicker();

      receiveDirectoryRef.current = directoryHandle;
      setReceiveFolderReady(true);
      setStatus('idle');
      setStatusMessage('Receive folder ready. Files will be written directly to disk.');
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        setStatusMessage('Receive folder selection was canceled.');
      } else {
        setStatus('error');
        setStatusMessage('Failed to select receive folder.');
      }
    }
  };

  const stopScanner = async () => {
    scannerActiveRef.current = false;
    setScannerActive(false);

    if (scannerFrameRef.current !== null) {
      cancelAnimationFrame(scannerFrameRef.current);
      scannerFrameRef.current = null;
    }

    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.srcObject = null;
    }

    if (scannerStreamRef.current) {
      for (const track of scannerStreamRef.current.getTracks()) {
        track.stop();
      }
      scannerStreamRef.current = null;
    }
  };

  const startScanner = async () => {
    if (role !== 'receiver') {
      setStatusMessage('Switch to Receiver to scan a QR code.');
      return;
    }

    if (!window.isSecureContext) {
      setStatus('error');
      setStatusMessage('Camera access requires HTTPS or localhost (Secure Context).');
      return;
    }

    if (!scannerSupported) {
      setStatus('error');
      setStatusMessage('Camera access is not supported in this browser. Use paste instead.');
      return;
    }

    try {
      await stopScanner();
      
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      });

      scannerStreamRef.current = stream;
      scannerActiveRef.current = true;
      setScannerActive(true);

      if (!videoRef.current) {
        throw new Error('Scanner view is not ready.');
      }

      videoRef.current.srcObject = stream;
      videoRef.current.setAttribute('playsinline', 'true'); // Required for iOS/Android WebView
      await videoRef.current.play();

      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d', { willReadFrequently: true });

      if (!context) {
        throw new Error('Could not initialize the scanner canvas.');
      }

      const scanFrame = async () => {
        if (!scannerActiveRef.current || !videoRef.current) {
          return;
        }

        try {
          const video = videoRef.current;
          if (video.readyState === video.HAVE_ENOUGH_DATA && video.videoWidth > 0 && video.videoHeight > 0) {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            context.drawImage(video, 0, 0, canvas.width, canvas.height);
            const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
            const code = jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: 'attemptBoth' });

            if (code?.data) {
              const scannedCode = extractPairingCode(code.data);
              if (scannedCode) {
                setPairingCode(scannedCode);
                setPairingMethod('code');
                setStatusMessage('Pairing code scanned. Tap Join with code to connect.');
              } else {
                setPendingSignalText(code.data);
                setPairingMethod('paste');
                setStatusMessage('QR payload scanned. Tap Generate answer QR to continue.');
              }
              await stopScanner();
              return;
            }
          }
        } catch {
          // Continue scanning
        }

        scannerFrameRef.current = requestAnimationFrame(() => {
          void scanFrame();
        });
      };

      void scanFrame();
    } catch (error) {
      await stopScanner();
      setStatus('error');
      if (error instanceof DOMException && error.name === 'NotAllowedError') {
        setStatusMessage('Camera permission was denied in browser settings.');
      } else {
        setStatusMessage(error instanceof Error ? error.message : 'Could not start camera.');
      }
    }
  };

  const createSenderSession = async () => {
    try {
      closedRef.current = false;
      currentShareModeRef.current = shareMode;
      setStatus('generating');
      setStatusMessage('Generating a local offer and waiting for the peer response.');

      const pc = buildPeerConnection(networkMode);
      peerRef.current = pc;
      const channel = pc.createDataChannel('qr-file-share');
      channel.binaryType = 'arraybuffer';
      channelRef.current = channel;

      setupSenderChannel(channel);

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'connected') {
          setStatus('connected');
          setConnectedAt(new Date().toLocaleTimeString());
          setStatusMessage('Peer connected. Pick one or more files to send.');
        }
        if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
          setStatusMessage(`Connection ${pc.connectionState}.`);
        }
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await waitForIceGatheringComplete(pc);

      const sessionToken = sessionId || createSessionId();
      const localDescription = pc.localDescription ?? offer;
      const payload = encodeSignal({
        kind: 'offer',
        sessionId: sessionToken,
        shareMode,
        sdp: localDescription,
      });

      setSessionId(sessionToken);
      setOfferText(payload);
      setAnswerText('');

      const registrationResponse = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: sessionToken,
          shareMode,
          offer: localDescription,
        }),
      });

      if (!registrationResponse.ok) {
        throw new Error('Could not publish the local pairing code.');
      }

      const registration = await registrationResponse.json() as { code: string; expiresAt: number };
      setPairingCode(registration.code);
      setPairingExpiresAt(registration.expiresAt);
      setStatus('waiting');
      setStatusMessage('Share the QR or enter the 6-digit code on the receiver.');

      pairingPollRef.current = window.setInterval(async () => {
        try {
          const answerResponse = await fetch(`/api/sessions/${registration.code}/answer`);
          if (!answerResponse.ok) {
            return;
          }

          const result = await answerResponse.json() as { answer: RTCSessionDescriptionInit | null };
          if (!result.answer || !peerRef.current) {
            return;
          }

          if (pairingPollRef.current !== null) {
            window.clearInterval(pairingPollRef.current);
            pairingPollRef.current = null;
          }

          await peerRef.current.setRemoteDescription(result.answer);
          setStatus('connecting');
          setStatusMessage('Receiver joined with the pairing code. Connecting directly...');
        } catch {
          setStatusMessage('Waiting for the receiver to enter the pairing code.');
        }
      }, 1000);
    } catch (error) {
      setStatus('error');
      setStatusMessage(error instanceof Error ? error.message : 'Could not create the offer.');
    }
  };

  const createReceiverAnswerFromSignal = async (signal: SignalPacket, viaCode = false) => {
    if (signal.kind !== 'offer') {
      throw new Error('Expected an offer payload.');
    }

    currentShareModeRef.current = signal.shareMode;
    const pc = buildPeerConnection(networkMode);
    peerRef.current = pc;

    pc.ondatachannel = (event) => {
      const channel = event.channel;
      channel.binaryType = 'arraybuffer';
      channelRef.current = channel;
      setupReceiverChannel(channel);
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
        setStatus('connected');
        setConnectedAt(new Date().toLocaleTimeString());
        setStatusMessage('Connected. Files will appear here as they arrive.');
      }
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        setStatusMessage(`Connection ${pc.connectionState}.`);
      }
    };

    await pc.setRemoteDescription(signal.sdp);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await waitForIceGatheringComplete(pc);

    const answerDescription = pc.localDescription ?? answer;
    const payload = encodeSignal({
      kind: 'answer',
      sessionId: signal.sessionId,
      shareMode: signal.shareMode,
      sdp: answerDescription,
    });

    setSessionId(signal.sessionId);
    setAnswerText(payload);

    if (viaCode) {
      const response = await fetch(`/api/sessions/${pairingCode}/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answer: answerDescription }),
      });

      if (!response.ok) {
        throw new Error('Could not publish the answer to the sender.');
      }

      setStatus('waiting');
      setStatusMessage('Answer sent. Waiting for the sender to connect directly.');
    } else {
      setStatus('waiting');
      setStatusMessage('Send this answer QR back to the sender to finish pairing.');
    }
  };

  const createReceiverAnswer = async () => {
    try {
      closedRef.current = false;
      if (!pendingSignalText.trim()) {
        setStatusMessage('Paste or scan the sender offer first.');
        return;
      }

      setStatus('connecting');
      await createReceiverAnswerFromSignal(decodeSignal(pendingSignalText));
    } catch (error) {
      setStatus('error');
      setStatusMessage(error instanceof Error ? error.message : 'Could not build the answer.');
    }
  };

  const joinWithPairingCode = async () => {
    try {
      const normalizedCode = pairingCode.trim();
      if (!/^\d{6}$/.test(normalizedCode)) {
        throw new Error('Enter the 6-digit code shown on the sender.');
      }

      closedRef.current = false;
      setStatus('connecting');
      setStatusMessage('Looking up the sender session on the local network...');

      const response = await fetch(`/api/sessions/${normalizedCode}`);
      if (!response.ok) {
        throw new Error('That code is invalid or expired.');
      }

      const data = await response.json() as {
        offer: RTCSessionDescriptionInit;
        sessionId: string;
        shareMode: ShareMode;
        expiresAt: number;
      };

      setPairingExpiresAt(data.expiresAt);
      await createReceiverAnswerFromSignal(
        {
          kind: 'offer',
          sessionId: data.sessionId,
          shareMode: data.shareMode,
          sdp: data.offer,
        },
        true,
      );
    } catch (error) {
      setStatus('error');
      setStatusMessage(error instanceof Error ? error.message : 'Could not join with that code.');
    }
  };

  const applyAnswerOnSender = async () => {
    try {
      if (!peerRef.current) {
        throw new Error('Create the sender offer first.');
      }

      if (!pendingSignalText.trim()) {
        throw new Error('Paste the answer QR payload first.');
      }

      const signal = decodeSignal(pendingSignalText);
      if (signal.kind !== 'answer') {
        throw new Error('Expected an answer QR payload.');
      }

      await peerRef.current.setRemoteDescription(signal.sdp);
      setStatus('connecting');
      setStatusMessage('Answer accepted. Waiting for the direct connection to finish.');
    } catch (error) {
      setStatus('error');
      setStatusMessage(error instanceof Error ? error.message : 'Could not apply the answer.');
    }
  };

  const sendSelectedFiles = async () => {
    if (!channelRef.current || channelRef.current.readyState !== 'open') {
      setStatusMessage('Connect the peer first.');
      return;
    }

    if (!pickedFiles.length) {
      setStatusMessage('Choose one or more files first.');
      return;
    }

    try {
      transferPausedRef.current = false;
      transferCancelledRef.current = false;
      setTransferState('sending');
      const oversizedFile = pickedFiles.find((file) => file.size > maxFileSizeBytes);
      if (oversizedFile) {
        setStatus('error');
        setStatusMessage(`${oversizedFile.name} is larger than the ${maxFileSizeGb} GB limit.`);
        return;
      }

      setStatusMessage('Sending files over the direct connection.');

      for (const file of pickedFiles) {
        const fileId = `${Date.now()}-${file.name}`;
        activeFileIdRef.current = fileId;
        const cleanName = file.name.replace(/^\d+-/, '');
        const startedAt = performance.now();
        let sentBytes = 0;

        setTransferProgress({
          fileName: cleanName,
          percent: 0,
          bytesSent: 0,
          totalBytes: file.size,
          speedMbps: 0,
        });

        channelRef.current.send(
          JSON.stringify({
            type: 'file-start',
            fileId,
            name: cleanName,
            mime: file.type,
            size: file.size,
          }),
        );

        let offset = 0;
        while (offset < file.size) {
          while (transferPausedRef.current && !transferCancelledRef.current) {
            await new Promise((resolve) => window.setTimeout(resolve, 120));
          }

          if (transferCancelledRef.current) {
            channelRef.current.send(JSON.stringify({ type: 'transfer-cancel', fileId }));
            setTransferState('cancelled');
            setStatusMessage('Transfer cancelled.');
            return;
          }

          const slice = file.slice(offset, offset + chunkSize);
          const chunkBuffer = await slice.arrayBuffer();

          channelRef.current.send(chunkBuffer);
          offset += chunkBuffer.byteLength;
          sentBytes += chunkBuffer.byteLength;

          const elapsedSeconds = Math.max((performance.now() - startedAt) / 1000, 0.1);
          setTransferProgress({
            fileName: cleanName,
            percent: Math.min(100, Math.round((sentBytes / file.size) * 100)),
            bytesSent: sentBytes,
            totalBytes: file.size,
            speedMbps: sentBytes / elapsedSeconds / (1024 * 1024),
          });

          await waitForBufferedRoom(channelRef.current);
        }

        channelRef.current.send(JSON.stringify({ type: 'file-end', fileId }));

        if (currentShareModeRef.current === 'single') {
          break;
        }
      }

      if (currentShareModeRef.current === 'single') {
        setStatusMessage('One-time transfer sent. Waiting for receiver confirmation.');
      } else {
        setStatusMessage('Transfer queue sent. The session remains available for more files.');
      }
      setTransferState('idle');
      activeFileIdRef.current = null;
    } catch (error) {
      setTransferState('cancelled');
      setStatus('error');
      setStatusMessage(error instanceof Error ? error.message : 'Could not send selected files.');
    }
  };

  const pauseTransfer = () => {
    transferPausedRef.current = true;
    setTransferState('paused');
    setStatusMessage('Transfer paused.');
  };

  const resumeTransfer = () => {
    transferPausedRef.current = false;
    setTransferState('sending');
    setStatusMessage('Transfer resumed.');
  };

  const cancelTransfer = () => {
    transferCancelledRef.current = true;
    transferPausedRef.current = false;
    setTransferState('cancelled');
    setStatusMessage('Cancelling transfer...');
  };

  const addFilesToQueue = (files: File[]) => {
    if (!files.length) {
      return;
    }

    setPickedFiles((current) => {
      const existing = new Set(current.map((file) => `${file.name}:${file.size}:${file.lastModified}`));
      return [...current, ...files.filter((file) => !existing.has(`${file.name}:${file.size}:${file.lastModified}`))];
    });
  };

  const removeQueuedFile = (fileToRemove: File) => {
    setPickedFiles((current) => current.filter((file) => file !== fileToRemove));
  };

  const formatBytes = (bytes: number) => {
    if (bytes >= 1024 * 1024 * 1024) {
      return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const copyText = async (text: string) => {
    await navigator.clipboard.writeText(text);
    setStatusMessage('Copied QR payload to clipboard.');
  };

  const closeAll = () => {
    closedRef.current = true;
    resetConnection();
  };

  const changeNetworkMode = (mode: NetworkMode) => {
    if (mode === networkMode) {
      return;
    }

    if (peerRef.current || pairingCode) {
      closeAll();
    }

    setNetworkMode(mode);
    setStatus('idle');
    setStatusMessage(mode === 'offline'
      ? 'Offline LAN mode selected. No external ICE servers will be used.'
      : 'Online mode selected. STUN may help devices connect across networks.');
  };

  return (
    <main className="app-shell">
      <section className="hero">
        <div>
          <p className="eyebrow">Offline QR transfer</p>
          <h1>Secure file sharing without internet.</h1>
          <p className="lede">
            Pair two devices with a QR code, then move files directly over WebRTC. Choose a one-time session or keep the
            channel open for repeated transfers.
          </p>
        </div>

        <div className="status-card">
          <span className={`status-badge status-${status}`}>{status}</span>
          <p>{statusMessage}</p>
          <span className="quiet">Network: {networkMode === 'offline' ? 'Offline LAN' : 'Online-assisted'}</span>
          {sessionId ? <span className="quiet">Session {sessionId}</span> : null}
          {connectedAt ? <span className="quiet">Connected at {connectedAt}</span> : null}
        </div>
      </section>

      <section className="toolbar">
        <div className="segmented-control">
          <button className={role === 'sender' ? 'active' : ''} onClick={() => setRole('sender')} type="button">
            Sender
          </button>
          <button className={role === 'receiver' ? 'active' : ''} onClick={() => setRole('receiver')} type="button">
            Receiver
          </button>
        </div>

        <div className="segmented-control">
          <button className={shareMode === 'single' ? 'active' : ''} onClick={() => setShareMode('single')} type="button">
            One-time
          </button>
          <button className={shareMode === 'reusable' ? 'active' : ''} onClick={() => setShareMode('reusable')} type="button">
            Multiple times
          </button>
        </div>

        <div className="segmented-control" aria-label="Network mode">
          <button className={networkMode === 'offline' ? 'active' : ''} onClick={() => changeNetworkMode('offline')} type="button">
            Offline LAN
          </button>
          <button className={networkMode === 'online' ? 'active' : ''} onClick={() => changeNetworkMode('online')} type="button">
            Online
          </button>
        </div>

        <button className="ghost-button" onClick={closeAll} type="button">
          Close session
        </button>
      </section>

      <section className="grid">
        <article className="card">
          <div className="card-head">
            <div>
              <p className="eyebrow">1. Pairing</p>
              <h2>{role === 'sender' ? 'Create the offer QR' : 'Paste the sender QR'}</h2>
            </div>
          </div>

          {role === 'sender' ? (
            <div className="pairing-code-panel">
              <div>
                <span className="mini-title">Or enter this code on the receiver</span>
                <strong className="pairing-code-value">{pairingCode || '------'}</strong>
                <p className="quiet">Expires in 10 minutes and stays on this local network.</p>
              </div>
              <button className="ghost-button" onClick={() => copyText(pairingCode)} disabled={!pairingCode} type="button">
                Copy code
              </button>
            </div>
          ) : (
            <div className="pairing-methods segmented-control">
              <button className={pairingMethod === 'qr' ? 'active' : ''} onClick={() => setPairingMethod('qr')} type="button">
                Scan QR
              </button>
              <button className={pairingMethod === 'code' ? 'active' : ''} onClick={() => setPairingMethod('code')} type="button">
                Enter code
              </button>
              <button className={pairingMethod === 'paste' ? 'active' : ''} onClick={() => setPairingMethod('paste')} type="button">
                Paste
              </button>
            </div>
          )}

          {role === 'receiver' && pairingMethod === 'qr' ? (
            <div className="scanner-shell">
              <div className="scanner-preview">
                <video ref={videoRef} className="scanner-video" playsInline muted autoPlay />
                {!scannerActive ? <div className="scanner-overlay">Camera scanner is off</div> : null}
              </div>
              <div className="action-row scanner-actions">
                <button className="primary-button" onClick={startScanner} type="button">
                  {scannerActive ? 'Scanning camera on' : 'Scan QR from camera'}
                </button>
                <button className="secondary-button" onClick={stopScanner} type="button">
                  Stop scanner
                </button>
              </div>
              {!scannerSupported ? <p className="quiet">This browser does not support QR camera scanning, so paste mode stays available.</p> : null}
            </div>
          ) : null}

          {role === 'receiver' && pairingMethod === 'code' ? (
            <label className="field code-input-field">
              <span>6-digit pairing code</span>
              <input
                className="pairing-code-input"
                inputMode="numeric"
                maxLength={6}
                pattern="[0-9]*"
                value={pairingCode}
                onChange={(event) => setPairingCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="000000"
              />
            </label>
          ) : role === 'receiver' && pairingMethod === 'paste' ? (
            <label className="field">
              <span>Paste sender payload</span>
              <textarea
                rows={6}
                value={pendingSignalText}
                onChange={(event) => setPendingSignalText(event.target.value)}
                placeholder="Paste the sender QR payload here."
              />
            </label>
          ) : null}

          <div className="action-row">
            {role === 'sender' ? (
              <button className="primary-button" onClick={createSenderSession} type="button">
                Generate sender QR
              </button>
            ) : pairingMethod === 'code' ? (
              <button className="primary-button" onClick={joinWithPairingCode} type="button">
                Join with code
              </button>
            ) : (
              <button className="primary-button" onClick={createReceiverAnswer} type="button">
                Generate answer QR
              </button>
            )}
            {role === 'sender' ? (
              <button className="secondary-button" onClick={applyAnswerOnSender} type="button">
                Apply answer
              </button>
            ) : pairingMethod === 'paste' ? (
              <button className="secondary-button" onClick={() => copyText(pendingSignalText)} type="button">
                Copy pasted text
              </button>
            ) : null}
          </div>

          <div className="qr-panel">
            {qrMarkup ? <div className="qr-image" dangerouslySetInnerHTML={{ __html: qrMarkup }} /> : <div className="qr-placeholder">Generate a session to show the QR</div>}
          </div>

          <details className="manual-panel">
            <summary>Manual pairing tools</summary>
            <textarea rows={5} readOnly value={role === 'sender' ? offerText : answerText} placeholder="The signaling payload appears after pairing starts." />
            <div className="action-row compact">
              <button className="ghost-button" onClick={() => copyText(role === 'sender' ? offerText : answerText)} disabled={!(role === 'sender' ? offerText : answerText)} type="button">
                Copy payload
              </button>
              <button className="ghost-button" onClick={() => setPendingSignalText(role === 'sender' ? offerText : answerText)} disabled={!(role === 'sender' ? offerText : answerText)} type="button">
                Load payload
              </button>
            </div>
          </details>
        </article>

        <article className="card">
          <div className="card-head">
            <div>
              <p className="eyebrow">2. Transfer</p>
              <h2>Send files directly</h2>
            </div>
          </div>

          <div
            className={`dropzone ${isDragging ? 'is-dragging' : ''}`}
            onClick={() => fileInputRef.current?.click()}
            onDragEnter={(event) => {
              event.preventDefault();
              setIsDragging(true);
            }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={() => setIsDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setIsDragging(false);
              addFilesToQueue(Array.from(event.dataTransfer.files));
            }}
            role="button"
            tabIndex={0}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                fileInputRef.current?.click();
              }
            }}
          >
            <span className="dropzone-icon">+</span>
            <strong>{isDragging ? 'Drop files to add them' : 'Drop files here or browse'}</strong>
            <small className="quiet">Up to {maxFileSizeGb} GB per file</small>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              hidden
              onChange={(event) => {
                addFilesToQueue(Array.from(event.target.files ?? []));
                event.target.value = '';
              }}
            />
          </div>

          {role === 'receiver' ? (
            <div className="action-row compact">
              <button className="ghost-button" onClick={prepareReceiveFolder} type="button">
                {receiveFolderReady ? 'Receive folder ready' : 'Prepare receive folder'}
              </button>
            </div>
          ) : null}

          <div className="file-summary">
            {pickedFiles.length ? (
              <ul>
                {pickedFiles.map((file) => {
                  const cleanDisplayName = file.name.replace(/^\d+-/, '');
                  return (
                    <li key={`${file.name}-${file.size}`}>
                      <div>
                        <strong>{cleanDisplayName}</strong>
                        <span>{formatBytes(file.size)}</span>
                      </div>
                      <button className="remove-file-button" onClick={() => removeQueuedFile(file)} aria-label={`Remove ${cleanDisplayName}`} type="button">
                        ×
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="quiet">Choose files after the connection is ready.</p>
            )}
          </div>

          <div className="action-row">
            <button 
              className="primary-button" 
              onClick={sendSelectedFiles} 
              disabled={status !== 'connected'}
              type="button"
            >
              Send selected files
            </button>
            <button className="secondary-button" onClick={() => setPickedFiles([])} type="button">
              Clear selection
            </button>
          </div>

          {transferProgress ? (
            <div className="transfer-progress" aria-live="polite">
              <div className="progress-heading">
                <div>
                  <span className="mini-title">Sending now</span>
                  <strong>{transferProgress.fileName}</strong>
                </div>
                <strong>{transferProgress.percent}%</strong>
              </div>
              <div className="progress-track">
                <span style={{ width: `${transferProgress.percent}%` }} />
              </div>
              <div className="progress-meta">
                <span>{formatBytes(transferProgress.bytesSent)} of {formatBytes(transferProgress.totalBytes)}</span>
                <span>{transferProgress.speedMbps.toFixed(1)} MB/s</span>
              </div>
              <div className="progress-actions">
                {transferState === 'paused' ? (
                  <button className="ghost-button" onClick={resumeTransfer} type="button">Resume</button>
                ) : transferState === 'sending' ? (
                  <button className="ghost-button" onClick={pauseTransfer} type="button">Pause</button>
                ) : null}
                {(transferState === 'sending' || transferState === 'paused') ? (
                  <button className="danger-button" onClick={cancelTransfer} type="button">Cancel transfer</button>
                ) : null}
              </div>
            </div>
          ) : null}

          <div className="received-list">
            <p className="mini-title">Received files</p>
            {receivedFiles.length ? (
              receivedFiles.map((file) => (
                <div className="received-item" key={`${file.name}-${file.receivedAt}`}>
                  <div>
                    <strong>{file.name}</strong>
                    <p>
                      {(file.size / (1024 * 1024 * 1024)).toFixed(2)} GB · {file.receivedAt}
                      {file.savedToDisk ? ' · saved to disk' : ''}
                    </p>
                  </div>
                  {file.savedToDisk ? (
                    <span className="download-link">Saved</span>
                  ) : (
                    <a className="download-link" href={file.url} download={file.name}>
                      Download
                    </a>
                  )}
                </div>
              ))
            ) : (
              <p className="quiet">Received files will appear here.</p>
            )}
          </div>
        </article>
      </section>

    </main>
  );
}