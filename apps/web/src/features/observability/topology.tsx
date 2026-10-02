import '@xyflow/react/dist/style.css';
import { Background, type Edge, type Node, Position, ReactFlow } from '@xyflow/react';
import type { FlowStats } from '@/api/types';

/** Topology view (clients, gateway, servers) drawn with xyflow; lazy loaded by the Observability page. */
export default function Topology({ flow }: { flow: FlowStats }) {
  const nodes: Node[] = [
    ...flow.clients.map((c, i) => ({
      id: `c-${c}`,
      position: { x: 0, y: i * 64 },
      data: { label: c },
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      style: {
        background: 'var(--surface)',
        color: 'var(--ink)',
        border: '1px solid var(--line-strong)',
        borderRadius: 10,
        fontSize: 12,
        width: 130,
      },
    })),
    {
      id: 'gw',
      position: { x: 240, y: Math.max(0, (flow.clients.length * 64) / 2 - 48) },
      data: { label: 'Bastion gateway' },
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      style: {
        background: 'var(--tangerine-soft)',
        color: 'var(--tangerine-ink)',
        border: '1px solid var(--tangerine)',
        borderRadius: 10,
        fontSize: 13,
        fontWeight: 600,
        width: 150,
      },
    },
    ...flow.installations.map((s, i) => ({
      id: `s-${s.id}`,
      position: { x: 500, y: i * 56 },
      data: { label: `${s.name}${s.errorRate > 0.1 ? ' (failing)' : ''}` },
      targetPosition: Position.Left,
      style: {
        background: s.errorRate > 0.1 ? 'var(--coral-soft)' : 'var(--mint-soft)',
        color: s.errorRate > 0.1 ? 'var(--coral-ink)' : 'var(--mint-ink)',
        border: '1px solid transparent',
        borderRadius: 10,
        fontSize: 12,
        width: 170,
      },
    })),
  ];
  const edges: Edge[] = [
    ...flow.clients.map((c) => ({
      id: `e-${c}`,
      source: `c-${c}`,
      target: 'gw',
      animated: false,
      style: { stroke: 'var(--line-strong)' },
    })),
    ...flow.installations.map((s) => ({
      id: `e-${s.id}`,
      source: 'gw',
      target: `s-${s.id}`,
      style: {
        stroke: s.errorRate > 0.1 ? 'var(--coral)' : 'var(--sky)',
        strokeWidth: 1 + Math.min(6, s.calls / 120),
      },
    })),
  ];
  return (
    <div
      style={{ height: 340 }}
      role="img"
      aria-label="Topology of clients, the gateway and servers. Use the table view for exact numbers."
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        fitView
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        zoomOnScroll={false}
        panOnDrag={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background color="var(--chart-grid)" />
      </ReactFlow>
    </div>
  );
}
