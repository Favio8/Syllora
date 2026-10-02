'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { SlideCanvas } from '@openmaic/renderer';
import { slideToPng } from '@openmaic/renderer/snapshot';
import { workbenchRpc } from '../features/workbench/services';
import { exportDecksToPptx } from '../features/workbench/slide-export';

/**
 * 幻灯片讲义：按章节读取 `slides.json`，用 `@openmaic/renderer` 的只读画布渲染。
 *
 * 设计取舍：
 * - 只读视图，编辑能力（`@openmaic/editor`）不在本轮范围；
 * - 读不到幻灯片（未开启该特性、创建于该特性之前的旧 revision、或该批整理失败）时，
 *   显示一句说明而不是报错——幻灯片是讲义的附加产物，不该把阅读器变成错误页；
 * - 每页仍显示它依据的来源锚点，沿用与讲义同一套"引用可回溯"的规则。
 */

export interface SlideDeckView {
  chapter: string;
  scenes: Array<{
    id: string;
    title: string;
    order: number;
    citations: string[];
    content: { type: 'slide'; canvas: unknown };
  }>;
}

interface SourceRef { id: string; anchor: string }

export default function SlideDeckReader({ courseId, sources }: { courseId: string; sources: SourceRef[] }) {
  const [decks, setDecks] = useState<SlideDeckView[] | null>(null);
  const [error, setError] = useState('');
  const [deckIndex, setDeckIndex] = useState(0);
  const [sceneIndex, setSceneIndex] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');

  useEffect(() => {
    let alive = true;
    setDecks(null); setError(''); setDeckIndex(0); setSceneIndex(0);
    void (async () => {
      try {
        const result = await workbenchRpc<{ revision: string | null; decks: SlideDeckView[] }>('slides', { courseId });
        if (alive) setDecks(result.decks ?? []);
      } catch (cause) {
        if (alive) setError(cause instanceof Error ? cause.message : '读取幻灯片失败');
      }
    })();
    return () => { alive = false; };
  }, [courseId]);

  const anchors = useMemo(() => new Map(sources.map(source => [source.id, source.anchor])), [sources]);
  const deck = decks?.[deckIndex];
  const scene = deck?.scenes[sceneIndex];
  const ordered = useMemo(() => (deck ? [...deck.scenes].sort((a, b) => a.order - b.order) : []), [deck]);
  const move = useCallback((delta: number) => {
    setSceneIndex(current => {
      const next = current + delta;
      if (next < 0 || !deck || next >= ordered.length) return current;
      return next;
    });
  }, [deck, ordered.length]);

  /** 导出当前页为 PNG：复用渲染器自带的幻灯片快照能力，不自己截 DOM。 */
  const exportPng = useCallback(async () => {
    if (!scene || !deck) return;
    setExporting(true); setExportError('');
    try {
      const result = await slideToPng(scene.content.canvas as never);
      const url = typeof result === 'string' ? result : URL.createObjectURL(result);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${deck.chapter}-第${sceneIndex + 1}页.png`;
      link.click();
      if (typeof result !== 'string') setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (cause) {
      setExportError(cause instanceof Error ? cause.message : '导出失败');
    } finally { setExporting(false); }
  }, [deck, scene, sceneIndex]);

  /** 导出全部章节为一份 PPTX（布局按画布坐标映射）。 */
  const exportPptx = useCallback(async () => {
    if (!decks || decks.length === 0) return;
    setExporting(true); setExportError('');
    try {
      await exportDecksToPptx(decks, 'syllora-幻灯片.pptx');
    } catch (cause) {
      setExportError(cause instanceof Error ? cause.message : '导出失败');
    } finally { setExporting(false); }
  }, [decks]);

  if (error) return <p role="alert" className="sy-muted">{error}</p>;
  if (decks === null) return <p className="sy-muted">正在读取幻灯片…</p>;
  if (decks.length === 0) {
    return (
      <p className="sy-muted">
        这一版没有幻灯片讲义。幻灯片需要在配置里显式开启（<code>ui.slides: true</code>）后重新初始化；
        已有的 Markdown 讲义不受影响。
      </p>
    );
  }

  const atStart = sceneIndex <= 0;
  const atEnd = sceneIndex >= ordered.length - 1;

  return (
    <div className="sy-slides" aria-label="幻灯片讲义">
      <div className="sy-slides-toolbar">
        <label>
          章节
          <select
            aria-label="选择幻灯片章节"
            value={deckIndex}
            onChange={event => { setDeckIndex(Number(event.target.value)); setSceneIndex(0); }}
          >
            {decks.map((item, index) => <option key={`${item.chapter}-${index}`} value={index}>{item.chapter}</option>)}
          </select>
        </label>
        <span className="sy-muted">第 {sceneIndex + 1} / {ordered.length} 页</span>
        <button type="button" disabled={atStart} onClick={() => move(-1)}>上一页</button>
        <button type="button" disabled={atEnd} onClick={() => move(1)}>下一页</button>
        <button type="button" disabled={exporting || !scene} onClick={() => void exportPng()}>{exporting ? '导出中…' : '导出本页 PNG'}</button>
        <button type="button" disabled={exporting} onClick={() => void exportPptx()}>导出全部 PPTX</button>
      </div>
      {exportError && <p role="alert" className="sy-muted">导出失败：{exportError}</p>}

      {scene ? (
        <>
          <div className="sy-slide-canvas" data-testid="slide-canvas">
            {/* 画布由 DSL 契约约束（尺寸与元素坐标都在 1000×562 内），校验在写入 revision 前完成。 */}
            <SlideCanvas slide={scene.content.canvas as never} />
          </div>
          <p className="sy-muted">
            原文依据：
            {scene.citations.map(id => anchors.get(id) ?? id).join('、')}
          </p>
        </>
      ) : <p className="sy-muted">这一章没有可用页面。</p>}
    </div>
  );
}
