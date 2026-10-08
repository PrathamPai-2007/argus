import { motion, useReducedMotion } from "motion/react";
import type { Verdict } from "@/lib/types.ts";
import { VERDICT_LABEL } from "@/lib/format.ts";

// The score as an eye — Argus Panoptes, the hundred-eyed watcher. The arc
// fills with the score, the amber brightens with conviction, and a critical
// risk breaks the ring.

export function Iris({ score, verdict, size = 40, showLabel = true }: { score: number; verdict: Verdict; size?: number; showLabel?: boolean }) {
  const reduce = useReducedMotion();
  const stroke = Math.max(2.5, size / 14);
  const r = size / 2 - stroke;
  const c = 2 * Math.PI * r;
  const avoid = verdict === "avoid";
  const strong = verdict === "high_conviction";
  const fill = avoid ? 1 : Math.max(0.02, score / 100);
  const glow = 0.35 + 0.65 * (score / 100);
  const spring = reduce ? { duration: 0 } : { type: "spring" as const, stiffness: 120, damping: 20 };

  return (
    <div className="relative shrink-0" style={{ width: size, height: size }} role="img" aria-label={`${VERDICT_LABEL[verdict]}, score ${score} of 100`}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
        {strong && (
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--amber)" strokeWidth={stroke * 2.6} opacity={0.14} style={{ filter: `blur(${size / 16}px)` }} />
        )}
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--line)" strokeWidth={stroke} />
        <motion.circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={avoid ? "var(--loss)" : "var(--amber)"}
          strokeWidth={stroke}
          strokeLinecap={avoid ? "butt" : "round"}
          strokeDasharray={avoid ? `${c / 14} ${c / 28}` : c}
          initial={false}
          animate={{ strokeDashoffset: avoid ? 0 : c * (1 - fill), opacity: avoid ? 0.9 : glow }}
          transition={spring}
        />
        {strong && size >= 56 && (
          <motion.circle cx={size / 2} cy={size / 2} fill="var(--amber)" initial={false} animate={{ r: size * (0.05 + 0.06 * (score / 100)), opacity: 0.18 }} transition={spring} />
        )}
      </svg>
      {showLabel && (
        <span
          className="num absolute inset-0 flex items-center justify-center font-semibold"
          style={{ fontSize: Math.max(11, size * 0.3), color: avoid ? "var(--loss)" : score >= 60 ? "var(--text)" : "var(--muted)" }}
        >
          {score}
        </span>
      )}
    </div>
  );
}
