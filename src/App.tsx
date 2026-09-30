import { useEffect, useMemo, useRef, useState } from 'react';
import jsQR from 'jsqr';
import { createQrSvg } from './lib/qr';
import { RunningBackground } from './components/RunningBackground';
import { Confetti } from './components/Confetti';
import { playSound, getIsMuted, setIsMuted } from './lib/sound';

type Role = 'sender' | 'receiver';
type ShareMode = 'single' | 'reusable';
type PairingMethod = 'code' | 'qr' | 'paste';
type NetworkMode = 'offline' | 'online';
type ConnectionStatus = 'idle' | 'generating' | 'waiting' | 'connecting' | 'connected' | 'closed' | 'error';
type ThemeMode = 'dark' | 'light' | 'midnight';

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

type HistoryEntry = {
  id: string;
  action: 'sent' | 'received';
  fileName: string;
  fileSize: number;
  timestamp: string;
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
  peakSpeedMbps: number;
  etaSeconds: number;
  chunksSent: number;
  totalChunks: number;
};

type TransferState = 'idle' | 'sending' | 'paused' | 'cancelled';

const chunkSize = 256 * 1024; // 256 KB chunk
const maxFileSizeGb = 10;
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

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(0)} KB`;
  }
  return `${bytes} B`;
}

function getFileCategory(mime: string, name: string): { icon: string; label: string; color: string } {
  if (mime.startsWith('image/') || /\.(jpg|jpeg|png|gif|webp|svg|bmp)$/i.test(name)) {
    return { icon: '🖼️', label: 'IMAGE', color: 'border-cyan-400/40 text-cyan-300 bg-cyan-400/10' };
  }
  if (mime.startsWith('video/') || /\.(mp4|webm|mkv|mov|avi)$/i.test(name)) {
    return { icon: '🎬', label: 'VIDEO', color: 'border-purple-400/40 text-purple-300 bg-purple-400/10' };
  }
  if (mime.startsWith('audio/') || /\.(mp3|wav|ogg|flac|m4a|aac)$/i.test(name)) {
    return { icon: '🎵', label: 'AUDIO', color: 'border-emerald-400/40 text-emerald-300 bg-emerald-400/10' };
  }
  if (/\.(zip|rar|7z|tar|gz|bz2)$/i.test(name)) {
    return { icon: '📦', label: 'ARCHIVE', color: 'border-pink-400/40 text-pink-300 bg-pink-400/10' };
  }
  if (/\.(pdf|doc|docx|xls|xlsx|ppt|pptx|txt|md|csv)$/i.test(name)) {
    return { icon: '📄', label: 'DOC', color: 'border-blue-400/40 text-blue-300 bg-blue-400/10' };
  }
  if (/\.(js|ts|tsx|jsx|html|css|json|py|rs|go|cpp|c|java)$/i.test(name)) {
    return { icon: '💻', label: 'CODE', color: 'border-amber-400/40 text-amber-300 bg-amber-400/10' };
  }
  return { icon: '📁', label: 'FILE', color: 'border-slate-400/40 text-slate-300 bg-slate-400/10' };
}

export default function App() {
  const [role, setRole] = useState<Role>('sender');
  const [shareMode, setShareMode] = useState<ShareMode>('single');
  const [pairingMethod, setPairingMethod] = useState<PairingMethod>('code');
  const [networkMode, setNetworkMode] = useState<NetworkMode>('offline');
  const [status, setStatus] = useState<ConnectionStatus>('idle');
  const [statusMessage, setStatusMessage] = useState('Create a QR session or enter a 6-digit code to pair devices directly.');
  const [sessionId, setSessionId] = useState('');
  const [offerText, setOfferText] = useState('');
  const [answerText, setAnswerText] = useState('');
  const [pendingSignalText, setPendingSignalText] = useState('');
  const [pickedFiles, setPickedFiles] = useState<File[]>([]);
  const [receivedFiles, setReceivedFiles] = useState<ReceivedFile[]>([]);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [connectedAt, setConnectedAt] = useState<string | null>(null);
  const [receiveFolderReady, setReceiveFolderReady] = useState(false);
  const [transferProgress, setTransferProgress] = useState<TransferProgress | null>(null);
  const [transferState, setTransferState] = useState<TransferState>('idle');
  const [isDragging, setIsDragging] = useState(false);
  const [pairingCode, setPairingCode] = useState('');
  const [pairingExpiresAt, setPairingExpiresAt] = useState<number | null>(null);
  const [codeCountdown, setCodeCountdown] = useState<string>('');
  const [codeFlipped, setCodeFlipped] = useState(false);
  const [scannerActive, setScannerActive] = useState(false);
  const [scannerSupported, setScannerSupported] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [copiedState, setCopiedState] = useState<string | null>(null);
  const [theme, setTheme] = useState<ThemeMode>('dark');
  const [muted, setMuted] = useState(false);
  const [showConfetti, setShowConfetti] = useState(false);
  const [isIncomingActive, setIsIncomingActive] = useState(false);
  const [qrModalOpen, setQrModalOpen] = useState(false);

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
  const countdownTimerRef = useRef<number | null>(null);
  const currentShareModeRef = useRef<ShareMode>('single');
  const closedRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const transferPausedRef = useRef(false);
  const transferCancelledRef = useRef(false);
  const activeFileIdRef = useRef<string | null>(null);
  const peakSpeedRef = useRef(0);
  const throughputCanvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    setScannerSupported(!!navigator.mediaDevices?.getUserMedia);
    setMuted(getIsMuted());

    const savedTheme = (localStorage.getItem('qrfs_theme') as ThemeMode) || 'dark';
    setTheme(savedTheme);
    document.documentElement.setAttribute('data-theme', savedTheme);

    try {
      const savedHistory = JSON.parse(localStorage.getItem('qrfs_history') || '[]');
      setHistory(savedHistory);
    } catch {
      setHistory([]);
    }

    const urlCode = new URLSearchParams(window.location.search).get('code');
    if (urlCode && /^\d{6}$/.test(urlCode)) {
      setRole('receiver');
      setPairingMethod('code');
      setPairingCode(urlCode);
      setStatusMessage('Pairing code loaded from scanned link. Click Join with code.');
      showToast('Loaded pairing code from URL');
    }

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
          setStatusMessage('Session restored. Click "Apply answer" to connect.');
        } else if (data.role === 'receiver' && data.offerText) {
          setPendingSignalText(data.offerText);
          setStatusMessage('Session restored. Click "Generate answer QR".');
        }
      } catch {
        sessionStorage.removeItem('qrfs_session');
      }
    }
  }, []);

  const toggleTheme = () => {
    playSound('click');
    const nextTheme: ThemeMode = theme === 'dark' ? 'light' : theme === 'light' ? 'midnight' : 'dark';
    setTheme(nextTheme);
    document.documentElement.setAttribute('data-theme', nextTheme);
    localStorage.setItem('qrfs_theme', nextTheme);
    showToast(`Theme switched to ${nextTheme.toUpperCase()}`);
  };

  const toggleMute = () => {
    const next = !muted;
    setMuted(next);
    setIsMuted(next);
    if (!next) {
      playSound('click');
      showToast('Sound enabled');
    } else {
      showToast('Sound muted');
    }
  };

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => {
      setToastMessage((cur) => (cur === msg ? null : cur));
    }, 2800);
  };

  // Live throughput spectrum waveform animation on canvas
  useEffect(() => {
    const canvas = throughputCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animId: number;
    let phase = 0;

    const renderWave = () => {
      phase += 0.08;
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const isSending = transferState === 'sending';
      const isReceiving = isIncomingActive;
      const active = isSending || isReceiving;

      const barCount = 28;
      const barWidth = canvas.width / barCount - 2;

      for (let i = 0; i < barCount; i++) {
        const heightMultiplier = active ? Math.sin(phase + i * 0.45) * 0.5 + 0.5 : 0.08;
        const barHeight = Math.max(4, heightMultiplier * (canvas.height - 8));
        const x = i * (barWidth + 2);
        const y = canvas.height - barHeight;

        const grad = ctx.createLinearGradient(0, y, 0, canvas.height);
        grad.addColorStop(0, active ? '#7be7ca' : 'rgba(255,255,255,0.15)');
        grad.addColorStop(1, active ? '#82a7ff' : 'rgba(255,255,255,0.05)');

        ctx.fillStyle = grad;
        ctx.fillRect(x, y, barWidth, barHeight);
      }

      animId = requestAnimationFrame(renderWave);
    };

    renderWave();
    return () => cancelAnimationFrame(animId);
  }, [transferState, isIncomingActive]);

  useEffect(() => {
    if (!pairingExpiresAt) {
      setCodeCountdown('');
      if (countdownTimerRef.current !== null) {
        window.clearInterval(countdownTimerRef.current);
        countdownTimerRef.current = null;
      }
      return;
    }

    const updateCountdown = () => {
      const remainingMs = Math.max(0, pairingExpiresAt - Date.now());
      if (remainingMs <= 0) {
        setCodeCountdown('Expired');
        if (countdownTimerRef.current !== null) {
          window.clearInterval(countdownTimerRef.current);
          countdownTimerRef.current = null;
        }
      } else {
        const totalSec = Math.ceil(remainingMs / 1000);
        const mins = Math.floor(totalSec / 60);
        const secs = totalSec % 60;
        setCodeCountdown(`${mins}:${secs.toString().padStart(2, '0')}`);
      }
    };

    updateCountdown();
    countdownTimerRef.current = window.setInterval(updateCountdown, 1000);

    return () => {
      if (countdownTimerRef.current !== null) window.clearInterval(countdownTimerRef.current);
    };
  }, [pairingExpiresAt]);

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

  const addHistoryEntry = (action: 'sent' | 'received', fileName: string, fileSize: number) => {
    const newEntry: HistoryEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      action,
      fileName,
      fileSize,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };

    setHistory((prev) => {
      const updated = [newEntry, ...prev].slice(0, 16);
      try {
        localStorage.setItem('qrfs_history', JSON.stringify(updated));
      } catch {}
      return updated;
    });
  };

  const clearHistory = () => {
    playSound('click');
    setHistory([]);
    localStorage.removeItem('qrfs_history');
    showToast('Transfer history cleared');
  };

  const resetConnection = () => {
    closedRef.current = true;
    peakSpeedRef.current = 0;

    if (pairingPollRef.current !== null) {
      window.clearInterval(pairingPollRef.current);
      pairingPollRef.current = null;
    }
    if (countdownTimerRef.current !== null) {
      window.clearInterval(countdownTimerRef.current);
      countdownTimerRef.current = null;
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
    setIsIncomingActive(false);
    sessionStorage.removeItem('qrfs_session');
    setStatus('closed');
    setStatusMessage('Session closed. Ready to start a new transfer.');
  };

  useEffect(() => {
    return () => {
      scannerActiveRef.current = false;
      if (pairingPollRef.current !== null) window.clearInterval(pairingPollRef.current);
      if (countdownTimerRef.current !== null) window.clearInterval(countdownTimerRef.current);
      if (scannerFrameRef.current !== null) cancelAnimationFrame(scannerFrameRef.current);

      if (scannerStreamRef.current) {
        for (const track of scannerStreamRef.current.getTracks()) track.stop();
      }

      if (peerRef.current) peerRef.current.close();
      for (const url of receivedUrlsRef.current) URL.revokeObjectURL(url);
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
      playSound('connect');
      navigator.vibrate?.([20, 50, 20]);
      setStatus('connected');
      setConnectedAt(new Date().toLocaleTimeString());
      setStatusMessage('Connected directly to receiver! Pick files to beam them over.');
      showToast('⚡ Peer connected directly');
    };

    channel.onclose = () => {
      if (!closedRef.current) {
        setStatus('closed');
        setStatusMessage('The peer connection was closed.');
      }
    };

    channel.onerror = () => {
      playSound('error');
      setStatus('error');
      setStatusMessage('Data channel communication error.');
    };

    channel.onmessage = (event) => {
      if (typeof event.data !== 'string') return;
      try {
        const message = JSON.parse(event.data) as { type: string; fileId?: string };
        if (message.type === 'received' && currentShareModeRef.current === 'single') {
          setStatusMessage('Receiver confirmed the transfer. One-time session complete.');
          playSound('complete');
          setShowConfetti(true);
          resetConnection();
        }
      } catch {}
    };
  };

  const setupReceiverChannel = (channel: RTCDataChannel) => {
    channel.onopen = () => {
      playSound('connect');
      navigator.vibrate?.([20, 50, 20]);
      setStatus('connected');
      setConnectedAt(new Date().toLocaleTimeString());
      setStatusMessage('Connected directly to sender. Ready to receive files.');
      showToast('⚡ Peer connected directly');
    };

    channel.onclose = () => {
      if (!closedRef.current) {
        setStatus('closed');
        setStatusMessage('The sender closed the connection.');
      }
    };

    channel.onerror = () => {
      playSound('error');
      setStatus('error');
      setStatusMessage('Data channel error reported.');
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
            playSound('error');
            setStatus('error');
            setStatusMessage(`${message.name} is larger than the ${maxFileSizeGb} GB limit.`);
            channel.send(JSON.stringify({ type: 'close' }));
            resetConnection();
            return;
          }

          const cleanName = message.name.replace(/^\d+-/, '');
          setIsIncomingActive(true);

          let writer: FileSystemWritableFileStream | undefined;
          if (receiveDirectoryRef.current) {
            try {
              const fileHandle = await receiveDirectoryRef.current.getFileHandle(cleanName, { create: true });
              writer = await fileHandle.createWritable();
              setReceiveFolderReady(true);
            } catch {}
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
          setStatusMessage(`Receiving ${cleanName} (${formatBytes(message.size)})...`);
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
            url = URL.createObjectURL(blob);
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

          addHistoryEntry('received', incoming.name, incoming.size);
          incomingRef.current = null;
          setIsIncomingActive(false);
          playSound('complete');
          setShowConfetti(true);
          navigator.vibrate?.([30, 60, 30]);

          channel.send(JSON.stringify({ type: 'received', fileId: message.fileId }));

          if (currentShareModeRef.current === 'single') {
            setStatusMessage('Transfer completed successfully. One-time session closed.');
            resetConnection();
          } else {
            setStatusMessage(`Successfully received ${incoming.name}. Session remains open.`);
          }
          return;
        }

        if (message.type === 'transfer-cancel' && incomingRef.current && incomingRef.current.id === message.fileId) {
          if (incomingRef.current.writer) {
            await incomingRef.current.writer.abort().catch(() => {});
          }
          incomingRef.current = null;
          setIsIncomingActive(false);
          setStatusMessage('Transfer was cancelled by sender.');
          playSound('error');
          return;
        }

        if (message.type === 'close') {
          resetConnection();
        }
        return;
      }

      if (!incomingRef.current) return;

      const chunk = event.data instanceof ArrayBuffer ? new Uint8Array(event.data) : new Uint8Array(await event.data.arrayBuffer());
      if (incomingRef.current.writer) {
        await incomingRef.current.writer.write(chunk);
      } else {
        incomingRef.current.chunks.push(chunk);
      }
      incomingRef.current.receivedBytes += chunk.byteLength;
      const pct = Math.min(100, Math.round((incomingRef.current.receivedBytes / incomingRef.current.size) * 100));
      setStatusMessage(`Receiving ${incomingRef.current.name}: ${pct}%`);
    };
  };

  const prepareReceiveFolder = async () => {
    playSound('click');
    try {
      if (!window.isSecureContext) {
        setStatus('error');
        setStatusMessage('Folder selection requires HTTPS or localhost (Secure Context).');
        return;
      }

      if (!('showDirectoryPicker' in window)) {
        setStatus('error');
        setStatusMessage('This browser does not support direct disk folder selection.');
        return;
      }

      const directoryHandle = await (window as Window & {
        showDirectoryPicker: () => Promise<FileSystemDirectoryHandle>;
      }).showDirectoryPicker();

      receiveDirectoryRef.current = directoryHandle;
      setReceiveFolderReady(true);
      showToast('Disk folder ready for fast direct writes');
      setStatusMessage('Receive folder configured. Files will stream directly to disk without memory buffering.');
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        setStatusMessage('Folder selection was canceled.');
      } else {
        setStatus('error');
        setStatusMessage('Failed to access receive folder.');
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
      for (const track of scannerStreamRef.current.getTracks()) track.stop();
      scannerStreamRef.current = null;
    }
  };

  const startScanner = async () => {
    playSound('click');
    if (role !== 'receiver') setRole('receiver');

    if (!window.isSecureContext) {
      setStatus('error');
      setStatusMessage('Camera access requires HTTPS or localhost. Please use Code or Paste mode.');
      showToast('Camera requires HTTPS');
      return;
    }

    if (!scannerSupported) {
      setStatus('error');
      setStatusMessage('Camera not available on this browser. Use 6-digit code or paste.');
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

      if (!videoRef.current) throw new Error('Scanner element not ready.');

      videoRef.current.srcObject = stream;
      videoRef.current.setAttribute('playsinline', 'true');
      await videoRef.current.play();

      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('Could not initialize scanner canvas context.');

      const scanFrame = async () => {
        if (!scannerActiveRef.current || !videoRef.current) return;

        try {
          const video = videoRef.current;
          if (video.readyState === video.HAVE_ENOUGH_DATA && video.videoWidth > 0 && video.videoHeight > 0) {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            context.drawImage(video, 0, 0, canvas.width, canvas.height);
            const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
            const qrResult = jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: 'attemptBoth' });

            if (qrResult?.data) {
              playSound('connect');
              navigator.vibrate?.(50);
              const scannedCode = extractPairingCode(qrResult.data);
              if (scannedCode) {
                setPairingCode(scannedCode);
                setPairingMethod('code');
                setStatusMessage(`Code ${scannedCode} scanned! Connecting...`);
                await stopScanner();
                await joinWithPairingCode(scannedCode);
                return;
              } else {
                setPendingSignalText(qrResult.data);
                setPairingMethod('paste');
                setStatusMessage('Offer QR payload scanned! Tap Generate answer.');
                await stopScanner();
                return;
              }
            }
          }
        } catch {}

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
        setStatusMessage(error instanceof Error ? error.message : 'Could not start camera scanner.');
      }
    }
  };

  const createSenderSession = async () => {
    playSound('click');
    try {
      closedRef.current = false;
      currentShareModeRef.current = shareMode;
      setStatus('generating');
      setStatusMessage('Creating local WebRTC offer...');

      const pc = buildPeerConnection(networkMode);
      peerRef.current = pc;
      const channel = pc.createDataChannel('qr-file-share');
      channel.binaryType = 'arraybuffer';
      channelRef.current = channel;

      setupSenderChannel(channel);

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'connected') {
          playSound('connect');
          setStatus('connected');
          setConnectedAt(new Date().toLocaleTimeString());
          setStatusMessage('Peer connected! Drop or pick files below.');
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
        throw new Error('Signaling server unavailable. Start Vite dev server.');
      }

      const registration = (await registrationResponse.json()) as { code: string; expiresAt: number };
      setPairingCode(registration.code);
      setPairingExpiresAt(registration.expiresAt);

      setCodeFlipped(true);
      setTimeout(() => setCodeFlipped(false), 600);

      setStatus('waiting');
      setStatusMessage('Scan the QR code or enter the 6-digit code on the receiver device.');
      showToast('Session ready! Share code or QR');

      pairingPollRef.current = window.setInterval(async () => {
        try {
          const answerResponse = await fetch(`/api/sessions/${registration.code}/answer`);
          if (!answerResponse.ok) return;

          const result = (await answerResponse.json()) as { answer: RTCSessionDescriptionInit | null };
          if (!result.answer || !peerRef.current) return;

          if (pairingPollRef.current !== null) {
            window.clearInterval(pairingPollRef.current);
            pairingPollRef.current = null;
          }

          await peerRef.current.setRemoteDescription(result.answer);
          setStatus('connecting');
          setStatusMessage('Receiver connected! Establishing direct P2P data channel...');
        } catch {}
      }, 1000);
    } catch (error) {
      playSound('error');
      setStatus('error');
      setStatusMessage(error instanceof Error ? error.message : 'Failed to create session.');
    }
  };

  const createReceiverAnswerFromSignal = async (signal: SignalPacket, viaCode = false) => {
    if (signal.kind !== 'offer') throw new Error('Expected an offer payload.');

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
        playSound('connect');
        setStatus('connected');
        setConnectedAt(new Date().toLocaleTimeString());
        setStatusMessage('Direct P2P link established! Ready to receive files.');
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

      if (!response.ok) throw new Error('Could not publish answer to sender.');

      setStatus('connecting');
      setStatusMessage('Answer sent! Connecting directly to sender...');
      showToast('Pairing answer delivered');
    } else {
      setStatus('waiting');
      setStatusMessage('Show this answer QR to sender or copy payload.');
    }
  };

  const joinWithPairingCode = async (overrideCode?: string) => {
    playSound('click');
    try {
      const normalizedCode = (overrideCode || pairingCode).trim();
      if (!/^\d{6}$/.test(normalizedCode)) throw new Error('Enter 6-digit code shown on sender.');

      closedRef.current = false;
      setStatus('connecting');
      setStatusMessage(`Looking up session ${normalizedCode}...`);

      const response = await fetch(`/api/sessions/${normalizedCode}`);
      if (!response.ok) throw new Error('Invalid or expired pairing code.');

      const data = (await response.json()) as {
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
      playSound('error');
      setStatus('error');
      setStatusMessage(error instanceof Error ? error.message : 'Could not join with code.');
    }
  };

  const createReceiverAnswer = async () => {
    playSound('click');
    try {
      closedRef.current = false;
      if (!pendingSignalText.trim()) {
        setStatusMessage('Paste sender offer payload first.');
        return;
      }
      setStatus('connecting');
      await createReceiverAnswerFromSignal(decodeSignal(pendingSignalText));
    } catch (error) {
      playSound('error');
      setStatus('error');
      setStatusMessage(error instanceof Error ? error.message : 'Could not build answer.');
    }
  };

  const applyAnswerOnSender = async () => {
    playSound('click');
    try {
      if (!peerRef.current) throw new Error('Create sender offer first.');
      if (!pendingSignalText.trim()) throw new Error('Paste receiver answer payload.');

      const signal = decodeSignal(pendingSignalText);
      if (signal.kind !== 'answer') throw new Error('Expected an answer payload.');

      await peerRef.current.setRemoteDescription(signal.sdp);
      setStatus('connecting');
      setStatusMessage('Answer accepted! Connecting directly...');
      showToast('Answer applied successfully');
    } catch (error) {
      playSound('error');
      setStatus('error');
      setStatusMessage(error instanceof Error ? error.message : 'Could not apply answer.');
    }
  };

  const sendSelectedFiles = async () => {
    if (!channelRef.current || channelRef.current.readyState !== 'open') {
      playSound('error');
      setStatusMessage('Direct connection is not open yet. Pair devices first.');
      showToast('Peer not connected yet');
      return;
    }

    if (!pickedFiles.length) {
      playSound('error');
      setStatusMessage('Please select one or more files to send.');
      return;
    }

    try {
      playSound('send');
      transferPausedRef.current = false;
      transferCancelledRef.current = false;
      setTransferState('sending');
      peakSpeedRef.current = 0;

      const oversizedFile = pickedFiles.find((file) => file.size > maxFileSizeBytes);
      if (oversizedFile) {
        playSound('error');
        setStatus('error');
        setStatusMessage(`${oversizedFile.name} exceeds the ${maxFileSizeGb} GB limit.`);
        return;
      }

      setStatusMessage('Sending files over direct peer connection...');

      for (const file of pickedFiles) {
        const fileId = `${Date.now()}-${file.name}`;
        activeFileIdRef.current = fileId;
        const cleanName = file.name.replace(/^\d+-/, '');
        const startedAt = performance.now();
        let sentBytes = 0;
        const totalFileChunks = Math.ceil(file.size / chunkSize);

        setTransferProgress({
          fileName: cleanName,
          percent: 0,
          bytesSent: 0,
          totalBytes: file.size,
          speedMbps: 0,
          peakSpeedMbps: 0,
          etaSeconds: 0,
          chunksSent: 0,
          totalChunks: totalFileChunks,
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
        let chunkIndex = 0;

        while (offset < file.size) {
          while (transferPausedRef.current && !transferCancelledRef.current) {
            await new Promise((resolve) => window.setTimeout(resolve, 100));
          }

          if (transferCancelledRef.current) {
            channelRef.current.send(JSON.stringify({ type: 'transfer-cancel', fileId }));
            setTransferState('cancelled');
            setStatusMessage('Transfer was cancelled.');
            playSound('error');
            return;
          }

          const slice = file.slice(offset, offset + chunkSize);
          const chunkBuffer = await slice.arrayBuffer();

          channelRef.current.send(chunkBuffer);
          offset += chunkBuffer.byteLength;
          sentBytes += chunkBuffer.byteLength;
          chunkIndex++;

          const elapsedSeconds = Math.max((performance.now() - startedAt) / 1000, 0.05);
          const currentSpeedMbps = sentBytes / elapsedSeconds / (1024 * 1024);
          if (currentSpeedMbps > peakSpeedRef.current) {
            peakSpeedRef.current = currentSpeedMbps;
          }

          const speedBytesPerSec = sentBytes / elapsedSeconds;
          const remainingBytes = Math.max(0, file.size - sentBytes);
          const eta = speedBytesPerSec > 0 ? Math.ceil(remainingBytes / speedBytesPerSec) : 0;

          setTransferProgress({
            fileName: cleanName,
            percent: Math.min(100, Math.round((sentBytes / file.size) * 100)),
            bytesSent: sentBytes,
            totalBytes: file.size,
            speedMbps: currentSpeedMbps,
            peakSpeedMbps: peakSpeedRef.current,
            etaSeconds: eta,
            chunksSent: chunkIndex,
            totalChunks: totalFileChunks,
          });

          await waitForBufferedRoom(channelRef.current);
        }

        channelRef.current.send(JSON.stringify({ type: 'file-end', fileId }));
        addHistoryEntry('sent', cleanName, file.size);

        if (currentShareModeRef.current === 'single') break;
      }

      playSound('complete');
      setShowConfetti(true);
      navigator.vibrate?.([30, 60, 30]);

      if (currentShareModeRef.current === 'single') {
        setStatusMessage('One-time transfer sent! Waiting for receiver confirmation.');
      } else {
        setStatusMessage('Transfer completed! Session remains available for more files.');
      }
      setTransferState('idle');
      activeFileIdRef.current = null;
    } catch (error) {
      playSound('error');
      setTransferState('cancelled');
      setStatus('error');
      setStatusMessage(error instanceof Error ? error.message : 'Could not send selected files.');
    }
  };

  const pauseTransfer = () => {
    playSound('click');
    transferPausedRef.current = true;
    setTransferState('paused');
    setStatusMessage('Transfer paused.');
  };

  const resumeTransfer = () => {
    playSound('click');
    transferPausedRef.current = false;
    setTransferState('sending');
    setStatusMessage('Transfer resumed.');
  };

  const cancelTransfer = () => {
    playSound('click');
    transferCancelledRef.current = true;
    transferPausedRef.current = false;
    setTransferState('cancelled');
    setStatusMessage('Cancelling transfer...');
  };

  const addFilesToQueue = (newFiles: File[]) => {
    if (!newFiles.length) return;
    playSound('click');
    setPickedFiles((current) => {
      const existing = new Set(current.map((file) => `${file.name}:${file.size}`));
      return [...current, ...newFiles.filter((file) => !existing.has(`${file.name}:${file.size}`))];
    });
    showToast(`Added ${newFiles.length} file${newFiles.length > 1 ? 's' : ''}`);
  };

  const removeQueuedFile = (fileToRemove: File) => {
    playSound('click');
    setPickedFiles((current) => current.filter((file) => file !== fileToRemove));
  };

  const copyToClipboard = async (text: string, label: string) => {
    playSound('copy');
    try {
      await navigator.clipboard.writeText(text);
      setCopiedState(label);
      showToast(`Copied ${label} to clipboard`);
      setTimeout(() => setCopiedState(null), 2000);
    } catch {
      showToast('Could not copy automatically');
    }
  };

  const changeNetworkMode = (mode: NetworkMode) => {
    playSound('click');
    if (mode === networkMode) return;
    if (peerRef.current || pairingCode) resetConnection();
    setNetworkMode(mode);
    setStatus('idle');
    setStatusMessage(mode === 'offline' ? 'Offline LAN mode (Zero external servers).' : 'Online STUN-assisted mode.');
    showToast(`Switched to ${mode === 'offline' ? 'Offline LAN' : 'Online STUN'}`);
  };

  // 3D Card Tilt with Specular Glare
  const handleCardMouseMove = (e: React.MouseEvent<HTMLElement>) => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const card = e.currentTarget;
    const rect = card.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const centerX = rect.width / 2;
    const centerY = rect.height / 2;
    const rotateX = ((y - centerY) / centerY) * -2.5;
    const rotateY = ((x - centerX) / centerX) * 2.5;

    card.style.setProperty('--mouse-x', `${x}px`);
    card.style.setProperty('--mouse-y', `${y}px`);
    card.style.transform = `perspective(1000px) rotateX(${rotateX}deg) rotateY(${rotateY}deg)`;
  };

  const handleCardMouseLeave = (e: React.MouseEvent<HTMLElement>) => {
    const card = e.currentTarget;
    card.style.transform = 'perspective(1000px) rotateX(0deg) rotateY(0deg)';
  };

  const isTransferringActive = transferState === 'sending' || isIncomingActive;

  return (
    <div className={`app-root theme-${theme}`}>
      {/* Dynamic 60fps Constellation Background */}
      <RunningBackground isTransferring={isTransferringActive} theme={theme} />

      {/* Confetti Particle Explosion */}
      <Confetti active={showConfetti} onComplete={() => setShowConfetti(false)} />

      {/* Main Glass Shell */}
      <div className="glass-shell">
        {/* Top Navigation Bar */}
        <header className="site-header">
          <div className="brand-group">
            <div className="brand-logo" aria-hidden="true">
              <span className="logo-beam" />
              <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="7" height="7" rx="1.5" />
                <rect x="14" y="3" width="7" height="7" rx="1.5" />
                <rect x="14" y="14" width="7" height="7" rx="1.5" />
                <path d="M7 17v4M10 17v4M4 17h6M17 10h4M17 7h4" />
              </svg>
            </div>
            <div>
              <div className="brand-title">
                <h1 style={{ fontSize: '1.6rem', background: 'linear-gradient(135deg, var(--neon-violet), var(--neon-cyan))', WebkitBackgroundClip: 'text', color: 'transparent' }}>QuickShare</h1>
                <span className="brand-pill">v2.0 ORBITAL</span>
              </div>
              <p className="brand-tagline">Encrypted peer-to-peer file transfer engine</p>
            </div>
          </div>

          <div className="header-actions">
            {/* 5-bar live signal meter */}
            <div className="signal-bars-badge" title="WebRTC Direct Stream Quality">
              <span className="bar active" />
              <span className="bar active" />
              <span className="bar active" />
              <span className={`bar ${status === 'connected' ? 'active' : ''}`} />
              <span className={`bar ${status === 'connected' ? 'active' : ''}`} />
              <span className="signal-label">{status === 'connected' ? 'DIRECT 1Gbps' : 'LAN READY'}</span>
            </div>

            {/* Network mode badge */}
            <div className={`status-pill pill-${networkMode}`} title={networkMode === 'offline' ? 'Strictly offline local network' : 'Using STUN servers'}>
              <span className="pill-dot" />
              <span>{networkMode === 'offline' ? 'Offline LAN' : 'Online STUN'}</span>
            </div>

            {/* Mute button */}
            <button
              className={`icon-button ${muted ? 'is-muted' : ''}`}
              onClick={toggleMute}
              title={muted ? 'Unmute sounds' : 'Mute sounds'}
              aria-label={muted ? 'Unmute sounds' : 'Mute sounds'}
              type="button"
            >
              {muted ? (
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M11 5L6 9H2v6h4l5 4V5zM23 9l-6 6M17 9l6 6" />
                </svg>
              ) : (
                <div className="sound-active-wave">
                  <span className="wave-bar" />
                  <span className="wave-bar" />
                  <span className="wave-bar" />
                </div>
              )}
            </button>

            {/* Theme button */}
            <button
              className="icon-button"
              onClick={toggleTheme}
              title={`Switch theme (Current: ${theme.toUpperCase()})`}
              aria-label={`Switch theme (Current: ${theme.toUpperCase()})`}
              type="button"
            >
              {theme === 'dark' ? (
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                </svg>
              ) : theme === 'light' ? (
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="5" />
                  <line x1="12" y1="1" x2="12" y2="3" />
                  <line x1="12" y1="21" x2="12" y2="23" />
                  <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
                  <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
                  <line x1="1" y1="12" x2="3" y2="12" />
                  <line x1="21" y1="12" x2="23" y2="12" />
                  <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
                  <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="9" />
                  <path d="M12 3v18" />
                </svg>
              )}
            </button>
          </div>
        </header>

        {/* Global Connection Ribbon */}
        <section className={`status-banner status-${status}`}>
          <div className="status-indicator">
            <span className="pulse-ring" />
            <span className="status-core" />
          </div>
          <div className="status-content">
            <div className="status-header-line">
              <strong className="status-label">{status.toUpperCase()}</strong>
              {sessionId && <span className="session-tag">CHANNEL: {sessionId}</span>}
              {connectedAt && <span className="connected-tag">ESTABLISHED AT {connectedAt}</span>}
            </div>
            <p className="status-desc">{statusMessage}</p>
          </div>
          {status === 'connected' && (
            <button className="disconnect-btn" onClick={resetConnection} type="button">
              Disconnect
            </button>
          )}
        </section>

        {/* Cockpit Grid */}
        <main className="dashboard-grid">
          {/* LEFT: Primary Action Center */}
          <section
            className="panel-card main-cockpit"
            onMouseMove={handleCardMouseMove}
            onMouseLeave={handleCardMouseLeave}
          >
            <div className="card-glare" />

            {/* Segmented Mode Switcher */}
            <div className="segmented-tabs" role="tablist">
              <button
                className={`tab-btn ${role === 'sender' ? 'active' : ''}`}
                onClick={() => {
                  playSound('click');
                  setRole('sender');
                }}
                role="tab"
                aria-selected={role === 'sender'}
                type="button"
              >
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="22" y1="2" x2="11" y2="13" />
                  <polygon points="22 2 15 22 11 13 2 9 22 2" />
                </svg>
                <span>Send Files</span>
              </button>
              <button
                className={`tab-btn ${role === 'receiver' ? 'active' : ''}`}
                onClick={() => {
                  playSound('click');
                  setRole('receiver');
                }}
                role="tab"
                aria-selected={role === 'receiver'}
                type="button"
              >
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
                <span>Receive Files</span>
              </button>
            </div>

            {/* Session Settings Options */}
            <div className="options-strip">
              <div className="pill-group" aria-label="Transfer session type">
                <button
                  className={`pill-option ${shareMode === 'single' ? 'selected' : ''}`}
                  onClick={() => {
                    playSound('click');
                    setShareMode('single');
                  }}
                  type="button"
                >
                  One-time
                </button>
                <button
                  className={`pill-option ${shareMode === 'reusable' ? 'selected' : ''}`}
                  onClick={() => {
                    playSound('click');
                    setShareMode('reusable');
                  }}
                  type="button"
                >
                  Multi-transfer
                </button>
              </div>

              <div className="pill-group" aria-label="Network routing">
                <button
                  className={`pill-option ${networkMode === 'offline' ? 'selected' : ''}`}
                  onClick={() => changeNetworkMode('offline')}
                  type="button"
                >
                  Local LAN
                </button>
                <button
                  className={`pill-option ${networkMode === 'online' ? 'selected' : ''}`}
                  onClick={() => changeNetworkMode('online')}
                  type="button"
                >
                  Online STUN
                </button>
              </div>
            </div>

            {/* SENDER VIEW */}
            {role === 'sender' && (
              <div className="view-container animate-fade">
                {!pairingCode ? (
                  <div className="start-pairing-box">
                    <div className="pairing-callout">
                      <h3>Instant Pairing Engine</h3>
                      <p>Generate a private WebRTC offer with zero cloud storage. Other devices on your Wi-Fi can scan or enter the 6-digit code.</p>
                    </div>
                    <button className="glow-cta-btn" onClick={createSenderSession} type="button">
                      <span className="btn-shimmer" />
                      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="3" y="3" width="18" height="18" rx="2" />
                        <rect x="7" y="7" width="3" height="3" />
                        <rect x="14" y="7" width="3" height="3" />
                        <rect x="7" y="14" width="3" height="3" />
                      </svg>
                      <span>Create QR &amp; Code Session</span>
                    </button>
                  </div>
                ) : (
                  <div className="active-pairing-box plasma-card">
                    <div className="qr-and-code-layout">
                      {/* Holographic QR with Zoom trigger */}
                      <div className="qr-capsule group" onClick={() => setQrModalOpen(true)} title="Click to expand QR code">
                        <div className="qr-laser-line" />
                        <div className="qr-corner-bracket corner-tl" />
                        <div className="qr-corner-bracket corner-tr" />
                        <div className="qr-corner-bracket corner-bl" />
                        <div className="qr-corner-bracket corner-br" />
                        <div className="qr-svg-holder" dangerouslySetInnerHTML={{ __html: qrMarkup }} />
                        <div className="qr-zoom-hint">Click to Zoom</div>
                      </div>

                      {/* Code and Controls */}
                      <div className="pairing-meta-column">
                        <span className="section-eyebrow">PAIRING PIN CODE</span>

                        {/* 6-Digit 3D Cyber Capsules */}
                        <div className={`pin-capsule-row ${codeFlipped ? 'flip-animation' : ''}`}>
                          {pairingCode.split('').map((digit, idx) => (
                            <span key={idx} className={`pin-digit-box digit-slot ${codeFlipped ? 'flip-animation' : ''}`}>
                              {digit}
                            </span>
                          ))}
                        </div>

                        <div className="code-timer-row">
                          {codeCountdown && (
                            <span className="timer-badge">
                              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.2">
                                <circle cx="12" cy="12" r="10" />
                                <polyline points="12 6 12 12 16 14" />
                              </svg>
                              <span>Expires in {codeCountdown}</span>
                            </span>
                          )}
                          <button
                            className="secondary-btn compact"
                            onClick={() => copyToClipboard(pairingCode, 'Pairing code')}
                            type="button"
                          >
                            {copiedState === 'Pairing code' ? '✓ Copied' : 'Copy Code'}
                          </button>
                        </div>

                        <div className="quick-actions-row">
                          <button
                            className="secondary-btn compact"
                            onClick={() => copyToClipboard(createPairingUrl(pairingCode), 'Direct pairing link')}
                            type="button"
                          >
                            Copy Link
                          </button>
                          <button className="ghost-btn compact danger-text" onClick={resetConnection} type="button">
                            Close Session
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* File Dropzone */}
                <div className="file-selection-area">
                  <div className="section-title-row">
                    <h4>Files to Beam</h4>
                    {pickedFiles.length > 0 && (
                      <span className="queue-count">
                        {pickedFiles.length} file{pickedFiles.length > 1 ? 's' : ''} ({formatBytes(pickedFiles.reduce((acc, f) => acc + f.size, 0))})
                      </span>
                    )}
                  </div>

                  <div
                    className={`interactive-dropzone ${isDragging ? 'is-dragged-over' : ''}`}
                    onClick={() => fileInputRef.current?.click()}
                    onDragEnter={(e) => {
                      e.preventDefault();
                      setIsDragging(true);
                    }}
                    onDragOver={(e) => e.preventDefault()}
                    onDragLeave={() => setIsDragging(false)}
                    onDrop={(e) => {
                      e.preventDefault();
                      setIsDragging(false);
                      addFilesToQueue(Array.from(e.dataTransfer.files));
                    }}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click();
                    }}
                  >
                    <div className="dropzone-ambient-glow" />
                    <div className="dropzone-icon-shell">
                      <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                        <polyline points="17 8 12 3 7 8" />
                        <line x1="12" y1="3" x2="12" y2="15" />
                      </svg>
                    </div>
                    <div className="dropzone-text">
                      <strong>{isDragging ? 'Release files to beam them!' : 'Drop files here or click to browse'}</strong>
                      <span className="dropzone-sub">Direct device-to-device streaming · Up to {maxFileSizeGb} GB per file</span>
                    </div>
                    <input
                      ref={fileInputRef}
                      type="file"
                      multiple
                      hidden
                      onChange={(e) => {
                        addFilesToQueue(Array.from(e.target.files ?? []));
                        e.target.value = '';
                      }}
                    />
                  </div>

                  {/* Queued Files List with Category Tags */}
                  {pickedFiles.length > 0 && (
                    <div className="queued-files-list">
                      {pickedFiles.map((file) => {
                        const cleanName = file.name.replace(/^\d+-/, '');
                        const cat = getFileCategory(file.type, file.name);
                        return (
                          <div className="file-chip" key={`${file.name}-${file.size}`}>
                            <span className="file-icon" aria-hidden="true">
                              {cat.icon}
                            </span>
                            <div className="file-details">
                              <div className="flex items-center gap-2">
                                <span className="file-name" title={cleanName}>
                                  {cleanName}
                                </span>
                                <span className={`file-cat-badge ${cat.color}`}>{cat.label}</span>
                              </div>
                              <span className="file-size">{formatBytes(file.size)}</span>
                            </div>
                            <button
                              className="remove-btn"
                              onClick={() => removeQueuedFile(file)}
                              title={`Remove ${cleanName}`}
                              aria-label={`Remove ${cleanName}`}
                              type="button"
                            >
                              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                <line x1="18" y1="6" x2="6" y2="18" />
                                <line x1="6" y1="6" x2="18" y2="18" />
                              </svg>
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* Main Action Bar */}
                  <div className="transfer-action-bar">
                    <button
                      className={`glow-cta-btn ${transferState === 'sending' ? 'morphing' : ''}`}
                      onClick={sendSelectedFiles}
                      disabled={status !== 'connected' || pickedFiles.length === 0 || transferState === 'sending'}
                      type="button"
                    >
                      <span className="btn-shimmer" />
                      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="22" y1="2" x2="11" y2="13" />
                        <polygon points="22 2 15 22 11 13 2 9 22 2" />
                      </svg>
                      <span>
                        {status !== 'connected'
                          ? 'Pair Receiver to Start Beam'
                          : transferState === 'sending'
                          ? 'Streaming Files...'
                          : `Beam ${pickedFiles.length} Selected File${pickedFiles.length > 1 ? 's' : ''}`}
                      </span>
                    </button>

                    {pickedFiles.length > 0 && (
                      <button className="secondary-btn" onClick={() => setPickedFiles([])} type="button">
                        Clear
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* RECEIVER VIEW */}
            {role === 'receiver' && (
              <div className="view-container animate-fade">
                {/* Method selector subtabs */}
                <div className="subtabs-bar">
                  <button
                    className={`subtab-btn ${pairingMethod === 'code' ? 'active' : ''}`}
                    onClick={() => {
                      playSound('click');
                      setPairingMethod('code');
                    }}
                    type="button"
                  >
                    6-Digit Code
                  </button>
                  <button
                    className={`subtab-btn ${pairingMethod === 'qr' ? 'active' : ''}`}
                    onClick={() => {
                      playSound('click');
                      setPairingMethod('qr');
                    }}
                    type="button"
                  >
                    Camera Scanner
                  </button>
                  <button
                    className={`subtab-btn ${pairingMethod === 'paste' ? 'active' : ''}`}
                    onClick={() => {
                      playSound('click');
                      setPairingMethod('paste');
                    }}
                    type="button"
                  >
                    Manual Paste
                  </button>
                </div>

                {pairingMethod === 'code' && (
                  <div className="method-pane animate-fade">
                    <div className="input-card">
                      <label htmlFor="code-input" className="section-eyebrow">
                        PAIRING PIN CODE
                      </label>
                      <div className="code-input-wrapper">
                        <input
                          id="code-input"
                          className="pin-big-input"
                          inputMode="numeric"
                          maxLength={6}
                          pattern="[0-9]*"
                          value={pairingCode}
                          onChange={(e) => setPairingCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                          placeholder="000000"
                        />
                      </div>
                      <p className="field-hint">Enter the 6-digit PIN displayed on the sender screen</p>
                      <button
                        className="glow-cta-btn full-width"
                        onClick={() => joinWithPairingCode()}
                        disabled={pairingCode.length !== 6 || status === 'connecting'}
                        type="button"
                      >
                        <span className="btn-shimmer" />
                        <span>{status === 'connecting' ? 'Connecting to Sender...' : 'Connect With Code'}</span>
                      </button>
                    </div>
                  </div>
                )}

                {pairingMethod === 'qr' && (
                  <div className="method-pane animate-fade">
                    <div className={`camera-hud-shell ${scannerActive ? 'active' : ''}`}>
                      <video ref={videoRef} className="camera-video" playsInline muted autoPlay />

                      {scannerActive ? (
                        <div className="hud-overlay" aria-hidden="true">
                          <div className="hud-sweep-beam" />
                          <div className="hud-reticle" />
                          <div className="hud-bracket corner-tl" />
                          <div className="hud-bracket corner-tr" />
                          <div className="hud-bracket corner-bl" />
                          <div className="hud-bracket corner-br" />
                          <span className="hud-instruction">Align camera with sender QR code</span>
                        </div>
                      ) : (
                        <div className="hud-placeholder">
                          <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" strokeWidth="1.5">
                            <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                            <circle cx="12" cy="13" r="4" />
                          </svg>
                          <p>Camera scanner is ready</p>
                          <small>Point at sender screen for instant one-touch connection</small>
                        </div>
                      )}
                    </div>

                    <div className="camera-controls">
                      {!scannerActive ? (
                        <button className="glow-cta-btn full-width" onClick={startScanner} type="button">
                          <span className="btn-shimmer" />
                          <span>Start Camera Scanner</span>
                        </button>
                      ) : (
                        <button className="secondary-btn full-width" onClick={stopScanner} type="button">
                          Stop Camera
                        </button>
                      )}
                    </div>
                  </div>
                )}

                {pairingMethod === 'paste' && (
                  <div className="method-pane animate-fade">
                    <div className="input-card">
                      <label className="section-eyebrow">OFFER SIGNAL PAYLOAD</label>
                      <textarea
                        className="cyber-textarea"
                        rows={4}
                        value={pendingSignalText}
                        onChange={(e) => setPendingSignalText(e.target.value)}
                        placeholder="Paste the QRFS1 offer string from the sender..."
                      />
                      <button className="glow-cta-btn full-width" onClick={createReceiverAnswer} type="button">
                        <span className="btn-shimmer" />
                        <span>Generate Answer Payload</span>
                      </button>

                      {answerText && (
                        <div className="answer-result-box">
                          <div className="qr-capsule small">
                            <div className="qr-svg-holder" dangerouslySetInnerHTML={{ __html: qrMarkup }} />
                          </div>
                          <button className="secondary-btn" onClick={() => copyToClipboard(answerText, 'Answer payload')} type="button">
                            Copy Answer Payload
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Storage Destination */}
                <div className="receive-storage-panel">
                  <div className="storage-info">
                    <span className="section-eyebrow">LOCAL DIRECTORY DESTINATION</span>
                    <p>{receiveFolderReady ? 'Files are streaming directly into your selected folder.' : 'Buffer to browser memory (Default) or select direct folder.'}</p>
                  </div>
                  <button className="secondary-btn compact" onClick={prepareReceiveFolder} type="button">
                    {receiveFolderReady ? '✓ Folder Ready' : 'Select Local Folder'}
                  </button>
                </div>
              </div>
            )}
          </section>

          {/* RIGHT: Real-Time Telemetry Monitor */}
          <aside
            className="panel-card side-monitor"
            onMouseMove={handleCardMouseMove}
            onMouseLeave={handleCardMouseLeave}
          >
            <div className="card-glare" />

            {/* Live Progress HUD */}
            <div className="monitor-section">
              <div className="section-title-row">
                <h3>Live Telemetry HUD</h3>
                <span className={`status-badge-inline ${isTransferringActive ? 'pulsing' : ''}`}>
                  {transferState === 'sending'
                    ? 'STREAMING 256KB'
                    : isIncomingActive
                    ? 'RECEIVING'
                    : status === 'connected'
                    ? 'PEER LOCKED'
                    : 'STANDBY'}
                </span>
              </div>

              {transferProgress ? (
                <div className="active-progress-card animate-fade">
                  {/* Circular Radial Gauge */}
                  <div className="gauge-container">
                    <div className="radial-meter" style={{ '--progress-deg': `${transferProgress.percent * 3.6}deg` } as React.CSSProperties}>
                      <div className="radial-inner">
                        <span className="meter-value">{transferProgress.percent}%</span>
                        <span className="meter-unit">CHUNK PIPELINE</span>
                      </div>
                    </div>
                  </div>

                  <div className="progress-details">
                    <strong className="active-file-title" title={transferProgress.fileName}>
                      {transferProgress.fileName}
                    </strong>

                    {/* Metrics Grid */}
                    <div className="metrics-grid">
                      <div className="metric-box">
                        <span className="metric-label">SPEED</span>
                        <span className="metric-val">{transferProgress.speedMbps.toFixed(1)} MB/s</span>
                      </div>
                      <div className="metric-box">
                        <span className="metric-label">PEAK</span>
                        <span className="metric-val">{transferProgress.peakSpeedMbps.toFixed(1)} MB/s</span>
                      </div>
                      <div className="metric-box">
                        <span className="metric-label">ETA</span>
                        <span className="metric-val">
                          {transferProgress.etaSeconds > 0 ? `${transferProgress.etaSeconds}s` : 'Done'}
                        </span>
                      </div>
                    </div>

                    {/* Throughput Canvas Waveform */}
                    <div className="spectrum-container">
                      <span className="spectrum-title">BANDWIDTH THROUGHPUT</span>
                      <canvas ref={throughputCanvasRef} width={280} height={28} className="spectrum-canvas" />
                    </div>

                    <div className="linear-progress-bar">
                      <div className="progress-fill liquid-fill" style={{ width: `${transferProgress.percent}%` }}>
                        <span className="fill-glow" />
                      </div>
                    </div>

                    <div className="chunk-counter-line">
                      <span>Streamed: {formatBytes(transferProgress.bytesSent)} of {formatBytes(transferProgress.totalBytes)}</span>
                      <span>Chunk {transferProgress.chunksSent} / {transferProgress.totalChunks}</span>
                    </div>

                    {/* Controls */}
                    <div className="transfer-controls-row">
                      {transferState === 'sending' ? (
                        <button className="secondary-btn compact" onClick={pauseTransfer} type="button">
                          Pause
                        </button>
                      ) : transferState === 'paused' ? (
                        <button className="secondary-btn compact" onClick={resumeTransfer} type="button">
                          Resume
                        </button>
                      ) : null}

                      {(transferState === 'sending' || transferState === 'paused') && (
                        <button className="ghost-btn compact danger-text" onClick={cancelTransfer} type="button">
                          Cancel
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="idle-monitor-state">
                  <div className="radar-circle-anim" aria-hidden="true">
                    <div className="radar-sweep" />
                    <div className="radar-node node-1" />
                    <div className="radar-node node-2" />
                    <div className="radar-node node-3" />
                  </div>
                  <p>Telemetry Standby</p>
                  <small>Live bandwidth spectrum, chunk pipeline, and speed metrics illuminate during active beams.</small>
                </div>
              )}
            </div>

            {/* Received Files */}
            <div className="monitor-section">
              <div className="section-title-row">
                <h3>Received Files</h3>
                <span className="count-pill">{receivedFiles.length}</span>
              </div>

              {receivedFiles.length > 0 ? (
                <div className="received-files-scroll">
                  {receivedFiles.map((rf, idx) => {
                    const cat = getFileCategory(rf.type, rf.name);
                    return (
                      <div className={`received-card rf-accent-${cat.label.toLowerCase()}`} key={`${rf.name}-${idx}`}>
                        <div className="rf-icon" aria-hidden="true">
                          {cat.icon}
                        </div>
                        <div className="rf-info">
                          <strong className="rf-name" title={rf.name}>
                            {rf.name}
                          </strong>
                          <span className="rf-meta">
                            {formatBytes(rf.size)} · {rf.receivedAt}
                          </span>
                        </div>
                        <div className="rf-action">
                          {rf.savedToDisk ? (
                            <span className="disk-badge">Saved to Disk</span>
                          ) : (
                            <a className="download-btn-pill" href={rf.url} download={rf.name} title="Download file">
                              Download
                            </a>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="empty-substate">
                  <p>Files beamed by peers will appear here ready to save.</p>
                </div>
              )}
            </div>

            {/* Transfer History */}
            <div className="monitor-section">
              <div className="section-title-row">
                <h3>Transfer History</h3>
                {history.length > 0 && (
                  <button className="text-link-btn" onClick={clearHistory} type="button">
                    Clear
                  </button>
                )}
              </div>

              {history.length > 0 ? (
                <div className="history-entries-list">
                  {history.map((item) => (
                    <div className="history-entry-row" key={item.id} data-action={item.action}>
                      <span className={`entry-badge badge-${item.action}`}>
                        {item.action === 'sent' ? '↑ BEAMED' : '↓ RECEIVED'}
                      </span>
                      <span className="entry-name" title={item.fileName}>
                        {item.fileName}
                      </span>
                      <span className="entry-time">{item.timestamp}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="empty-substate">
                  <p>Session transfers are recorded in local device storage.</p>
                </div>
              )}
            </div>
          </aside>
        </main>
      </div>

      {/* QR Zoom Modal */}
      {qrModalOpen && (
        <div className="modal-backdrop animate-fade" onClick={() => setQrModalOpen(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Scan Direct QR</h3>
              <button className="icon-close" onClick={() => setQrModalOpen(false)}>✕</button>
            </div>
            <div className="modal-qr-holder" dangerouslySetInnerHTML={{ __html: qrMarkup }} />
            <div className="modal-footer">
              <span className="digit-slot" style={{ width: 'auto', padding: '0 15px', height: '44px', fontSize: '1.4rem' }}>{pairingCode}</span>
              <button className="secondary-btn compact" onClick={() => copyToClipboard(createPairingUrl(pairingCode), 'Pairing link')}>
                Copy Link
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Floating Modern Toast */}
      {toastMessage && (
        <div className="floating-toast animate-slide-up" role="status" aria-live="polite">
          <span className="toast-dot" />
          <span>{toastMessage}</span>
        </div>
      )}
    </div>
  );
}