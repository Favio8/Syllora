/**
 * 学习模式切换：虚拟课堂 / 对话学习 / 辅助阅读 / 笔记。
 * 顶栏与笔记页头部共用同一份实现，保证"进笔记后这组按键仍然固定可见"。
 * 四个按键不带图标、等宽居中（样式见 features/workbench/integrated.css 的 .learning-mode-switch）。
 */
export type LearningSurface = 'classroom' | 'chat' | 'reading' | 'notes';

export default function LearningModeSwitch({ disabled, current, onSelect }: {
  disabled: boolean;
  current: LearningSurface;
  onSelect: (surface: LearningSurface) => void;
}) {
  const items: Array<{ id: LearningSurface; label: string }> = [
    { id: 'classroom', label: '虚拟课堂' },
    { id: 'chat', label: '对话学习' },
    { id: 'reading', label: '辅助阅读' },
    { id: 'notes', label: '笔记' },
  ];
  return (
    <div className="learning-mode-switch" role="group" aria-label="学习模式">
      {items.map(item => (
        <button
          key={item.id}
          disabled={disabled}
          aria-pressed={current === item.id}
          title={disabled ? '请先打开一门课程' : item.label}
          onClick={() => onSelect(item.id)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
