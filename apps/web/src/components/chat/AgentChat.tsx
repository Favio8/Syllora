"use client";

/**
 * 工作台「对话学习」的 agent 聊天宿主。
 *
 * 自包含：不依赖独立的 Console 外壳，只把已提交的 ChatArea（含工具调用行、
 * ask 折叠、审批面板）挂到课程工作区里，并补齐两套 id 空间之间的桥接——
 * chat/agent 端点的 courseId 必须是「课程文件夹名」（courseDirOf 的等值
 * 校验），而工作台的课程 id 是 UUID，二者的换算只在这里发生。
 */

import { useEffect, useMemo, type ReactNode } from "react";
import WorkbenchChat from "./WorkbenchChat";
import CommandPalette from "@/src/components/palette/CommandPalette";
import { api } from "@/src/lib/api";
import { useAppStore } from "@/src/store/useAppStore";
import "@/src/components/chat/agent-chat.css";

export interface AgentChatProps {
  /** 课程文件夹绝对路径（工作台 project 的 path）。 */
  folder: string;
  /** 课程显示名（会话面板标题）。 */
  courseName: string;
  /** 打开工作台自己的模型设置弹窗。 */
  onOpenSettings?: () => void;
  children?: ReactNode;
  onUpload?: () => void;
  onPractice?: () => void;
  disabled?: boolean;
}

/** 课程文件夹名 = chat/agent 端点的 courseId；Windows 分隔符也要切。 */
export function chatCourseIdOf(folder: string): string {
  return folder.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
}

export default function AgentChat({ folder, courseName, onOpenSettings, children, onUpload = () => {}, onPractice = () => {}, disabled }: AgentChatProps) {
  const setWorkspacePath = useAppStore((s) => s.setWorkspacePath);
  const setCourses = useAppStore((s) => s.setCourses);
  const setActiveCourse = useAppStore((s) => s.setActiveCourse);
  const paletteOpen = useAppStore((s) => s.paletteOpen);
  const settingsOpen = useAppStore((s) => s.settingsOpen);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  const chatCourseId = useMemo(() => chatCourseIdOf(folder), [folder]);

  // 桥接 store：项目路径、课程列表、激活课程。setActiveCourse 会清空消息与
  // 会话，所以只在课程真正变化时调用（工作台每 1.5s 轮询 state 会反复渲染）。
  useEffect(() => {
    if (chatCourseId === "") return;
    setWorkspacePath(folder);
    setCourses([{ id: chatCourseId, title: courseName, overallMastery: 0, dueToday: 0, lastActiveAt: null }]);
    if (useAppStore.getState().activeCourseId !== chatCourseId) setActiveCourse(chatCourseId);
  }, [folder, chatCourseId, courseName, setWorkspacePath, setCourses, setActiveCourse]);

  // 工作台没有 Console 的设置弹层：聊天里的「打开模型配置」转给 Syllora 设置。
  // 复位标志位，否则第二次点击不会再次触发（值恒为 true）。
  useEffect(() => {
    if (!settingsOpen) return;
    setSettingsOpen(false);
    onOpenSettings?.();
  }, [settingsOpen, setSettingsOpen, onOpenSettings]);

  // 注册表自愈：课程骨架缺失时补空壳，避免会话接口报「课程不存在」。
  useEffect(() => {
    if (chatCourseId === "") return;
    void api.ensureCourse(chatCourseId).catch(() => undefined);
  }, [chatCourseId]);

  return (
    <div className="sy-agent-chat">
      <WorkbenchChat courseName={courseName} onUpload={onUpload} onPractice={onPractice} disabled={disabled}>{children}</WorkbenchChat>
      {paletteOpen ? <CommandPalette /> : null}
    </div>
  );
}
