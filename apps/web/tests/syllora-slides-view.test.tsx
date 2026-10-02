/**
 * 幻灯片视图：渲染画布、空态说明、以及"引用可回溯"的锚点文案。
 * 渲染器需要 ResizeObserver，桩在 apps/web/tests/setup.ts 里统一提供。
 */
import { render, screen, waitFor } from '@testing-library/react';
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

const deck = {
  chapter: '甲章',
  scenes: [
    { id: 's1', title: '要点', order: 0, citations: ['source-a'], content: { type: 'slide' as const, canvas: canvas('幻灯片的正文内容') } },
  ],
};

beforeEach(() => { rpc.mockReset(); });

describe('幻灯片视图', () => {
  it('读取并渲染幻灯片，显示页码与原文依据锚点', async () => {
    rpc.mockResolvedValue({ revision: 'rev-1', decks: [deck] });
    render(<SlideDeckReader courseId="c1" sources={[{ id: 'source-a', anchor: '讲义.md · 行 3–5' }]} />);

    await waitFor(() => expect(screen.getByTestId('slide-canvas')).toBeInTheDocument());
    expect(rpc).toHaveBeenCalledWith('slides', { courseId: 'c1' });
    expect(screen.getByText(/幻灯片的正文内容/)).toBeInTheDocument();
    expect(screen.getByText(/第 1 \/ 1 页/)).toBeInTheDocument();
    // 引用渲染成锚点文案，而不是裸 id。
    expect(screen.getByText(/讲义\.md · 行 3–5/)).toBeInTheDocument();
  });

  it('没有幻灯片时给出说明而不是报错', async () => {
    rpc.mockResolvedValue({ revision: 'rev-1', decks: [] });
    render(<SlideDeckReader courseId="c1" sources={[]} />);
    await waitFor(() => expect(screen.getByText(/这一版没有幻灯片讲义/)).toBeInTheDocument());
    expect(screen.queryByTestId('slide-canvas')).toBeNull();
  });

  it('读取失败时显示错误，不影响其他视图', async () => {
    rpc.mockRejectedValue(new Error('幻灯片读取失败'));
    render(<SlideDeckReader courseId="c1" sources={[]} />);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('幻灯片读取失败'));
  });

  it('引用找不到锚点时退回显示 id，不丢信息', async () => {
    rpc.mockResolvedValue({ revision: 'rev-1', decks: [{ ...deck, scenes: [{ ...deck.scenes[0]!, citations: ['missing-source'] }] }] });
    render(<SlideDeckReader courseId="c1" sources={[]} />);
    await waitFor(() => expect(screen.getByText(/missing-source/)).toBeInTheDocument());
  });
});
