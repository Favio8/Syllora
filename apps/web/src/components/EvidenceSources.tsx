'use client';

/** One entry point; distinguish multiple citations by their material and location. */
export default function EvidenceSources({ sourceIds, label, onOpen }: {
  sourceIds: string[];
  label: (id: string) => string;
  onOpen: (id: string) => void;
}) {
  const ids = [...new Set(sourceIds)];
  if (!ids.length) return null;
  if (ids.length === 1) return <button onClick={() => onOpen(ids[0]!)}>查看依据</button>;
  return <details className="sy-evidence-picker">
    <summary>查看依据（{ids.length} 条）</summary>
    <div className="sy-evidence-options">
      {ids.map((id, index) => <button key={id} onClick={() => onOpen(id)}>{index + 1}. {label(id)}</button>)}
    </div>
  </details>;
}
