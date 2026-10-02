import type { WorkspaceData } from '@/types';
import { demoActivity } from '@/lib/activity';

export const initialWorkspace: WorkspaceData = {
  version: 1,
  activity: demoActivity(),
  preferences: { name: '同学', dailyMinutes: 40, compact: false },
  courses: [
    {
      id: 'linear-algebra', name: '线性代数', subtitle: '理解空间，也理解变化', symbol: '∑', color: 'blue', chapter: '第三章 · 向量与线性空间',
      tasks: [
        { id: 'l-1', title: '回顾矩阵的基本运算', kind: '复习', minutes: 10, completed: true },
        { id: 'l-2', title: '理解向量的线性相关性', kind: '学习', minutes: 20, completed: false },
        { id: 'l-3', title: '用一道题检验你的理解', kind: '复习', minutes: 10, completed: false },
      ],
      points: [
        { id: 'lp-1', chapter: '第二章', title: '矩阵的运算与性质', state: '已验证' },
        { id: 'lp-2', chapter: '第二章', title: '逆矩阵与初等变换', state: '已验证' },
        { id: 'lp-3', chapter: '第三章', title: '向量的线性相关性', state: '待巩固' },
        { id: 'lp-4', chapter: '第三章', title: '基、维数与坐标', state: '待学习' },
        { id: 'lp-5', chapter: '第四章', title: '特征值与特征向量', state: '待学习' },
      ],
      materials: [
        { id: 'lm-1', name: '线性代数 · 第三章讲义.pdf', size: 2480000, addedAt: '2026-10-01' },
        { id: 'lm-2', name: '课堂笔记 — 向量空间.md', size: 18000, addedAt: '2026-10-01' },
        { id: 'lm-3', name: '第三章习题与思考.pdf', size: 864000, addedAt: '2026-10-02' },
      ],
      messages: [{
        id: 'welcome-linear', role: 'assistant', createdAt: '2026-10-02T09:00:00+08:00',
        content: '今天我们把「线性相关」真正弄明白。\n\n你可以先把向量想成空间中的箭头：如果一个箭头可以由其他箭头组合出来，它就没有带来新的方向。\n\n准备好后，我们从一个二维的小例子开始。',
      }],
    },
    {
      id: 'probability', name: '概率论与数理统计', subtitle: '从不确定性中发现规律', symbol: 'P', color: 'green', chapter: '第二章 · 随机变量',
      tasks: [
        { id: 'p-1', title: '回顾条件概率', kind: '复习', minutes: 15, completed: false },
        { id: 'p-2', title: '理解随机变量与分布', kind: '学习', minutes: 25, completed: false },
      ],
      points: [
        { id: 'pp-1', chapter: '第一章', title: '条件概率', state: '待巩固' },
        { id: 'pp-2', chapter: '第一章', title: '贝叶斯公式', state: '已验证' },
        { id: 'pp-3', chapter: '第二章', title: '随机变量与分布函数', state: '待学习' },
      ],
      materials: [{ id: 'pm-1', name: '概率论课程讲义.pdf', size: 3400000, addedAt: '2026-10-01' }],
      messages: [{ id: 'welcome-probability', role: 'assistant', createdAt: '2026-10-02T09:00:00+08:00', content: '欢迎回到概率论。今天从条件概率开始，把已知的信息和我们想求的概率分清楚。\n\n你想回顾一个概念，还是先做一道练习？' }],
    },
    {
      id: 'python', name: 'Python 程序设计', subtitle: '把想法写成可以运行的代码', symbol: '</>', color: 'orange', chapter: '第四章 · 函数与模块',
      tasks: [{ id: 'py-1', title: '理解函数参数与返回值', kind: '学习', minutes: 20, completed: false }, { id: 'py-2', title: '练习列表推导式', kind: '复习', minutes: 15, completed: true }],
      points: [{ id: 'pyp-1', chapter: '第三章', title: '列表与字典', state: '已验证' }, { id: 'pyp-2', chapter: '第四章', title: '函数与作用域', state: '待巩固' }, { id: 'pyp-3', chapter: '第四章', title: '模块与导入', state: '待学习' }],
      materials: [{ id: 'pym-1', name: 'Python 函数课堂笔记.md', size: 24000, addedAt: '2026-10-01' }],
      messages: [{ id: 'welcome-python', role: 'assistant', createdAt: '2026-10-02T09:00:00+08:00', content: '一段好的函数，只需要把一件事做好。\n\n今天我们一起梳理参数、返回值和作用域，再写一个小函数把它们串起来。' }],
    },
  ],
};
