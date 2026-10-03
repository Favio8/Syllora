/** Remote review transport. Credentials are never part of a build or a URL. */
export function reviewIsPublic(): boolean {
  return process.env.NEXT_PUBLIC_SYLLORA_REVIEW_PUBLIC === '1' && Boolean(reviewApiOrigin());
}

export function reviewApiOrigin(): string {
  const configured = process.env.NEXT_PUBLIC_SYLLORA_API_URL?.trim() ?? '';
  if (!configured) return '';
  const url = new URL(configured);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('评审 API 地址必须是 HTTPS 域名，不能包含路径或凭据。');
  }
  return url.origin;
}

function tokenKey(): string { return `syllora.review.token.v1:${reviewApiOrigin()}`; }

export function reviewToken(): string | null {
  if (!reviewApiOrigin() || typeof window === 'undefined') return null;
  try { return sessionStorage.getItem(tokenKey()); } catch { return null; }
}

export function setReviewToken(token: string | null): void {
  if (typeof window === 'undefined') return;
  const boot = window as unknown as { __SYLLORA__?: { token?: string; sessionUrl?: string } };
  boot.__SYLLORA__ = { ...boot.__SYLLORA__, token: token ?? '' };
  try {
    if (token) sessionStorage.setItem(tokenKey(), token);
    else sessionStorage.removeItem(tokenKey());
  } catch { /* The current page can still use its in-memory credential. */ }
}

export async function authenticateReview(token: string, signal?: AbortSignal): Promise<void> {
  const response = await fetch('/api/session', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'x-syllora-token': token, 'ngrok-skip-browser-warning': '1' },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    if (response.status === 401) throw new Error('访问码无效或后端已重启，请向项目负责人获取当前访问码。');
    throw new Error(`暂时无法连接评审服务（HTTP ${response.status}），请稍后重试。`);
  }
  const body = await response.json() as { ok?: boolean; session?: string };
  if (body.ok !== true || body.session !== 'granted') throw new Error('评审服务未启用访问验证，请联系项目负责人。');
  setReviewToken(token);
}

/** Keep media same-origin for HttpOnly cookies; large uploads and streams go direct. */
export function reviewFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const origin = reviewApiOrigin();
  if (!origin) return fetch(path, init);
  if (!path.startsWith('/api/') || path.includes('\\')) throw new Error('无效的 API 路径');
  const target = new URL(path, origin);
  if (target.origin !== origin || !target.pathname.startsWith('/api/')) throw new Error('无效的 API 路径');
  const headers = new Headers(init.headers);
  const boot = globalThis as unknown as { __SYLLORA__?: { token?: string } };
  const token = reviewIsPublic() ? null : (reviewToken() || boot.__SYLLORA__?.token);
  if (reviewIsPublic()) headers.delete('Authorization');
  if (token) headers.set('Authorization', `Bearer ${token}`);
  headers.set('ngrok-skip-browser-warning', '1');
  const media = target.pathname === '/api/syllora/material-file' || target.pathname === '/api/syllora/notes/asset';
  return fetch(media ? path : target.href, { ...init, credentials: media ? 'same-origin' : 'omit', headers }).then(response => {
    if (response.status === 401 && !reviewIsPublic()) window.dispatchEvent(new Event('syllora-review-unauthorized'));
    return response;
  });
}
