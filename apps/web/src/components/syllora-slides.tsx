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
 * - 读不到幻灯片（未开启该特性、创建于该特性之前的旧 revision、或该章生成失败）时，
 *   显示一句说明而不是报错——幻灯片是讲义的附加产物，不该把阅读器变成错误页；
 * - 依据按**章节**展示：云端不返回 Syllora 的逐页来源，因此这里如实标注"本章依据"，
 *   并给出云端课堂 id 便于追溯是哪次生成产出的。
 */

export interface SlideArtifactView {
  chapter: string;
  /** 云端课堂 id，便于排查某一份幻灯片是哪次云端生成的。 */
  classroomId: string;
  /** 本次生成上传的 Syllora 来源（章节级溯源）。 */
  sourceIds: string[];
  scenes: Array<{
    id: string;
    title: string;
    order: number;
    content: { type: string; canvas: unknown };
  }>;
}

interface SourceRef { id: string; anchor: string }

export default function SlideDeckReader({ courseId, sources }: { courseId: string; sources: SourceRef[] }) {
  const [decks, setDecks] = useState<SlideArtifactView[] | null>(null);
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
        const result = await workbenchRpc<{ revision: string | null; slides: SlideArtifactView[] }>('slides', { courseId });
        if (alive) setDecks(result.slides ?? []);
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
          这一版没有幻灯片讲义。幻灯片需要在 <code>config.yaml</code> 里同时配置
          <code>ui.slides: true</code> 与 <code>cloud</code>（云端地址与访问口令）后重新初始化；
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
            {/* canvas 由云端 OpenMAIC 生成（它写库前已自行校验），本地只负责渲染 */}
            <SlideCanvas slide={scene.content.canvas as never} />
          </div>
          <p className="sy-muted">
            本章依据：
            {deck.sourceIds.length > 0
              ? deck.sourceIds.map(id => anchors.get(id) ?? id).join('、')
              : '（未记录来源）'}
            {deck.classroomId ? <span className="sy-muted"> · 云端课堂 {deck.classroomId}</span> : null}
          </p>
        </>
      ) : <p className="sy-muted">这一章没有可用页面。</p>}
    </div>
  );
}
