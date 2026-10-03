/**
 * 幻灯片视图：渲染画布、空态说明、章节级依据文案，以及两个导出入口。
 *
 * 生成在云端，视图只消费已归一化的产物，因此 mock 的响应形状与 `slides` 读取接口一致：
 * `{ revision, slides: [{ chapter, classroomId, sourceIds, scenes }] }`。
 * 渲染器需要 ResizeObserver，桩在 apps/web/tests/setup.ts 里统一提供。
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.fn();
vi.mock('../src/features/workbench/services', () => ({
  workbenchRpc: (action: string, payload: unknown) => rpc(action, payload),
}));

import SlideDeckReader from '../src/components/syllora-slides';

const canvas = (text: string) => ({
  id: 'canvas-1',
  viewportSize: 1000,
  viewportRatio: 0.5625,
  theme: { backgroundColor: '#ffffff', themeColors: ['#002fa7'], fontColor: '#202128', fontName: 'sans-serif' },
  elements: [
    {
      type: 'text', id: 't1', left: 60, top: 40, width: 880, height: 120, rotate: 0,
      content: `<p>${text}</p>`, defaultFontName: 'sans-serif', defaultColor: '#202128',
    },
  ],
});

const slide = (overrides: Record<string, unknown> = {}) => ({
  chapter: '甲章',
  classroomId: 'cls_abc',
  sourceIds: ['source-a'],
  scenes: [
    { id: 's1', title: '要点', order: 0, content: { type: 'slide', canvas: canvas('幻灯片的正文内容') } },
  ],
  ...overrides,
});

beforeEach(() => { rpc.mockReset(); });

describe('幻灯片视图', () => {
  it('读取并渲染幻灯片，显示页码与本章依据', async () => {
    rpc.mockResolvedValue({ revision: 'rev-1', slides: [slide()] });
    render(<SlideDeckReader courseId="c1" sources={[{ id: 'source-a', anchor: '讲义.md · 行 3–5' }]} />);

    await waitFor(() => expect(screen.getByTestId('slide-canvas')).toBeInTheDocument());
    expect(rpc).toHaveBeenCalledWith('slides', { courseId: 'c1' });
    expect(screen.getByText(/幻灯片的正文内容/)).toBeInTheDocument();
    expect(screen.getByText(/第 1 \/ 1 页/)).toBeInTheDocument();
    // 依据按章节展示：渲染成锚点文案而不是裸 id
    expect(screen.getByText(/讲义\.md · 行 3–5/)).toBeInTheDocument();
    // 云端课堂 id 一并显示，便于追溯是哪次云端生成
    expect(screen.getByText(/cls_abc/)).toBeInTheDocument();
  });

  it('没有幻灯片时给出说明而不是报错', async () => {
    rpc.mockResolvedValue({ revision: 'rev-1', slides: [] });
    render(<SlideDeckReader courseId="c1" sources={[]} />);
    await waitFor(() => expect(screen.getByText(/这一版没有幻灯片讲义/)).toBeInTheDocument());
    expect(screen.queryByTestId('slide-canvas')).toBeNull();
  });

  it('读取失败时显示错误，不影响其他视图', async () => {
    rpc.mockRejectedValue(new Error('幻灯片读取失败'));
    render(<SlideDeckReader courseId="c1" sources={[]} />);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('幻灯片读取失败'));
  });

  it('依据找不到锚点时退回显示 id，不丢信息', async () => {
    rpc.mockResolvedValue({ revision: 'rev-1', slides: [slide({ sourceIds: ['missing-source'] })] });
    render(<SlideDeckReader courseId="c1" sources={[]} />);
    await waitFor(() => expect(screen.getByText(/missing-source/)).toBeInTheDocument());
  });

  it('未记录来源时如实说明，而不是显示空段落', async () => {
    rpc.mockResolvedValue({ revision: 'rev-1', slides: [slide({ sourceIds: [] })] });
    render(<SlideDeckReader courseId="c1" sources={[]} />);
    await waitFor(() => expect(screen.getByText(/未记录来源/)).toBeInTheDocument());
  });

  it('提供 PNG 与 PPTX 两个导出入口', async () => {
    rpc.mockResolvedValue({ revision: 'rev-1', slides: [slide()] });
    render(<SlideDeckReader courseId="c1" sources={[]} />);
    await waitFor(() => expect(screen.getByTestId('slide-canvas')).toBeInTheDocument());

    expect(screen.getByRole('button', { name: /导出本页 PNG/ })).toBeEnabled();
    const pptx = screen.getByRole('button', { name: /导出全部 PPTX/ });
    expect(pptx).toBeEnabled();

    fireEvent.click(pptx);
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });
});
