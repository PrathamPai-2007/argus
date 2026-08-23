export interface CandidateMetrics {
  liquidityUsd: number | null;
  volumeUsd: number;
  poolAgeHours: number | null;
  earlyBuyerCount: number;
  retainedBuyerCount: number;
  independentBuyerCount: number;
  exchangeBuyerCount: number;
  commonFunderRatio: number;
  minimumLiquidityUsd: number;
  minimumIndependentBuyers: number;
}

export interface CandidateScore {
  score: number;
  eligible: boolean;
  evidence: Record<string, unknown>;
}

const clamp = (value: number, min = 0, max = 100): number => Math.max(min, Math.min(max, value));

/**
 * Score evidence, not popularity. Volume is deliberately capped at 10% so a
 * wash-traded token cannot win without independent early buyers.
 */
export function scoreCandidate(metrics: CandidateMetrics): CandidateScore {
  const liquidity = metrics.liquidityUsd === null
    ? 0
    : clamp((Math.log10(Math.max(1, metrics.liquidityUsd)) - 4) * 25);
  const volume = clamp(Math.log10(Math.max(1, metrics.volumeUsd)) * 10, 0, 100);
  const earlyBuyers = clamp(metrics.earlyBuyerCount * 12.5);
  const retained = metrics.earlyBuyerCount === 0 ? 0 : clamp((metrics.retainedBuyerCount / metrics.earlyBuyerCount) * 100);
  const independent = clamp(metrics.independentBuyerCount * 20);
  const age = metrics.poolAgeHours === null ? 0 : metrics.poolAgeHours <= 48 ? 100 : clamp(100 - (metrics.poolAgeHours - 48) * 2);
  const exchangePenalty = clamp(metrics.exchangeBuyerCount * 15);
  const funderPenalty = clamp(metrics.commonFunderRatio * 100);
  const score = Math.round(clamp(
    liquidity * 0.15 + volume * 0.10 + earlyBuyers * 0.25 + retained * 0.15 + independent * 0.25 + age * 0.10
      - exchangePenalty * 0.10 - funderPenalty * 0.20,
  ));
  const eligible = (metrics.liquidityUsd ?? 0) >= metrics.minimumLiquidityUsd
    && metrics.independentBuyerCount >= metrics.minimumIndependentBuyers
    && metrics.earlyBuyerCount >= metrics.minimumIndependentBuyers
    && metrics.commonFunderRatio < 0.75;
  return {
    score,
    eligible,
    evidence: {
      liquidityUsd: metrics.liquidityUsd,
      volumeUsd: metrics.volumeUsd,
      poolAgeHours: metrics.poolAgeHours,
      earlyBuyerCount: metrics.earlyBuyerCount,
      retainedBuyerCount: metrics.retainedBuyerCount,
      independentBuyerCount: metrics.independentBuyerCount,
      exchangeBuyerCount: metrics.exchangeBuyerCount,
      commonFunderRatio: metrics.commonFunderRatio,
      components: { liquidity, volume, earlyBuyers, retained, independent, age, exchangePenalty, funderPenalty },
    },
  };
}
