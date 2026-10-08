export function Sparkline({ points, width = 96, height = 28 }: { points: number[]; width?: number; height?: number }) {
  if (points.length < 2) return <div style={{ width, height }} className="flex items-center text-[11px] text-faint">no trades</div>;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || max || 1;
  const step = width / (points.length - 1);
  const d = points.map((p, i) => `${i ? "L" : "M"}${(i * step).toFixed(1)},${(height - 2 - ((p - min) / span) * (height - 4)).toFixed(1)}`).join(" ");
  const up = points[points.length - 1]! >= points[0]!;
  const color = up ? "var(--gain)" : "var(--loss)";
  return (
    <svg width={width} height={height} aria-hidden className="overflow-visible">
      <path d={`${d} L${width},${height} L0,${height} Z`} fill={color} opacity={0.08} />
      <path d={d} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
