"use client";

/**
 * 消息（v1.4：DSH MessageItem 复刻）：
 * - 用户：右对齐淡蓝气泡 + 下方 hover 时间/复制操作；
 * - Agent：全宽左对齐无气泡无卡，块序列 = ReasoningRow → markdown 正文；
 *   底部追加 hover 时间/复制操作；
 * - 失败：错误行 + 重试键。
 * （「转复习卡」与「从此处创建分支」已按需求取消；选区浮动按钮一并移除。）
 */

import { useRef } from "react";
import ThinkingFold from "@/src/components/chat/ThinkingFold";
import ToolFold from "@/src/components/chat/ToolFold";
import AskFold from "@/src/components/chat/AskFold";
import MarkdownView from "@/src/components/chat/MarkdownView";
import MessageActions from "@/src/components/chat/MessageActions";
import { Clawzy } from "@/src/components/mascot";
import type { ChatMessage } from "@/src/store/useAppStore";

interface MessageCardProps {
  message: ChatMessage;
  onRetry?: () => void;
}

export default function MessageCard({ message, onRetry }: MessageCardProps) {
  const contentRef = useRef<HTMLDivElement>(null);

  if (message.role === "user") {
    return (
      <div data-time-hover-root="" className="group flex flex-col items-end gap-1.5">
        <div className="max-w-[min(525px,82%)] rounded-[22px] bg-bubble px-4 py-2.5 text-[16px] leading-6 text-text-primary">
          <MarkdownView content={message.content} bubble />
        </div>
        <MessageActions
          text={message.content}
          createdAt={message.createdAt}
          clock="start"
        />
      </div>
    );
  }

  const streaming = message.streaming === true;

  return (
    <div data-time-hover-root="" className="group relative flex min-w-0 flex-col gap-2">
      {/* P0-④：AI 消息署名行——20px 纯图标（拍板决策不带文字），状态自动派生：
          历史消息 idle，流式中的最后一条跟随 thinking/writing */}
      <div className="flex items-center">
        <Clawzy size={20} tier="icon" ariaLabel="Syllora" />
      </div>
      {message.thinking ? (
        <ThinkingFold
          thinking={message.thinking}
          thinkingMs={message.thinkingMs}
        />
      ) : null}
        {message.tools?.length ? (
          <ToolFold tools={message.tools} />
        ) : null}
      {message.ask ? (
        <AskFold question={message.ask.question} />
      ) : null}
      {message.content ? (
        <div ref={contentRef} className="min-w-0">
          <MarkdownView content={message.content} streaming={streaming} />
          {streaming ? (
            <span className="stream-cursor text-accent-focus">█</span>
          ) : null}
        </div>
      ) : null}
      {!streaming ? (
        <MessageActions
          text={message.content || message.thinking || ""}
          createdAt={message.createdAt}
          clock="end"
        />
      ) : null}
      {message.error ? (
        <div
          className="flex items-center gap-2 rounded-lg bg-accent-fail/10 px-3 py-1.5 text-[13px] text-accent-fail"
          role="alert"
        >
          <span>× {message.error}</span>
          {onRetry ? (
            <button
              type="button"
              onClick={onRetry}
              className="ml-auto rounded-md border border-accent-fail/50 px-2 py-0.5 hover:bg-accent-fail/20"
            >
              重试
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
