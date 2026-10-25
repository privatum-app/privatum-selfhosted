import { useEffect, useId, useRef, type ReactNode } from 'react';
import qrcode from 'qrcode-generator';
import { t } from './i18n.ts';

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

// Gallery avatars, drawn in the brand palette. The index order is part of the
// protocol (contacts receive only the index), so new avatars are only appended.
const G = '#34d399';
const E = '#10b981';
const M = '#a7f3d0';
const W = '#e3ebe6';
const D = '#0b0f0d';
const A = '#f59e0b';
const KEY = 'M183 0a183 183 0 1 1 0 366A183 183 0 1 1 183 0zm0 71a112 112 0 1 0 0 224A112 112 0 1 0 183 71z';

export const AVATAR_NAMES = [
  'Chave', 'Pinguim', 'Coruja', 'Raposa', 'Gato', 'Panda', 'Coelho', 'Polvo', 'Baleia', 'Fantasma',
  'Robô', 'Astronauta', 'Alienígena', 'Ninja', 'Foguete', 'Lua', 'Cogumelo', 'Cacto', 'Cebola', 'Cadeado',
];

const ART = [
  // chave
  <g key="0" fill={G} transform="translate(17 8.6) scale(0.047)">
    <path fillRule="evenodd" d={KEY} />
    <rect x="131" y="296" width="80" height="357" rx="20" />
    <rect x="180" y="425" width="118" height="75" rx="20" />
    <rect x="180" y="550" width="118" height="103" rx="20" />
  </g>,
  // pinguim
  <g key="1">
    <ellipse cx="24" cy="26" rx="12" ry="15" fill={D} stroke={M} strokeWidth="1.5" />
    <ellipse cx="24" cy="29.5" rx="8" ry="10" fill={W} />
    <circle cx="20" cy="19.5" r="2.2" fill={W} />
    <circle cx="28" cy="19.5" r="2.2" fill={W} />
    <circle cx="20.4" cy="19.8" r="1" fill={D} />
    <circle cx="27.6" cy="19.8" r="1" fill={D} />
    <path d="M21.5 23l2.5 3 2.5-3z" fill={A} />
    <ellipse cx="19.5" cy="40.6" rx="3.2" ry="1.5" fill={A} />
    <ellipse cx="28.5" cy="40.6" rx="3.2" ry="1.5" fill={A} />
  </g>,
  // coruja
  <g key="2">
    <path d="M13 17l3-7 5 5zM35 17l-3-7-5 5z" fill={E} />
    <ellipse cx="24" cy="27" rx="12" ry="13" fill={E} />
    <ellipse cx="24" cy="31.5" rx="7" ry="7.5" fill={M} />
    <circle cx="19" cy="21" r="4.6" fill={W} />
    <circle cx="29" cy="21" r="4.6" fill={W} />
    <circle cx="19" cy="21" r="2.1" fill={D} />
    <circle cx="29" cy="21" r="2.1" fill={D} />
    <path d="M22.5 25l1.5 3 1.5-3z" fill={A} />
  </g>,
  // raposa
  <g key="3">
    <path d="M11 11l8 7h10l8-7-1 14-12 13-12-13z" fill={A} />
    <path d="M16.5 26l7.5 10 7.5-10-7.5 3z" fill={W} />
    <circle cx="19" cy="23" r="1.6" fill={D} />
    <circle cx="29" cy="23" r="1.6" fill={D} />
    <circle cx="24" cy="34" r="1.6" fill={D} />
  </g>,
  // gato
  <g key="4">
    <path d="M13 12l7 6h8l7-6v16a11 11 0 0 1-22 0z" fill={G} />
    <ellipse cx="19.5" cy="26" rx="1.6" ry="2.4" fill={D} />
    <ellipse cx="28.5" cy="26" rx="1.6" ry="2.4" fill={D} />
    <path d="M22.8 30.5h2.4l-1.2 1.5z" fill={D} />
    <path d="M9 30h7M9 33.5l7-1.5M39 30h-7M39 33.5l-7-1.5" stroke={M} strokeWidth="1.2" strokeLinecap="round" />
  </g>,
  // panda
  <g key="5">
    <circle cx="15" cy="15" r="5" fill={D} stroke={M} strokeWidth="1" />
    <circle cx="33" cy="15" r="5" fill={D} stroke={M} strokeWidth="1" />
    <circle cx="24" cy="26" r="13" fill={W} />
    <ellipse cx="18.5" cy="25" rx="3.4" ry="4.6" fill={D} transform="rotate(-20 18.5 25)" />
    <ellipse cx="29.5" cy="25" rx="3.4" ry="4.6" fill={D} transform="rotate(20 29.5 25)" />
    <circle cx="18.8" cy="24.5" r="1.2" fill={W} />
    <circle cx="29.2" cy="24.5" r="1.2" fill={W} />
    <ellipse cx="24" cy="31" rx="2.2" ry="1.5" fill={D} />
  </g>,
  // coelho
  <g key="6">
    <ellipse cx="19" cy="13" rx="3.2" ry="8" fill={W} />
    <ellipse cx="29" cy="13" rx="3.2" ry="8" fill={W} />
    <ellipse cx="19" cy="13" rx="1.4" ry="5.5" fill={M} />
    <ellipse cx="29" cy="13" rx="1.4" ry="5.5" fill={M} />
    <circle cx="24" cy="28" r="11" fill={W} />
    <circle cx="20" cy="26.5" r="1.4" fill={D} />
    <circle cx="28" cy="26.5" r="1.4" fill={D} />
    <ellipse cx="24" cy="30.5" rx="1.6" ry="1.1" fill={E} />
  </g>,
  // polvo
  <g key="7">
    <path d="M12 25a12 12 0 0 1 24 0v5H12z" fill={M} />
    <path d="M14 29c0 6 1 9 3 10M19.5 29c0 6 1 9 1.5 11M28.5 29c0 6-.5 9-1.5 11M34 29c0 6-1 9-3 10" stroke={M} strokeWidth="3" strokeLinecap="round" fill="none" />
    <circle cx="19.5" cy="23" r="1.9" fill={D} />
    <circle cx="28.5" cy="23" r="1.9" fill={D} />
  </g>,
  // baleia
  <g key="8">
    <path d="M36 26l7-6-1 9z" fill={E} />
    <path d="M7 27c0-7 7-11 16-11 8 0 14 5 14 11 0 6-7 10-15 10h-9c-3 0-6-4-6-10z" fill={E} />
    <path d="M12 30c4 3 13 4 20 1" stroke={M} strokeWidth="2" fill="none" strokeLinecap="round" />
    <circle cx="15" cy="24" r="1.6" fill={D} />
    <path d="M21 14c0-3-2-5-4-5M21 14c0-3 2-5 4-5" stroke={M} strokeWidth="1.6" fill="none" strokeLinecap="round" />
  </g>,
  // fantasma
  <g key="9">
    <path d="M13 38V23a11 11 0 0 1 22 0v15l-3.7-3-3.6 3-3.7-3-3.7 3-3.6-3z" fill={W} />
    <ellipse cx="20" cy="23" rx="1.8" ry="2.6" fill={D} />
    <ellipse cx="28" cy="23" rx="1.8" ry="2.6" fill={D} />
    <ellipse cx="24" cy="29" rx="2" ry="1.4" fill={D} />
  </g>,
  // robô
  <g key="10">
    <path d="M24 9v5" stroke={M} strokeWidth="2" strokeLinecap="round" />
    <circle cx="24" cy="8.5" r="2" fill={A} />
    <rect x="12" y="14" width="24" height="21" rx="5" fill={G} />
    <rect x="9" y="21" width="3" height="8" rx="1.5" fill={E} />
    <rect x="36" y="21" width="3" height="8" rx="1.5" fill={E} />
    <circle cx="19" cy="23" r="3" fill={W} />
    <circle cx="29" cy="23" r="3" fill={W} />
    <circle cx="19" cy="23" r="1.3" fill={D} />
    <circle cx="29" cy="23" r="1.3" fill={D} />
    <rect x="18" y="29" width="12" height="3" rx="1.5" fill={D} />
  </g>,
  // astronauta
  <g key="11">
    <circle cx="24" cy="24" r="14" fill={W} />
    <rect x="14" y="16.5" width="20" height="13" rx="6.5" fill={D} />
    <path d="M18 21a4 4 0 0 1 4-2.2" stroke={G} strokeWidth="2" strokeLinecap="round" fill="none" />
    <rect x="17" y="33" width="14" height="3.5" rx="1.75" fill={M} />
  </g>,
  // alienígena
  <g key="12">
    <path d="M24 9c8 0 13 6 13 13 0 8-7 16-13 16S11 30 11 22c0-7 5-13 13-13z" fill={G} />
    <ellipse cx="18.5" cy="23" rx="4.2" ry="2.6" fill={D} transform="rotate(25 18.5 23)" />
    <ellipse cx="29.5" cy="23" rx="4.2" ry="2.6" fill={D} transform="rotate(-25 29.5 23)" />
    <path d="M22 31.5h4" stroke={E} strokeWidth="1.6" strokeLinecap="round" />
  </g>,
  // ninja
  <g key="13">
    <path d="M36 22l6-3M36 24.5l6 1.5" stroke={G} strokeWidth="2.2" strokeLinecap="round" />
    <circle cx="24" cy="25" r="13" fill={D} stroke={E} strokeWidth="1.5" />
    <rect x="12" y="20" width="24" height="7" rx="2" fill={M} />
    <ellipse cx="19.5" cy="23.5" rx="2" ry="1.3" fill={D} />
    <ellipse cx="28.5" cy="23.5" rx="2" ry="1.3" fill={D} />
  </g>,
  // foguete
  <g key="14">
    <path d="M17 24l-5 7v3l6-3zM31 24l5 7v3l-6-3z" fill={G} />
    <path d="M24 8c6 5 8 12 7 21H17c-1-9 1-16 7-21z" fill={W} />
    <circle cx="24" cy="19" r="3" fill={G} stroke={D} strokeWidth="1.5" />
    <path d="M19.5 29h9l-1 4h-7z" fill={E} />
    <path d="M22 34l2 6 2-6z" fill={A} />
  </g>,
  // lua
  <g key="15">
    <path d="M30 9a15 15 0 1 0 9 26a12 12 0 1 1-9-26z" fill={M} />
    <path d="M15 12l1 2.5 2.5 1-2.5 1-1 2.5-1-2.5-2.5-1 2.5-1z" fill={W} />
    <circle cx="36" cy="14" r="1.2" fill={W} />
  </g>,
  // cogumelo
  <g key="16">
    <path d="M10 25a14 12 0 0 1 28 0z" fill={G} />
    <circle cx="18" cy="19" r="2.2" fill={W} />
    <circle cx="28" cy="17" r="2.6" fill={W} />
    <circle cx="31.5" cy="22.5" r="1.5" fill={W} />
    <path d="M19 25h10l-1 11a3 3 0 0 1-3 3h-2a3 3 0 0 1-3-3z" fill={W} />
    <circle cx="22" cy="30" r="0.9" fill={D} />
    <circle cx="26" cy="30" r="0.9" fill={D} />
  </g>,
  // cacto
  <g key="17">
    <path d="M21 25h-4a2 2 0 0 1-2-2v-5M27 22h4a2 2 0 0 0 2-2v-4" stroke={G} strokeWidth="4" strokeLinecap="round" fill="none" />
    <rect x="21" y="11" width="6" height="24" rx="3" fill={G} />
    <path d="M15 33h18l-2 7H17z" fill={A} />
  </g>,
  // cebola (Tor)
  <g key="18">
    <path d="M24 15c0-4 2-7 6-8M24 15c-1-3-3-5-6-5" stroke={E} strokeWidth="2" strokeLinecap="round" fill="none" />
    <path d="M24 13c7 3 12 8 12 15a12 12 0 0 1-24 0c0-7 5-12 12-15z" fill={G} />
    <path d="M24 18c4.5 2.5 7.5 6 7.5 10a7.5 7.5 0 0 1-15 0c0-4 3-7.5 7.5-10z" fill="none" stroke={D} strokeWidth="1.8" />
    <path d="M24 23c2 1.5 3.3 3 3.3 5a3.3 3.3 0 0 1-6.6 0c0-2 1.3-3.5 3.3-5z" fill="none" stroke={D} strokeWidth="1.8" />
  </g>,
  // cadeado
  <g key="19">
    <path d="M17 21v-4a7 7 0 0 1 14 0v4" stroke={M} strokeWidth="3.5" fill="none" />
    <rect x="13" y="21" width="22" height="17" rx="4" fill={G} />
    <circle cx="24" cy="28" r="2.5" fill={D} />
    <rect x="23" y="29" width="2" height="5" rx="1" fill={D} />
  </g>,
];

