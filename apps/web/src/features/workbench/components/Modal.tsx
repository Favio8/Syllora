'use client';

import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';

export default function Modal({ title, children, onClose, wide = false, error = '', className = '', closeDisabled = false }: { title: string; children: React.ReactNode; onClose: () => void; wide?: boolean; error?: string; className?: string; closeDisabled?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [closing, setClosing] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeCallback = useRef(onClose);
  closeCallback.current = onClose;

  function requestClose() {
    if (closing || closeDisabled) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { closeCallback.current(); return; }
    setClosing(true);
    closeTimer.current = setTimeout(() => closeCallback.current(), 150);
  }
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => { if (closeTimer.current) clearTimeout(closeTimer.current); dialog?.close(); };
  }, []);

  return <dialog ref={ref} className={`modal ${wide ? 'modal-wide' : ''} ${closing ? 'is-closing' : ''} ${className}`} aria-label={title} onCancel={e => { e.preventDefault(); requestClose(); }} onClick={e => { if (e.target === ref.current) requestClose(); }}>
    <div className="modal-content">
      <header className="modal-header"><h2>{title}</h2><button className="icon-button" disabled={closeDisabled} onClick={requestClose} aria-label={`关闭${title}`}><X size={20} /></button></header>
      {error && <div className="modal-error" role="alert">{error}</div>}
      {children}
    </div>
  </dialog>;
}
