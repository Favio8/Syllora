"use client";

/**
 * 工作台「对话学习」的 agent 聊天宿主。
 *
 * 自包含：不依赖独立的 Console 外壳，使用 PR #43 的 LearningChat，保留工具调用行、
 * ask 折叠和审批面板。工作台与 chat/agent 端点使用同一课程 UUID，
 * 宿主校验 UUID 与目标课程目录的归属，兼容旧调用方的文件夹名身份。
 */

import { useEffect, useMemo, type ReactNode } from "react";
import LearningChat from "@/src/features/workbench/components/LearningChat";
import CommandPalette from "@/src/components/palette/CommandPalette";
import { api } from "@/src/lib/api";
import { useAppStore } from "@/src/store/useAppStore";
import "@/src/components/chat/agent-chat.css";

export interface AgentChatProps {
  /** 课程文件夹绝对路径（工作台 project 的 path）。 */
  folder: string;
  name?: string;
  draft?: string;
  onDraft?: (value:string) => void;
  disabled?: boolean;
  children?: ReactNode;
  onUpload?: () => void;
  onPractice?: () => void;
  /** 课程显示名（会话面板标题）。 */
  courseName: string;
  /** 工作台课程 UUID（B1：chat 端点的课程身份，缺省回落到文件夹名兼容旧调用方）。 */
  courseId?: string;
  /** 打开工作台自己的模型设置弹窗。 */
  onOpenSettings?: () => void;
}

/**
 * B1：chat/agent 端点的课程身份。历史契约是「课程文件夹名」，两门不同路径、
 * 同名文件夹的课程会共用同一个 chat 课程，会话与消息互相串入。现在以课程
 * UUID（工作台 project.id）作为 chat 课程 id；宿主侧按课程状态文件里的课程
 * id 解析目录，并向 basename 形式兼容（升级前的历史会话仍可读取——会话日志
 * 按课程目录分片存储，不随 id 变化）。
 */
export function chatCourseIdOf(folder: string, courseId?: string | null): string {
  const id = (courseId ?? "").trim();
  if (id !== "") return id;
  return folder.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
}

export default function AgentChat({ folder, courseName, courseId, onOpenSettings, ...props }: AgentChatProps) {
  const setWorkspacePath = useAppStore((s) => s.setWorkspacePath);
  const setCourses = useAppStore((s) => s.setCourses);
  const setActiveCourse = useAppStore((s) => s.setActiveCourse);
  const paletteOpen = useAppStore((s) => s.paletteOpen);
  const settingsOpen = useAppStore((s) => s.settingsOpen);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  // 桥接以「已打开课程文件夹」为前提：没有 folder 就没有可桥接的工作区
  // （此前的守卫语义不变），有 folder 时优先用课程 UUID 作为 chat 课程身份。
  const chatCourseId = useMemo(
    () => (folder === "" ? "" : chatCourseIdOf(folder, courseId)),
    [folder, courseId],
  );

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
    <div className="workbench-agent">
      <LearningChat folder={folder} courseName={courseName} syncId={chatCourseId} name={props.name??'学习者'} onOpenSettings={onOpenSettings} {...props}/>
      {paletteOpen ? <CommandPalette /> : null}
    </div>
  );
}
