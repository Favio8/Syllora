"use client";

/**
 * DSH MessageIconActions 简化复刻：
 * - 消息 hover 时显示相对时间 + 复制按钮；
 * - 复制成功短暂显示 ✓。
 * （「转复习卡」与「从此处创建分支」已按需求取消，不再有入口。）
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Clipboard } from "lucide-react";
import { formatMessageTime } from "@/src/lib/format";

interface MessageActionsProps {
  text: string;
  createdAt?: string;
  clock?: "start" | "end";
}

export default function MessageActions({
  text,
  createdAt,
  clock = "start",
}: MessageActionsProps) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 1000);
    } catch {
      // 剪贴板不可用时至少保留当前文本在选区，静默失败。
    }
  }, [text]);

  return (
    <div
      data-time-hover-root=""
      className="flex h-7 items-center gap-2.5"
    >
      {clock === "start" && createdAt ? (
        <span className="hidden text-sm leading-6 text-text-faint opacity-0 transition-opacity duration-80 group-hover:opacity-100 group-focus-within:opacity-100 min-[420px]:inline">
          {formatMessageTime(createdAt)}
        </span>
      ) : null}
      <button
        type="button"
        aria-label={copied ? "已复制" : "复制"}
        title={copied ? "已复制" : "复制"}
        onClick={() => void copy()}
        className={`flex h-7 w-7 items-center justify-center rounded-full transition-[color,background-color,transform] duration-150 hover:bg-bg-card hover:text-accent-focus active:scale-90 ${
          copied ? "text-accent-pass" : "text-text-faint"
        }`}
      >
        {copied ? (
          <Check size={14} strokeWidth={2} aria-hidden className="ds-icon-pop" />
        ) : (
          <Clipboard size={14} strokeWidth={1.7} aria-hidden />
        )}
      </button>
      {clock === "end" && createdAt ? (
        <span className="hidden text-sm leading-6 text-text-faint opacity-0 transition-opacity duration-80 group-hover:opacity-100 group-focus-within:opacity-100 min-[420px]:inline">
          {formatMessageTime(createdAt)}
        </span>
      ) : null}
    </div>
  );
}
