import { Background, Handle, Position, ReactFlow, type Edge, type Node, type NodeProps } from "@xyflow/react";
import { useMemo } from "react";
import { cn, shortAddr } from "@/lib/format.ts";
import type { GraphData } from "@/lib/types.ts";
import { Tip } from "./ui.tsx";

type WalletNode = Node<{ address: string; kind: GraphData["nodes"][number]["kind"]; pct: number | null; groupSize: number }, "wallet">;

const KIND_LABEL: Record<string, string> = { holder: "Holder", buyer: "Buyer", exited: "Sold out", creator: "Creator", funder: "Funder" };

function WalletDot({ data }: NodeProps<WalletNode>) {
  const size = data.kind === "funder" ? 18 : Math.round(10 + Math.min(26, (data.pct ?? 0) * 2.2));
  return (
    <Tip content={<span><b>{KIND_LABEL[data.kind]}</b> {shortAddr(data.address)}{data.pct !== null ? ` · ${data.pct.toFixed(2)}% of supply` : ""}{data.groupSize > 1 ? ` · cluster of ${data.groupSize}` : ""}</span>}>
      <div
        className={cn(
          "rounded-full border-2 transition-transform hover:scale-125",
          data.kind === "creator" && "border-loss bg-loss/40",
          data.kind === "funder" && "border-amber bg-bg",
          data.kind === "holder" && "border-text/70 bg-text/25",
          data.kind === "buyer" && "border-muted bg-muted/20",
          data.kind === "exited" && "border-faint bg-transparent opacity-70",
        )}
        style={{ width: size, height: size }}
      >
        <Handle type="target" position={Position.Top} className="!opacity-0" />
        <Handle type="source" position={Position.Bottom} className="!opacity-0" />
      </div>
    </Tip>
  );
}

const nodeTypes = { wallet: WalletDot };

/** Rings of commonly-funded wallets (funder at the centre), then a band of independents. */
function layout(g: GraphData): { nodes: WalletNode[]; edges: Edge[] } {
  const firstChild = new Map<string, string>();
  for (const e of g.edges) if (!firstChild.has(e.source)) firstChild.set(e.source, e.target);
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const groupOf = (n: GraphData["nodes"][number]) => (n.kind === "funder" ? byId.get(firstChild.get(n.id) ?? "")?.cluster ?? n.cluster : n.cluster);
  const groups = new Map<string, GraphData["nodes"]>();
  for (const n of g.nodes) groups.set(groupOf(n), [...(groups.get(groupOf(n)) ?? []), n]);
  const weight = (ns: GraphData["nodes"]) => ns.reduce((s, n) => s + (n.pct ?? 0), 0) + ns.length * 0.01;
  const clusters = [...groups.values()].filter((ns) => ns.filter((n) => n.kind !== "funder").length > 1).sort((a, b) => weight(b) - weight(a));
  const singles = [...groups.values()].filter((ns) => ns.filter((n) => n.kind !== "funder").length <= 1).flat();

  const nodes: WalletNode[] = [];
  const cols = 3;
  const cell = 280;
  clusters.forEach((ns, i) => {
    const cx = (i % cols) * cell;
    const cy = Math.floor(i / cols) * cell;
    const members = ns.filter((n) => n.kind !== "funder");
    const center = ns.find((n) => n.kind === "funder");
    const r = 50 + members.length * 6;
    if (center) nodes.push({ id: center.id, type: "wallet", position: { x: cx, y: cy }, data: { address: center.id, kind: center.kind, pct: center.pct, groupSize: members.length } });
    members.forEach((n, j) => {
      const a = (j / members.length) * Math.PI * 2;
      nodes.push({ id: n.id, type: "wallet", position: { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r }, data: { address: n.id, kind: n.kind, pct: n.pct, groupSize: members.length } });
    });
  });
  const top = Math.ceil(clusters.length / cols) * cell + (clusters.length ? 0 : 0);
  singles.forEach((n, i) => {
    nodes.push({ id: n.id, type: "wallet", position: { x: (i % 14) * 56 - 60, y: top + Math.floor(i / 14) * 56 }, data: { address: n.id, kind: n.kind, pct: n.pct, groupSize: 1 } });
  });
  const edges: Edge[] = g.edges.map((e) => ({
    id: `${e.source}-${e.target}`,
    source: e.source,
    target: e.target,
    style: { stroke: e.service ? "var(--faint)" : "var(--amber)", strokeOpacity: e.service ? 0.35 : 0.55, strokeDasharray: e.service ? "3 4" : undefined, strokeWidth: 1.2 },
  }));
  return { nodes, edges };
}

export function FundingGraph({ data, onSelect }: { data: GraphData; onSelect: (address: string) => void }) {
  const { nodes, edges } = useMemo(() => layout(data), [data]);
  const clusters = new Set(data.nodes.filter((n) => n.kind !== "funder").map((n) => n.cluster)).size;
  if (data.nodes.length === 0) return <p className="px-4 py-10 text-center text-[13px] text-muted">No holders or buyers observed yet.</p>;
  return (
    <div className="relative h-[380px]">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        nodesDraggable={false}
        nodesConnectable={false}
        minZoom={0.3}
        maxZoom={2.5}
        proOptions={{ hideAttribution: true }}
        onNodeClick={(_e, n) => onSelect(n.id)}
      >
        <Background gap={24} size={1} color="var(--line)" />
      </ReactFlow>
      <div className="pointer-events-none absolute bottom-3 left-4 flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-muted">
        <span><i className="mr-1.5 inline-block size-2 rounded-full bg-loss/60" />creator</span>
        <span><i className="mr-1.5 inline-block size-2 rounded-full border border-amber" />funder</span>
        <span><i className="mr-1.5 inline-block h-px w-4 bg-amber align-middle" />shared funding</span>
        <span><i className="mr-1.5 inline-block w-4 border-t border-dashed border-faint align-middle" />exchange-funded</span>
        <span>{clusters} independent group{clusters === 1 ? "" : "s"}</span>
      </div>
    </div>
  );
}
