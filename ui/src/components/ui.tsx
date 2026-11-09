import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { cx } from "../lib/format";

export function Logo({ size = 28 }: { size?: number }) {
  // Keystone mark: an arch with the wedge-shaped keystone at its crown.
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-label="Keystone" role="img">
      <rect width="32" height="32" rx="9" fill="var(--surface2)" stroke="var(--border)" />
      <path d="M8.5 25V15a7.5 7.5 0 0 1 15 0v10" fill="none" stroke="var(--text-muted)" strokeWidth="2.2" strokeLinecap="round" />
      <path d="M13.2 6.6h5.6l-1.6 6.2h-2.4z" fill="var(--accent)" />
      <path d="M12 25h8" stroke="var(--text-muted)" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

export function Switch({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label?: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      className={cx("switch", on && "on")}
      onClick={() => onChange(!on)}
    />
  );
}

export function Seg<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: ReactNode; title?: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="seg" role="radiogroup">
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} title={o.title} className={cx(value === o.value && "on")} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Field({ label, hint, error, children, className }: { label?: ReactNode; hint?: ReactNode; error?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cx("field", className)} onClick={(e) => (e.target as HTMLElement).tagName === "LABEL" && e.preventDefault()}>
      {label && <span className="field-label">{label}</span>}
      {children}
      {error ? <span className="field-error">{error}</span> : hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

function useEscape(onClose: () => void) {
  const ref = useRef(onClose);
  ref.current = onClose;
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        ref.current();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);
}

export function Modal({ title, icon, onClose, children, footer, wide, closeOnBackdrop = true }: {
  title: ReactNode; icon?: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean; closeOnBackdrop?: boolean;
}) {
  useEscape(onClose);
  return (
    <div className="backdrop" onMouseDown={(e) => closeOnBackdrop && e.target === e.currentTarget && onClose()}>
      <div className={cx("modal", wide && "wide")} role="dialog" aria-modal="true">
        <div className="modal-head">
          {icon}
          <h2 className="grow">{title}</h2>
          <button className="btn btn-ghost btn-icon btn-sm" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Drawer({ title, subtitle, onClose, children, footer, tabs }: {
  title: ReactNode; subtitle?: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; tabs?: ReactNode;
}) {
  useEscape(onClose);
  return (
    <>
      <div className="drawer-backdrop" onMouseDown={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true">
        <div className="modal-head">
          <div className="grow">
            <h2>{title}</h2>
            {subtitle && <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>{subtitle}</div>}
          </div>
          <button className="btn btn-ghost btn-icon btn-sm" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>
        {tabs}
        <div className="modal-body" style={{ flex: 1 }}>{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </aside>
    </>
  );
}

export function Empty({ icon, title, children, action }: { icon: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon}</div>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function Kbd({ combo }: { combo: string }) {
  if (!combo) return null;
  return (
    <span className="row" style={{ gap: 3 }}>
      {combo.split("+").map((k, i) => (
        <span key={i} className="kbd">{k}</span>
      ))}
    </span>
  );
}

export function StrengthMeter({ score }: { score: number | null }) {
  return (
    <div className="strength" data-score={score ?? -1} aria-label={`Strength ${score ?? 0} of 4`}>
      <span /><span /><span /><span /><span />
    </div>
  );
}

export const STRENGTH_LABEL = ["Very weak", "Weak", "Fair", "Strong", "Very strong"];
