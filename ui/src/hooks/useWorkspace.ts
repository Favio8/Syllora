'use client';

import { useCallback, useEffect, useState } from 'react';
import { workspaceService } from '@/services';
import { STORAGE_KEY } from '@/services/mock';
import type { WorkspaceData } from '@/types';

export function useWorkspace() {
  const [data, setData] = useState<WorkspaceData | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try { setData(await workspaceService.load()); setError(''); }
    catch { setError('无法打开学习工作台，请重试。'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    void load();
    let active = true;
    async function refresh() {
      try {
        const next = await workspaceService.load();
        if (active) setData(current => current && (current.revision ?? 0) > (next.revision ?? 0) ? current : next);
      } catch { /* 不关闭当前编辑界面；写入失败通过 run 提示。 */ }
    }
    function changed(event: StorageEvent) { if (event.storageArea === localStorage && (event.key === STORAGE_KEY || event.key === null)) void refresh(); }
    window.addEventListener('storage', changed);
    window.addEventListener('focus', refresh);
    return () => { active = false; window.removeEventListener('storage', changed); window.removeEventListener('focus', refresh); };
  }, [load]);

  const run = useCallback(async (operation: () => Promise<WorkspaceData>) => {
    try {
      const next = await operation();
      setData(current => current && (current.revision ?? 0) > (next.revision ?? 0) ? current : next);
      setError('');
      return next;
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作未完成，请重试。');
      return null;
    }
  }, []);

  return { data, error, loading, load, run, clearError: () => setError('') };
}