/** Default avatar for anyone who has not picked one: a stylized onion, after Tor. */
const DEFAULT_ART = (
  <g>
    <path d="M24 12c0-3.5 1.8-6 5.5-7M24 12c-.6-2.6-2.4-4.3-5-4.8" stroke={E} strokeWidth="2.2" strokeLinecap="round" fill="none" />
    <path d="M24 11c8.5 3.8 13.5 9.6 13.5 17a13.5 13.5 0 0 1-27 0c0-7.4 5-13.2 13.5-17z" fill={G} />
    <path d="M24 16.5c5.6 3 8.6 7.1 8.6 11.6a8.6 8.6 0 0 1-17.2 0c0-4.5 3-8.6 8.6-11.6z" fill="none" stroke={D} strokeWidth="1.6" />
    <path d="M24 22c2.9 1.8 4.4 4 4.4 6.3a4.4 4.4 0 0 1-8.8 0c0-2.3 1.5-4.5 4.4-6.3z" fill="none" stroke={D} strokeWidth="1.6" />
    <circle cx="24" cy="29" r="1.4" fill={D} />
    <path d="M15.6 25.5c.8-3 2.8-5.6 5.6-7.6" stroke={M} strokeWidth="1.4" strokeLinecap="round" fill="none" />
  </g>
);

