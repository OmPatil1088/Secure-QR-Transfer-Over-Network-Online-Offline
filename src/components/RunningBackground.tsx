import React, { useEffect, useRef } from 'react';

interface RunningBackgroundProps {
  isTransferring?: boolean;
  theme?: 'dark' | 'light' | 'midnight';
}

interface NodeParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  baseVx: number;
  baseVy: number;
  radius: number;
  color: string;
  glowColor: string;
  phase: number;
  pulseSpeed: number;
  layer: number; // 0: background dust, 1: foreground node
}

interface DataPacket {
  fromIndex: number;
  toIndex: number;
  progress: number;
  speed: number;
  color: string;
  size: number;
}

interface MouseRipple {
  x: number;
  y: number;
  radius: number;
  maxRadius: number;
  alpha: number;
}

export const RunningBackground: React.FC<RunningBackgroundProps> = ({
  isTransferring = false,
  theme = 'dark',
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const mouseRef = useRef<{ x: number; y: number; active: boolean; targetX: number; targetY: number }>({
    x: -1000,
    y: -1000,
    active: false,
    targetX: -1000,
    targetY: -1000,
  });
  const isTransferringRef = useRef(isTransferring);
  const themeRef = useRef(theme);
  const ripplesRef = useRef<MouseRipple[]>([]);

  useEffect(() => {
    isTransferringRef.current = isTransferring;
  }, [isTransferring]);

  useEffect(() => {
    themeRef.current = theme;
  }, [theme]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return;

    let animationFrameId: number;
    let width = 0;
    let height = 0;

    const handleResize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      ctx.scale(dpr, dpr);
    };

    handleResize();
    window.addEventListener('resize', handleResize);

    const handleMouseMove = (e: MouseEvent) => {
      mouseRef.current.targetX = e.clientX;
      mouseRef.current.targetY = e.clientY;
      mouseRef.current.active = true;

      // Occasionally spawn soft shockwave ripple on fast move
      if (Math.random() < 0.08 && ripplesRef.current.length < 5) {
        ripplesRef.current.push({
          x: e.clientX,
          y: e.clientY,
          radius: 10,
          maxRadius: 160,
          alpha: 0.28,
        });
      }
    };

    const handleMouseLeave = () => {
      mouseRef.current.active = false;
      mouseRef.current.targetX = -1000;
      mouseRef.current.targetY = -1000;
    };

    const handleTouchMove = (e: TouchEvent) => {
      if (e.touches.length > 0) {
        mouseRef.current.targetX = e.touches[0].clientX;
        mouseRef.current.targetY = e.touches[0].clientY;
        mouseRef.current.active = true;
      }
    };

    window.addEventListener('mousemove', handleMouseMove, { passive: true });
    window.addEventListener('mouseleave', handleMouseLeave);
    window.addEventListener('touchmove', handleTouchMove, { passive: true });
    window.addEventListener('touchend', handleMouseLeave);

    const getColors = () => {
      const curTheme = themeRef.current;
      if (curTheme === 'light') {
        return {
          nodes: ['rgba(2, 132, 199, 0.85)', 'rgba(79, 70, 229, 0.85)', 'rgba(5, 150, 105, 0.8)'],
          glows: ['rgba(2, 132, 199, 0.25)', 'rgba(79, 70, 229, 0.25)', 'rgba(5, 150, 105, 0.2)'],
          dust: 'rgba(100, 116, 139, 0.35)',
          lineColor: '79, 70, 229',
          packetColor: '#0284c7',
          rippleColor: 'rgba(2, 132, 199, ',
        };
      }
      return {
        nodes: ['rgba(123, 231, 202, 0.95)', 'rgba(130, 167, 255, 0.95)', 'rgba(192, 132, 252, 0.9)'],
        glows: ['rgba(123, 231, 202, 0.4)', 'rgba(130, 167, 255, 0.4)', 'rgba(192, 132, 252, 0.35)'],
        dust: 'rgba(130, 167, 255, 0.25)',
        lineColor: '123, 231, 202',
        packetColor: '#7be7ca',
        rippleColor: 'rgba(123, 231, 202, ',
      };
    };

    const colors = getColors();

    // Create particles (nodes + background cosmic dust)
    const nodeCount = Math.min(60, Math.floor((width * height) / 22000) + 26);
    const dustCount = Math.min(45, Math.floor((width * height) / 32000) + 15);
    const particles: NodeParticle[] = [];

    // Foreground P2P Nodes
    for (let i = 0; i < nodeCount; i++) {
      const colorIdx = i % colors.nodes.length;
      const angle = Math.random() * Math.PI * 2;
      const speed = 0.3 + Math.random() * 0.45;
      particles.push({
        x: Math.random() * width,
        y: Math.random() * height,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        baseVx: Math.cos(angle) * speed,
        baseVy: Math.sin(angle) * speed,
        radius: 1.8 + Math.random() * 2.2,
        color: colors.nodes[colorIdx],
        glowColor: colors.glows[colorIdx],
        phase: Math.random() * Math.PI * 2,
        pulseSpeed: 1.5 + Math.random() * 2,
        layer: 1,
      });
    }

    // Background Micro Dust (Parallax Depth)
    for (let i = 0; i < dustCount; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 0.1 + Math.random() * 0.2;
      particles.push({
        x: Math.random() * width,
        y: Math.random() * height,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        baseVx: Math.cos(angle) * speed,
        baseVy: Math.sin(angle) * speed,
        radius: 0.8 + Math.random() * 1.2,
        color: colors.dust,
        glowColor: 'transparent',
        phase: Math.random() * Math.PI * 2,
        pulseSpeed: 0.8,
        layer: 0,
      });
    }

    const packets: DataPacket[] = [];
    const maxPackets = 18;
    let lastTime = performance.now();

    const render = (time: number) => {
      const dt = Math.min((time - lastTime) / 1000, 0.1);
      lastTime = time;

      ctx.clearRect(0, 0, width, height);

      const transferring = isTransferringRef.current;
      const speedMultiplier = transferring ? 2.4 : 1.0;
      const curColors = getColors();
      const connectionThreshold = width < 768 ? 100 : 145;

      // Smooth mouse easing
      const m = mouseRef.current;
      m.x += (m.targetX - m.x) * 0.18;
      m.y += (m.targetY - m.y) * 0.18;

      // 1. Draw ripples
      const ripples = ripplesRef.current;
      for (let i = ripples.length - 1; i >= 0; i--) {
        const rip = ripples[i];
        rip.radius += 2.5;
        rip.alpha *= 0.96;

        ctx.beginPath();
        ctx.arc(rip.x, rip.y, rip.radius, 0, Math.PI * 2);
        ctx.strokeStyle = `${curColors.rippleColor}${Math.max(0, rip.alpha)})`;
        ctx.lineWidth = 1.5;
        ctx.stroke();

        if (rip.alpha <= 0.01 || rip.radius >= rip.maxRadius) {
          ripples.splice(i, 1);
        }
      }

      // 2. Update and draw particles
      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];
        p.phase += dt * p.pulseSpeed * (transferring ? 2.2 : 1.0);

        // Movement
        p.x += p.vx * speedMultiplier;
        p.y += p.vy * speedMultiplier;

        // Boundary wrap
        const pad = 30;
        if (p.x < -pad) p.x = width + pad;
        if (p.x > width + pad) p.x = -pad;
        if (p.y < -pad) p.y = height + pad;
        if (p.y > height + pad) p.y = -pad;

        // Interactive mouse magnetic field
        if (m.active && p.layer === 1) {
          const dx = m.x - p.x;
          const dy = m.y - p.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          const influenceRadius = 160;

          if (dist < influenceRadius && dist > 1) {
            const pullForce = (1 - dist / influenceRadius) * 0.9;
            p.vx -= (dx / dist) * pullForce * 0.18;
            p.vy -= (dy / dist) * pullForce * 0.18;
          }
        }

        // Base velocity restore
        p.vx += (p.baseVx - p.vx) * 0.03;
        p.vy += (p.baseVy - p.vy) * 0.03;

        // Render node
        const pulse = 1 + Math.sin(p.phase) * (p.layer === 1 ? 0.3 : 0.15);
        const r = p.radius * pulse;

        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fillStyle = p.color;
        ctx.fill();

        // Node outer glow aura (foreground only)
        if (p.layer === 1) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, r * 2.8, 0, Math.PI * 2);
          ctx.fillStyle = p.glowColor;
          ctx.fill();
        }
      }

      // 3. Connect foreground nodes
      for (let i = 0; i < nodeCount; i++) {
        const p1 = particles[i];
        for (let j = i + 1; j < nodeCount; j++) {
          const p2 = particles[j];
          const dx = p2.x - p1.x;
          const dy = p2.y - p1.y;
          const dist = Math.sqrt(dx * dx + dy * dy);

          if (dist < connectionThreshold) {
            const normalizedDist = 1 - dist / connectionThreshold;
            const alpha = normalizedDist * (transferring ? 0.42 : 0.22);

            ctx.beginPath();
            ctx.moveTo(p1.x, p1.y);
            ctx.lineTo(p2.x, p2.y);
            ctx.strokeStyle = `rgba(${curColors.lineColor}, ${alpha})`;
            ctx.lineWidth = transferring ? 1.4 : 0.9;
            ctx.stroke();

            // Spawn data packet along this link
            const spawnChance = transferring ? 0.025 : 0.003;
            if (packets.length < maxPackets && Math.random() < spawnChance) {
              packets.push({
                fromIndex: i,
                toIndex: j,
                progress: 0,
                speed: 1.8 + Math.random() * 2.2,
                color: curColors.packetColor,
                size: 3 + Math.random() * 1.5,
              });
            }
          }
        }
      }

      // 4. Update and draw Traveling Data Packets
      for (let i = packets.length - 1; i >= 0; i--) {
        const pkt = packets[i];
        pkt.progress += dt * pkt.speed;

        if (pkt.progress >= 1) {
          packets.splice(i, 1);
          continue;
        }

        const pFrom = particles[pkt.fromIndex];
        const pTo = particles[pkt.toIndex];
        if (!pFrom || !pTo) {
          packets.splice(i, 1);
          continue;
        }

        const px = pFrom.x + (pTo.x - pFrom.x) * pkt.progress;
        const py = pFrom.y + (pTo.y - pFrom.y) * pkt.progress;

        // Bright luminous packet photon
        ctx.beginPath();
        ctx.arc(px, py, pkt.size, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.shadowColor = pkt.color;
        ctx.shadowBlur = 12;
        ctx.fill();

        // Trailing glow
        ctx.beginPath();
        ctx.arc(px, py, pkt.size * 2, 0, Math.PI * 2);
        ctx.fillStyle = pkt.color;
        ctx.fill();

        ctx.shadowBlur = 0;
      }

      // 5. Cursor Energy Aura HUD
      if (m.active && m.x > 0 && m.y > 0) {
        // Center crosshair
        ctx.beginPath();
        ctx.arc(m.x, m.y, 32, 0, Math.PI * 2);
        ctx.strokeStyle = transferring ? 'rgba(123, 231, 202, 0.4)' : 'rgba(130, 167, 255, 0.25)';
        ctx.lineWidth = 1;
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(m.x, m.y, 48, 0, Math.PI * 2);
        ctx.strokeStyle = transferring ? 'rgba(123, 231, 202, 0.2)' : 'rgba(130, 167, 255, 0.12)';
        ctx.setLineDash([6, 8]);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      animationFrameId = requestAnimationFrame(render);
    };

    animationFrameId = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(animationFrameId);
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseleave', handleMouseLeave);
      window.removeEventListener('touchmove', handleTouchMove);
      window.removeEventListener('touchend', handleMouseLeave);
    };
  }, []);

  return (
    <div className={`dynamic-running-bg theme-${theme} ${isTransferring ? 'is-active-transfer' : ''}`} aria-hidden="true">
      {/* 4 Multi-Axis Floating Aurora Orbs */}
      <div className="aurora-orb aurora-orb-1" />
      <div className="aurora-orb aurora-orb-2" />
      <div className="aurora-orb aurora-orb-3" />
      <div className="aurora-orb aurora-orb-4" />

      {/* Cyber Grid with Radial Spotlight Mask */}
      <div className="cyber-grid-overlay" />

      {/* High-speed Particle Canvas */}
      <canvas ref={canvasRef} className="constellation-canvas" />

      {/* Ambient Depth Vignette */}
      <div className="ambient-vignette" />
    </div>
  );
};
