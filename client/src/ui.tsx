import { useEffect, useId, useRef, type ReactNode } from 'react';

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';

/**
 * "Onion sigil": concentric rings derived from a mailbox id. Same id, same
 * sigil on every device; it echoes the self-certifying address visually.
 * Decorative only: identity is verified by the safety code, not by this.
 */
export function Sigil({ seed, size = 40 }: { seed: string; size?: number }) {
  const v = [...seed.padEnd(12, 'a').slice(0, 12)].map((c) => Math.max(0, B32.indexOf(c)));
  // Stay inside the brand's green family; rings differ by shade and dash pattern.
  const shade = (i: number) => (v[i] * 32 + v[i + 1]) / 1024;
  const color = (i: number, l0: number) => `hsl(${Math.round(140 + shade(i) * 40)} ${Math.round(45 + shade(i + 1) * 35)}% ${Math.round(l0 + shade(i) * 22)}%)`;
  const ring = (r: number, i: number) => {
    const c = 2 * Math.PI * r;
    const parts = (v[i + 6] % 3) + 2;
    return { r, color: color(i, i === 0 ? 50 : 62), dash: `${c / parts - 3} 3`, rot: v[i + 7] * 11.25 };
  };
  const rings = [ring(19, 0), ring(12.5, 2)];
  return (
    <svg className="sigil" width={size} height={size} viewBox="0 0 48 48" aria-hidden="true">
      <circle cx="24" cy="24" r="23.5" className="sigil-bg" />
      {rings.map((g, i) => (
        <circle
          key={i}
          cx="24"
          cy="24"
          r={g.r}
          fill="none"
          stroke={g.color}
          strokeWidth={i === 0 ? 3.5 : 3}
          strokeDasharray={g.dash}
          strokeLinecap="round"
          transform={`rotate(${g.rot} 24 24)`}
        />
      ))}
      <circle cx="24" cy="24" r="5.5" className="sigil-core" fill={color(4, 70)} />
    </svg>
  );
}

// Gallery avatars: 5 shapes x 4 inner patterns, in the brand's black/green/white.
// Index order is part of the protocol (contacts receive only the index), so only append.
const SHAPES = [
  'M24 6a18 18 0 1 1 0 36a18 18 0 1 1 0-36z', // circle
  'M13 8h22a5 5 0 0 1 5 5v22a5 5 0 0 1-5 5H13a5 5 0 0 1-5-5V13a5 5 0 0 1 5-5z', // rounded square
  'M24 6l20 34H4z', // triangle
  'M24 4l20 20-20 20L4 24z', // diamond
  'M24 5l16.5 9.5v19L24 43 7.5 33.5v-19z', // hexagon
];
const FILLS = ['#34d399', '#a7f3d0', '#e3ebe6', '#10b981'];

/** One gallery avatar, or the onion sigil when none was chosen. */
export function Avatar({ avatar, seed, size = 40 }: { avatar?: number; seed: string; size?: number }) {
  if (avatar === undefined) return <Sigil seed={seed} size={size} />;
  const shape = SHAPES[avatar % 5];
  const pattern = Math.floor(avatar / 5) % 4;
  const fill = FILLS[(avatar + pattern) % FILLS.length];
  return (
    <svg className="sigil" width={size} height={size} viewBox="0 0 48 48" aria-hidden="true">
      <circle cx="24" cy="24" r="23.5" className="sigil-bg" />
      <g transform="translate(24 24) scale(0.72) translate(-24 -24)">
        <path d={shape} fill={pattern === 1 ? 'none' : fill} stroke={fill} strokeWidth={pattern === 1 ? 4 : 0} strokeLinejoin="round" />
        {pattern === 2 && <circle cx="24" cy="26" r="6" fill="#0b0f0d" />}
        {pattern === 3 && <path d="M14 26h20M14 32h20" stroke="#0b0f0d" strokeWidth="3.5" strokeLinecap="round" />}
        {pattern === 1 && <circle cx="24" cy="26" r="4.5" fill={fill} />}
      </g>
    </svg>
  );
}

/** The Privatum key mark (vector redraw of the brand logo). */
export function Logo({ size = 32 }: { size?: number }) {
  return (
    <svg className="logo" width={(size * 446) / 676} height={size} viewBox="-40 -10 446 676" aria-hidden="true">
      <path fillRule="evenodd" d="M183 0a183 183 0 1 1 0 366A183 183 0 1 1 183 0zm0 71a112 112 0 1 0 0 224A112 112 0 1 0 183 71z" />
      <rect x="131" y="296" width="80" height="357" rx="20" />
      <rect x="180" y="425" width="118" height="75" rx="20" />
      <rect x="180" y="550" width="118" height="103" rx="20" />
    </svg>
  );
}

const PATHS: Record<string, string> = {
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  download: 'M12 4v11m0 0-4-4m4 4 4-4M5 19h14',
  lock: 'M7 11V8a5 5 0 0 1 10 0v3M6 11h12v9H6z',
  logout: 'M14 4h5v16h-5M10 8l-4 4 4 4M6 12h10',
  plus: 'M12 5v14M5 12h14',
  send: 'M5 12h12M12 6l6 6-6 6',
  back: 'M15 6l-6 6 6 6',
  x: 'M6 6l12 12M18 6 6 18',
  more: 'M6 12h.01M12 12h.01M18 12h.01',
  shield: 'M12 3l7 3v5c0 4.5-3 8.2-7 10-4-1.8-7-5.5-7-10V6z',
  check: 'M8.5 12.5l2.5 2.5 4.5-5',
  sound: 'M5 9v6h4l5 4V5L9 9zM17 9a4 4 0 0 1 0 6',
  muted: 'M5 9v6h4l5 4V5L9 9zM17 9l4 6M21 9l-4 6',
};

export function Icon({ name }: { name: keyof typeof PATHS | string }) {
  return (
    <svg className="icon-svg" width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
      <path d={PATHS[name]} fill="none" stroke="currentColor" strokeWidth={name === 'more' ? 3.2 : 1.8} strokeLinecap="round" strokeLinejoin="round" />
      {name === 'shield' && <path d={PATHS.check} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />}
    </svg>
  );
}

/** Native <dialog>: focus trap, Esc to close and inert background come from the browser. */
export function Modal({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="modal"
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose(); // click on the backdrop
      }}
    >
      <div className="modal-body">
        <header className="modal-head">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="icon-btn" aria-label="Fechar" onClick={onClose}>
            <Icon name="x" />
          </button>
        </header>
        {children}
      </div>
    </dialog>
  );
}
