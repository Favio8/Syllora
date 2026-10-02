'use client';

import { useRef, useState } from 'react';

const PREFIX = 'syllora-ui.chat-draft.v1.';

/** 当前标签页按课程保留草稿，模式/页面切换不会丢失；刷新后仍可恢复。 */
export function useChatDrafts() {
  const drafts = useRef<Record<string, string>>({});
  const [, render] = useState(0);
  function get(courseId: string) {
    if (!(courseId in drafts.current)) {
      try { drafts.current[courseId] = sessionStorage.getItem(PREFIX + courseId) ?? ''; }
      catch { drafts.current[courseId] = ''; }
    }
    return drafts.current[courseId];
  }
  function set(courseId: string, value: string) {
    drafts.current[courseId] = value;
    render(version => version + 1);
    try {
      if (value) sessionStorage.setItem(PREFIX + courseId, value);
      else sessionStorage.removeItem(PREFIX + courseId);
      return true;
    } catch { return false; }
  }
  function clearAccepted(courseId: string, submitted: string) {
    // 发送期间新输入的内容、预设提示之外的草稿都保留。
    if (get(courseId).trim() === submitted.trim()) set(courseId, '');
  }
  function reset() {
    drafts.current = {};
    try {
      for (let i = sessionStorage.length - 1; i >= 0; i--) {
        const key = sessionStorage.key(i);
        if (key?.startsWith(PREFIX)) sessionStorage.removeItem(key);
      }
    } catch { /* 当前页面内存仍已清空。 */ }
    render(version => version + 1);
  }
  return { get, set, clearAccepted, reset };
}
