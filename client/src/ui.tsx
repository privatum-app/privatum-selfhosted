import { useEffect, useId, useRef, type ReactNode } from 'react';

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';

/**
 * "Onion sigil": concentric rings derived from a mailbox id. Same id, same
 * sigil on every device; it echoes the self-certifying address visually.
 * Decorative only: identity is verified by the safety code, not by this.
 */
export function Sigil({ seed, size = 40, brand = false }: { seed: string; size?: number; brand?: boolean }) {
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
    <svg className={brand ? 'sigil brand' : 'sigil'} width={size} height={size} viewBox="0 0 48 48" aria-hidden="true">
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

const PATHS: Record<string, string> = {
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  download: 'M12 4v11m0 0-4-4m4 4 4-4M5 19h14',
  lock: 'M7 11V8a5 5 0 0 1 10 0v3M6 11h12v9H6z',
  plus: 'M12 5v14M5 12h14',
  send: 'M5 12h12M12 6l6 6-6 6',
  back: 'M15 6l-6 6 6 6',
  x: 'M6 6l12 12M18 6 6 18',
  more: 'M6 12h.01M12 12h.01M18 12h.01',
  shield: 'M12 3l7 3v5c0 4.5-3 8.2-7 10-4-1.8-7-5.5-7-10V6z',
  check: 'M8.5 12.5l2.5 2.5 4.5-5',
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
