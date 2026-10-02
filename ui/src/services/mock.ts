import { initialWorkspace } from '@/mocks/workspace';
import type { Course, WorkspaceData, WorkspaceService } from '@/types';
import { courseIcons } from '@/lib/courseIcons';
import { dayKey } from '@/lib/activity';

const STORAGE_KEY = 'syllora-ui.workspace.v1';
let memory: WorkspaceData | null = null;
const copy = <T,>(value: T): T => structuredClone(value);
const id = () => crypto.randomUUID();

function read(): WorkspaceData {
  if (memory) return memory;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const saved = JSON.parse(raw) as WorkspaceData;
      if (saved.version === 1 && Array.isArray(saved.courses) && saved.preferences && saved.courses.every(c => Array.isArray(c.tasks) && Array.isArray(c.points) && Array.isArray(c.messages) && Array.isArray(c.materials))) {
        memory = { ...saved, activity: saved.activity ?? copy(initialWorkspace.activity ?? []) };
        return memory;
      }
    }
  } catch { /* 浏览器禁用存储或旧数据不可读时，使用内存演示。 */ }
  memory = copy(initialWorkspace);
  return memory;
}

function write(update: (data: WorkspaceData) => void): WorkspaceData {
  const data = copy(read());
  update(data);
  // 存储失败时明确报错，避免把未持久化的操作显示为已保存。
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  memory = data;
  return copy(data);
}

function course(data: WorkspaceData, courseId: string): Course {
  const target = data.courses.find(c => c.id === courseId);
  if (!target) throw new Error('找不到这门课程，请重新选择课程。');
  return target;
}

function demoReply(target: Course, input: string): string {
  if (/计划|安排/.test(input)) return `可以把「${target.name}」拆成三个小步骤：\n\n1. 花 5 分钟回顾上一次的概念。\n2. 围绕「${target.tasks.find(t => !t.completed)?.title ?? target.chapter}」做一次专注学习。\n3. 留出 5 分钟，用自己的话复述并记录疑问。\n\n右侧的学习计划可以标记完成，帮助你看见今天的进展。`;
  if (/题|练习|检验/.test(input)) {
    if (target.id === 'linear-algebra') return '试试这道小题：\n\n已知向量 a = (1, 2)，b = (2, 4)。这两个向量线性相关吗？为什么？\n\n提示：观察 b 能否写成 a 的倍数。先说出你的判断，再给出理由。';
    if (target.id === 'probability') return '试试这道小题：\n\n一枚公平硬币投掷两次，已知至少有一次正面，两次都是正面的概率是多少？\n\n先列出满足已知条件的所有等可能结果，再数一数目标结果。';
    return '试试这道小题：\n\n写一个函数 square(n)，返回 n 的平方。\n\n想一想：如果把 return 换成 print，调用这个函数后得到的返回值会有什么变化？';
  }
  if (target.id === 'linear-algebra') return '我们从「新的方向」来理解线性相关。\n\n假设 a = (1, 2)，b = (2, 4)。因为 b = 2a，b 只是把 a 拉长了两倍，方向没有变化。\n\n所以这两个向量线性相关。换成 c = (2, 1)，它无法由 a 单独缩放得到，就带来了新的方向。\n\n你可以试着解释：为什么 (3, 6) 也没有带来新的方向？';
  if (target.id === 'probability') return '条件概率，就是把已知的信息作为新的观察范围。\n\nP(A | B) = P(A ∩ B) / P(B)，其中 P(B) > 0。\n\n先把范围缩小到 B，再看其中有多大比例也满足 A。画一张集合图，通常会更容易理解。';
  return '函数把一段可以重复使用的逻辑包在一起。\n\n参数是输入，return 是输出。比如 square(n) 接收一个数，返回 n × n。\n\n注意：print 只是把内容显示出来，return 才把结果交给调用者。你可以先写一个小例子比较它们。';
}

export const mockService: WorkspaceService = {
  async load() { return copy(read()); },
  async createCourse(name, icon) {
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 40) throw new Error('课程名称需要为 1–40 个字符。');
    const selectedIcon = courseIcons.find(option => option.id === icon);
    if (!selectedIcon) throw new Error('请选择一个课程图标。');
    return write(data => { data.courses.push({ id: id(), name: trimmed, icon, subtitle: '从一份资料开始你的学习', symbol: '∑', color: selectedIcon.color, chapter: '准备开始学习', tasks: [], points: [], materials: [], messages: [] }); });
  },
  async renameCourse(courseId, name) {
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 40) throw new Error('课程名称需要为 1–40 个字符。');
    return write(data => { course(data, courseId).name = trimmed; });
  },
  async setCourseArchived(courseId, archived) {
    return write(data => { course(data, courseId).archived = archived; });
  },
  async deleteCourse(courseId) {
    return write(data => {
      course(data, courseId);
      data.courses = data.courses.filter(c => c.id !== courseId);
      data.activity = (data.activity ?? []).filter(record => record.courseId !== courseId);
    });
  },
  async toggleTask(courseId, taskId) {
    return write(data => {
      const task = course(data, courseId).tasks.find(t => t.id === taskId);
      if (task) {
        task.completed = !task.completed;
        data.activity = (data.activity ?? []).filter(record => record.taskId !== taskId || record.courseId !== courseId);
        if (task.completed) data.activity.push({ id: id(), date: dayKey(), courseId, taskId, kind: 'task', minutes: task.minutes });
      }
    });
  },
  async addMaterials(courseId, files) {
    return write(data => { course(data, courseId).materials.push(...files.map(file => ({ ...file, id: id(), addedAt: new Date().toLocaleDateString('sv-SE') }))); });
  },
  async removeMaterial(courseId, materialId) {
    return write(data => { const target = course(data, courseId); target.materials = target.materials.filter(m => m.id !== materialId); });
  },
  async appendMessage(courseId, content) {
    return write(data => {
      course(data, courseId).messages.push({ id: id(), role: 'user', content, createdAt: new Date().toISOString() });
      (data.activity ??= []).push({ id: id(), date: dayKey(), courseId, kind: 'chat', minutes: 0 });
    });
  },
  async reply(courseId, content) {
    await new Promise(resolve => setTimeout(resolve, 700));
    return write(data => { const target = course(data, courseId); target.messages.push({ id: id(), role: 'assistant', content: demoReply(target, content), createdAt: new Date().toISOString() }); });
  },
  async savePreferences(preferences) { return write(data => { data.preferences = preferences; }); },
  async saveApiConfig(config) {
    if (!config.model.trim()) throw new Error('请填写模型名称。');
    const url = new URL(config.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('接口地址需要以 http:// 或 https:// 开头。');
    if (!Number.isFinite(config.temperature) || config.temperature < 0 || config.temperature > 2) throw new Error('随机度需要在 0–2 之间。');
    return write(data => { data.apiConfig = { ...config, baseUrl: config.baseUrl.trim(), model: config.model.trim() }; });
  },
  async recordActivity(courseId, kind, minutes = 0) {
    return write(data => {
      course(data, courseId);
      (data.activity ??= []).push({ id: id(), date: dayKey(), courseId, kind, minutes });
    });
  },
  async reset() {
    localStorage.removeItem(STORAGE_KEY);
    try { sessionStorage.removeItem('syllora-ui.api-key'); } catch {}
    memory = copy(initialWorkspace);
    return copy(memory);
  },
};
