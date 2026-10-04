'use client';
import { useState } from 'react';
import Modal from './Modal';
export interface Confirmation { title: string; message: string; confirmLabel: string; danger?: boolean; action: () => Promise<unknown> }
export default function ConfirmDialog({ request, onClose }: { request: Confirmation; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return <Modal title={request.title} error={error} closeDisabled={busy} onClose={() => { if (!busy) onClose(); }}><p className="modal-description">{request.message}</p><div className="modal-actions"><button className="button" disabled={busy} onClick={onClose}>取消</button><button className={`button ${request.danger ? 'danger-button' : 'primary'}`} disabled={busy} onClick={async () => { setBusy(true); try { const result = await request.action(); if (result !== null && result !== false) onClose(); else setError('操作未完成，请检查页面提示后重试。'); } catch (error) { setError(error instanceof Error ? error.message : '操作未完成'); } finally { setBusy(false); } }}>{busy ? '正在处理…' : request.confirmLabel}</button></div></Modal>;
}
