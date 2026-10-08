import { CandlestickSeries, ColorType, createChart, createSeriesMarkers, HistogramSeries, type IChartApi, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@/lib/api.ts";
import { price } from "@/lib/format.ts";
import type { Candle } from "@/lib/types.ts";
import { Segmented, Skeleton } from "./ui.tsx";

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const TF = [{ value: "15", label: "15s" }, { value: "60", label: "1m" }, { value: "300", label: "5m" }, { value: "900", label: "15m" }] as const;

export function PriceChart({ chainId, token, markers }: { chainId: number; token: string; markers: Array<{ time: number; label: string; kind: "alert" | "exit" }> }) {
  const [tf, setTf] = useState<(typeof TF)[number]["value"]>("60");
  const { data } = useQuery<{ candles: Candle[]; priceScale: string }>(`/api/tokens/${chainId}/${token}/candles?tf=${tf}`, { refreshMs: 10_000 });
  const host = useRef<HTMLDivElement>(null);
  const chart = useRef<{ api: IChartApi; candles: ISeriesApi<"Candlestick">; volume: ISeriesApi<"Histogram"> } | null>(null);

  useEffect(() => {
    if (!host.current) return;
    const api = createChart(host.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: css("--muted"), fontFamily: "IBM Plex Sans", fontSize: 11, attributionLogo: false },
      grid: { vertLines: { visible: false }, horzLines: { color: css("--line") } },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: tf === "15" },
      crosshair: { horzLine: { labelBackgroundColor: css("--raised") }, vertLine: { labelBackgroundColor: css("--raised") } },
    });
    const candles = api.addSeries(CandlestickSeries, {
      upColor: css("--gain"), downColor: css("--loss"), wickUpColor: css("--gain"), wickDownColor: css("--loss"), borderVisible: false,
      priceFormat: { type: "custom", formatter: (p: number) => price(p), minMove: 1e-18 },
    });
    const volume = api.addSeries(HistogramSeries, { priceScaleId: "", priceFormat: { type: "volume" }, color: css("--line") });
    volume.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    chart.current = { api, candles, volume };
    return () => {
      api.remove();
      chart.current = null;
    };
  }, [tf]);

  useEffect(() => {
    const c = chart.current;
    if (!c || !data) return;
    c.candles.setData(data.candles.map((k) => ({ time: k.time as UTCTimestamp, open: k.open, high: k.high, low: k.low, close: k.close })));
    c.volume.setData(data.candles.map((k) => ({ time: k.time as UTCTimestamp, value: k.volume, color: k.close >= k.open ? `${css("--gain")}55` : `${css("--loss")}55` })));
    const step = Number(tf);
    createSeriesMarkers(c.candles, markers
      .map((m) => ({ time: (m.time - (m.time % step)) as UTCTimestamp, position: m.kind === "alert" ? "belowBar" as const : "aboveBar" as const, shape: m.kind === "alert" ? "arrowUp" as const : "arrowDown" as const, color: m.kind === "alert" ? css("--amber") : css("--loss"), text: m.label }))
      .sort((a, b) => a.time - b.time));
  }, [data, markers, tf]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-4 pt-3">
        <p className="text-[12.5px] text-muted">{data?.priceScale === "raw-unit" ? "Price per raw unit (decimals unknown)" : "Price in USD"}</p>
        <Segmented label="Timeframe" value={tf} onChange={setTf} options={[...TF]} />
      </div>
      <div className="relative min-h-[280px] flex-1">
        {!data && <Skeleton className="absolute inset-4" />}
        {data && data.candles.length === 0 && <p className="absolute inset-0 flex items-center justify-center text-[13px] text-muted">No trades in the last 24 hours.</p>}
        <div ref={host} className="absolute inset-0 px-2 pb-2" />
      </div>
    </div>
  );
}