/** One gallery avatar, or the default onion when none was chosen. */
export function Avatar({ avatar, size = 40 }: { avatar?: number; size?: number }) {
  return (
    <svg className="sigil" width={size} height={size} viewBox="0 0 48 48" aria-hidden="true">
      <circle cx="24" cy="24" r="23.5" className="sigil-bg" />
      {avatar !== undefined && ART[avatar] ? ART[avatar] : DEFAULT_ART}
    </svg>
  );
}

/** QR code of a link, drawn as one SVG path (no canvas, no inline styles). */
export function Qr({ text }: { text: string }) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
  return (
    <svg className="qr" viewBox={`-4 -4 ${n + 8} ${n + 8}`} role="img" aria-label={t('QR code do link')}>
      <rect x="-4" y="-4" width={n + 8} height={n + 8} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  );
}

/** Groups have no avatar of their own: a people mark on the same disc. */
export function GroupAvatar({ size = 40 }: { size?: number }) {
  return (
    <span className="group-avatar" style={{ width: size, height: size }} aria-hidden="true">
      <Icon name="group" />
    </span>
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
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4',
  help: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.6 9.2a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.2-2.4 3.6M12 17h.01',
  timer: 'M12 8.5v4l2.5 1.5M12 21a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM9.5 2.5h5',
  group: 'M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3.5 19c0-3 2.5-5 5.5-5s5.5 2 5.5 5M16 5.2a3 3 0 0 1 0 5.6M18 14.3c1.6.6 2.5 2.4 2.5 4.7',
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
    if (open && !d.open) {
      d.showModal();
      // showModal focuses the first control (the close button); prefer the field marked for it.
      d.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    }
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
          <button type="button" className="icon-btn" aria-label={t('Fechar')} onClick={onClose}>
            <Icon name="x" />
          </button>
        </header>
        {children}
      </div>
    </dialog>
  );
}
