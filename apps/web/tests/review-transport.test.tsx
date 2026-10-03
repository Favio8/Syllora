import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import ReviewAccess from '../src/components/ReviewAccess';
import { authenticateReview, reviewFetch, reviewToken, setReviewToken } from '../src/lib/review-transport';

const request = vi.fn();
beforeEach(() => { vi.stubEnv('NEXT_PUBLIC_SYLLORA_API_URL', 'https://review.ngrok-free.app'); vi.stubEnv('NEXT_PUBLIC_SYLLORA_REVIEW_PUBLIC', '0'); vi.stubGlobal('fetch', request); sessionStorage.clear(); request.mockReset(); setReviewToken(null); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); sessionStorage.clear(); });
describe('review browser transport', () => {
  it('sends REST, uploads and SSE directly with a tab-scoped bearer and no cross-site cookie', async () => {
    setReviewToken('test-access-code'); request.mockResolvedValue(new Response('{}'));
    for (const path of ['/api/syllora/state', '/api/courses/c/sources', '/api/syllora/agentStream']) {
      await reviewFetch(path, { method: 'POST' });
      const [url, init] = request.mock.calls.at(-1)!;
      expect(url).toBe(`https://review.ngrok-free.app${path}`);
      expect(init.credentials).toBe('omit');
      expect(init.headers.get('Authorization')).toBe('Bearer test-access-code');
      expect(init.headers.get('ngrok-skip-browser-warning')).toBe('1');
    }
    expect(localStorage.length).toBe(0);
    expect(reviewToken()).toBe('test-access-code');
  });
  it('keeps original document and note assets on the cookie-authenticated same origin', async () => {
    request.mockResolvedValue(new Response('{}'));
    await reviewFetch('/api/syllora/material-file?courseId=c&sourceId=s');
    expect(request.mock.calls[0]![0]).toBe('/api/syllora/material-file?courseId=c&sourceId=s');
    expect(request.mock.calls[0]![1].credentials).toBe('same-origin');
    expect(() => reviewFetch('/api/../../outside')).toThrow('路径');
    expect(() => reviewFetch('//attacker.test/api/state')).toThrow('路径');
  });
  it('requires a validated session before exposing the workbench and clears credentials on expiration', async () => {
    request.mockResolvedValue(new Response(JSON.stringify({ ok: true, session: 'granted' })));
    render(<ReviewAccess><div>review workbench</div></ReviewAccess>);
    expect(screen.queryByText('review workbench')).toBeNull();
    fireEvent.change(await screen.findByLabelText('访问码'), { target: { value: 'test-code' } });
    fireEvent.click(screen.getByText('进入工作台'));
    await screen.findByText('review workbench');
    expect(request.mock.calls[0]![0]).toBe('/api/session');
    expect(reviewToken()).toBe('test-code');
    request.mockResolvedValue(new Response('{}', { status: 401 }));
    await reviewFetch('/api/syllora/state');
    await waitFor(() => expect(screen.queryByText('review workbench')).toBeNull());
    expect(reviewToken()).toBeNull();
  });
  it('rejects incorrect access codes without persisting them and restores a validated tab session', async () => {
    request.mockResolvedValue(new Response('{}', { status: 401 }));
    await expect(authenticateReview('wrong')).rejects.toThrow('访问码无效');
    expect(reviewToken()).toBeNull();
    setReviewToken('saved');
    request.mockResolvedValue(new Response(JSON.stringify({ ok: true, session: 'granted' })));
    render(<ReviewAccess><div>restored workbench</div></ReviewAccess>);
    await screen.findByText('restored workbench');
    fireEvent.click(screen.getByText('退出评审'));
    await waitFor(() => expect(reviewToken()).toBeNull());
  });
  it('retains ordinary local fetch behavior', async () => {
    vi.stubEnv('NEXT_PUBLIC_SYLLORA_API_URL', ''); request.mockResolvedValue(new Response('{}'));
    const init = { method: 'GET' };
    await reviewFetch('/api/syllora/state', init);
    expect(request).toHaveBeenCalledWith('/api/syllora/state', init);
    render(<ReviewAccess><div>local workbench</div></ReviewAccess>);
    expect(screen.getByText('local workbench')).toBeTruthy();
  });
  it('opens a public workbench without a code and discards credentials from previous private sessions', async () => {
    vi.stubEnv('NEXT_PUBLIC_SYLLORA_REVIEW_PUBLIC', '1');
    setReviewToken('old-private-code');
    request.mockResolvedValue(new Response('{}'));
    render(<ReviewAccess><div>public workbench</div></ReviewAccess>);
    expect(screen.getByText('public workbench')).toBeTruthy();
    expect(screen.queryByLabelText('访问码')).toBeNull();
    expect(screen.queryByText('退出评审')).toBeNull();
    expect(request).not.toHaveBeenCalled();
    expect(reviewToken()).toBeNull();
    await reviewFetch('/api/settings.get', { method: 'POST', headers: { Authorization: 'Bearer stale' } });
    expect(request.mock.calls[0]![1].headers.has('Authorization')).toBe(false);
    await reviewFetch('/api/syllora/material-file?courseId=c&sourceId=s');
    expect(request.mock.calls[1]![0]).toBe('/api/syllora/material-file?courseId=c&sourceId=s');
  });
});
