'use client';

import { useCallback, useEffect, useState } from 'react';
import { workspaceService } from '@/services';
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

  useEffect(() => { void load(); }, [load]);

  const run = useCallback(async (operation: () => Promise<WorkspaceData>) => {
    try {
      const next = await operation();
      setData(next);
      setError('');
      return next;
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作未完成，请重试。');
      return null;
    }
  }, []);

  return { data, error, loading, load, run, clearError: () => setError('') };
}
