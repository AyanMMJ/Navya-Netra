// src/components/ScoreBar.jsx
export default function ScoreBar({ score=0 }) {
  const pct = Math.max(0, Math.min(100, score));
  return (
    <div className="grid gap-2">
      <div className="h-3 rounded-full border bg-gray-100 overflow-hidden">
        <span
          style={{ width: `${pct}%` }}
          className="block h-full"
        />
      </div>
      <div className="text-sm text-gray-700">Score: <b>{pct.toFixed(1)}%</b></div>
      <style>{`
        /* gradient fill (inline) */
        div > span { background: linear-gradient(90deg,#ef4444,#f59e0b,#22c55e); }
      `}</style>
    </div>
  );
}
