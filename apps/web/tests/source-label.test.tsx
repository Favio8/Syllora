import { describe, expect, it } from 'vitest';
import { sourceLabel } from '../src/components/Syllora';

/**
 * 来源弹层的标题必须"资料名 + 精确定位"，且两者都从文件名派生时不能重复。
 * 例如 `sources/讲义.md · 讲义.md · 行 3–5 · 字符 45–120` 是回归目标。
 */
describe('sourceLabel', () => {
  it('prepends the material name to the precise anchor', () => {
    expect(sourceLabel({ anchor: '第 3 页 · 行 2–5 · 字符 40–120' }, 'sources/讲义.pdf')).toBe(
      'sources/讲义.pdf · 第 3 页 · 行 2–5 · 字符 40–120',
    );
  });

  it('does not repeat the material name when the anchor already carries it', () => {
    expect(sourceLabel({ anchor: 'sources/讲义.md · 行 3–5 · 字符 45–120' }, 'sources/讲义.md')).toBe(
      'sources/讲义.md · 行 3–5 · 字符 45–120',
    );
  });

  it('falls back to the anchor when the material is unknown', () => {
    expect(sourceLabel({ anchor: '第 1 页 · 字符 1–9' })).toBe('第 1 页 · 字符 1–9');
  });
});
