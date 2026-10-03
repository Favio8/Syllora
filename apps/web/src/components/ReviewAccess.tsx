'use client';

import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { BookOpen, LoaderCircle, LogOut } from 'lucide-react';
import { authenticateReview, reviewApiOrigin, reviewToken, setReviewToken } from '../lib/review-transport';
import './review-access.css';

export default function ReviewAccess({ children }: { children: ReactNode }) {
  const remote = Boolean(reviewApiOrigin());
  const [ready, setReady] = useState(!remote);
  const [checking, setChecking] = useState(remote);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!remote) return;
    const controller = new AbortController();
    const token = reviewToken();
    if (!token) setChecking(false);
    else void authenticateReview(token, controller.signal).then(() => setReady(true)).catch(e => {
      if (!controller.signal.aborted) { setError(e instanceof Error ? e.message : '连接失败，请重试。'); setCode(token); }
    }).finally(() => { if (!controller.signal.aborted) setChecking(false); });
    const expired = () => { setReady(false); setReviewToken(null); setError('访问码已失效，请重新登录。'); };
    window.addEventListener('syllora-review-unauthorized', expired);
    return () => { controller.abort(); window.removeEventListener('syllora-review-unauthorized', expired); };
  }, [remote]);
  async function login(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try { await authenticateReview(code.trim()); setCode(''); setReady(true); }
    catch (e) { setError(e instanceof Error ? e.message : '连接失败，请重试。'); }
    finally { setBusy(false); }
  }
  if (!remote) return children;
  if (ready) return <div className="sy-review-session">{children}<button className="sy-review-logout" onClick={async () => {
    setReviewToken(null); setReady(false); setCode('');
    await fetch('/api/session/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => undefined);
  }}><LogOut size={13} />退出评审</button></div>;
  return <main className="sy-review-access"><section className="sy-review-card" aria-label="评审登录">
    <BookOpen size={28} strokeWidth={1.6} /><h1>Syllora</h1><p>输入项目负责人提供的访问码，进入学习工作台。</p>
    {checking ? <p role="status"><LoaderCircle className="sy-review-spinner" size={16} />正在连接评审服务…</p> : <form onSubmit={login}>
      <label htmlFor="review-code">访问码</label><input id="review-code" type="password" autoComplete="off" autoFocus value={code} onChange={e => setCode(e.target.value)} required disabled={busy} />
      {error && <p role="alert" className="sy-review-error">{error}</p>}
      <button type="submit" disabled={busy || !code.trim()}>{busy ? '正在连接…' : '进入工作台'}</button>
    </form>}
  </section></main>;
}
