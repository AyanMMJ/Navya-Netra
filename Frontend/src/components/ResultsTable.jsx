// src/components/ResultsTable.jsx
export default function ResultsTable({ picked = [], answerKey = [] }) {
  if (!picked.length) return null;
  return (
    <div className="rounded-xl border p-4 bg-white">
      <h4 className="font-semibold mb-3">Per-question Results</h4>
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="border-b bg-gray-50">
            <tr>
              <th className="text-left py-2 pr-6">#</th>
              <th className="text-left py-2 pr-6">Picked</th>
              <th className="text-left py-2 pr-6">Answer</th>
              <th className="text-left py-2 pr-6">Status</th>
            </tr>
          </thead>
          <tbody>
            {picked.map((p, i) => {
              const ok = answerKey[i] === p;
              return (
                <tr key={i} className="border-b last:border-0">
                  <td className="py-2 pr-6">{i + 1}</td>
                  <td className="py-2 pr-6">{p}</td>
                  <td className="py-2 pr-6">{answerKey[i]}</td>
                  <td className="py-2 pr-6" style={{ color: ok ? "#16a34a" : "#ef4444" }}>
                    {ok ? "✓ Correct" : "✗ Wrong"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
