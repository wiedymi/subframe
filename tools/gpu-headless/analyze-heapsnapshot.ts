import { readFileSync } from "node:fs";

type JsonObject = Record<string, any>;

type Edge = {
  from: number;
  name: string;
  type: string;
};

type ClassRow = {
  cls: string;
  bytes: number;
  count: number;
  sample: string;
};

type LayerBitmapSample = {
  bytes: number;
  bufferNode: number;
  ownerNode: number;
  viewNode: number;
  ownerClass: string;
  width?: string;
  height?: string;
  stride?: string;
  gpuFilter: boolean;
  clip: boolean;
  root: string;
};

function bytesToMiB(bytes: number): number {
  return bytes / (1024 * 1024);
}

function edgeName(snapshot: JsonObject, edgeType: string, nameOrIndex: number): string {
  if (edgeType === "element" || edgeType === "hidden") return `#${nameOrIndex}`;
  return String(snapshot.strings?.[nameOrIndex] ?? nameOrIndex);
}

function classify(chain: string): string {
  const c = chain.toLowerCase();
  if (c.includes("object memory.") || c.includes("webassembly.memory")) return "WebAssembly.Memory backing store";
  if (c.includes("arenafreelist")) return "worker arena freelist";
  if (c.includes("sabarena")) return "SAB arena slot";
  if (c.includes(".fillmask") || c.includes(".outlinemask") || c.includes(".sourceMask".toLowerCase()) || c.includes(".gpufilter")) {
    return "GPU-deferred source masks";
  }
  if (c.includes("blurscratcha") || c.includes("blurscratchb")) return "libass blur scratch";
  if (c.includes("renderaheadplayer") || (c.includes(".buffer") && c.includes(".result"))) return "render-ahead buffered result";
  if (c.includes("boundaryslots") || c.includes("lastframededup")) return "pipeline boundary/dedup holder";
  if (c.includes("lastrenderedresult") || c.includes("lastreturnedresult")) return "pipeline last-returned holder";
  if (c.includes(".layers") || c.includes(".bitmap") || c.includes(".mask") || c.includes(".image")) return "materialized layer buffers";
  if (c.includes("font")) return "font source/cache";
  if (c.includes("worker") && c.includes("message")) return "worker message/structured clone";
  if (c.includes("arraybuffer") || c.includes("typedarray") || c.includes("uint8array") || c.includes("int16array")) return "typed-array backing store";
  return "other backing store";
}

function analyze(path: string): void {
  const snapshot = JSON.parse(readFileSync(path, "utf8")) as JsonObject;
  const meta = snapshot.snapshot?.meta;
  const nodes = snapshot.nodes as number[];
  const edges = snapshot.edges as number[];
  const strings = snapshot.strings as string[];
  if (!meta || !Array.isArray(nodes) || !Array.isArray(edges) || !Array.isArray(strings)) {
    throw new Error(`invalid heap snapshot: ${path}`);
  }

  const nodeFields = meta.node_fields as string[];
  const edgeFields = meta.edge_fields as string[];
  const nodeTypes = meta.node_types?.[0] as string[];
  const edgeTypes = meta.edge_types?.[0] as string[];
  const nf = nodeFields.length;
  const ef = edgeFields.length;
  const nType = nodeFields.indexOf("type");
  const nName = nodeFields.indexOf("name");
  const nSelf = nodeFields.indexOf("self_size");
  const nEdgeCount = nodeFields.indexOf("edge_count");
  const eType = edgeFields.indexOf("type");
  const eName = edgeFields.indexOf("name_or_index");
  const eTo = edgeFields.indexOf("to_node");
  const nodeCount = (nodes.length / nf) | 0;
  const incoming: Array<Edge[] | undefined> = new Array(nodeCount);
  let edgeCursor = 0;
  for (let i = 0; i < nodeCount; i++) {
    const count = nodes[i * nf + nEdgeCount]!;
    for (let j = 0; j < count; j++) {
      const edgeOff = edgeCursor + j * ef;
      const to = (edges[edgeOff + eTo]! / nf) | 0;
      const type = edgeTypes[edges[edgeOff + eType]!] ?? "";
      const name = edgeName(snapshot, type, edges[edgeOff + eName]!);
      (incoming[to] ??= []).push({ from: i, name, type });
    }
    edgeCursor += count * ef;
  }

  const nodeName = (idx: number) => strings[nodes[idx * nf + nName]!] ?? "";
  const nodeType = (idx: number) => nodeTypes[nodes[idx * nf + nType]!] ?? "";
  const nodeSelf = (idx: number) => nodes[idx * nf + nSelf] ?? 0;
  const describeEdge = (edge: Edge): string => `${nodeType(edge.from)} ${nodeName(edge.from)}.${edge.name}`;

  function outgoingProp(idx: number, prop: string): number | null {
    const start = 0;
    let cursor = 0;
    for (let i = 0; i < idx; i++) cursor += (nodes[i * nf + nEdgeCount] ?? 0) * ef;
    const count = nodes[idx * nf + nEdgeCount] ?? 0;
    for (let j = 0; j < count; j++) {
      const off = cursor + j * ef;
      const type = edgeTypes[edges[off + eType]!] ?? "";
      const name = edgeName(snapshot, type, edges[off + eName]!);
      if (name === prop) return (edges[off + eTo]! / nf) | 0;
    }
    void start;
    return null;
  }

  function nodeValue(idx: number | null): string | undefined {
    if (idx === null) return undefined;
    const type = nodeType(idx);
    const name = nodeName(idx);
    if (type === "number" || type === "string" || type === "hidden") return name;
    return `${type} ${name}`;
  }

  function bitmapOwnerClass(ownerNode: number): string {
    const incomingToOwner = incoming[ownerNode] ?? [];
    for (let i = 0; i < incomingToOwner.length; i++) {
      if (incomingToOwner[i]!.name === "clip") return "clip mask bitmap";
    }
    if (outgoingProp(ownerNode, "color") !== null || outgoingProp(ownerNode, "z") !== null) {
      return "layer bitmap";
    }
    return "other object.bitmap";
  }

  function rootChainFor(idx: number): string {
    type Q = { idx: number; chain: string; depth: number };
    const seen = new Set<number>([idx]);
    const start = `${nodeType(idx)} ${nodeName(idx)}`;
    const queue: Q[] = [{ idx, chain: start, depth: 0 }];
    let fallback = start;
    for (let q = 0; q < queue.length && q < 1500; q++) {
      const cur = queue[q]!;
      const cls = classify(cur.chain);
      if (
        cur.depth > 2 &&
        (cls === "render-ahead buffered result" ||
          cls === "pipeline boundary/dedup holder" ||
          cls === "pipeline last-returned holder" ||
          cls === "worker arena freelist" ||
          cls === "SAB arena slot" ||
          cls === "GPU-deferred source masks" ||
          cls === "libass blur scratch" ||
          cls === "font source/cache")
      ) {
        return cur.chain;
      }
      if (cur.depth >= 14) {
        if (fallback === start) fallback = cur.chain;
        continue;
      }
      const ins = incoming[cur.idx] ?? [];
      for (let i = 0; i < ins.length; i++) {
        const edge = ins[i]!;
        if (edge.type === "weak") continue;
        if (seen.has(edge.from)) continue;
        seen.add(edge.from);
        queue.push({
          idx: edge.from,
          chain: `${cur.chain} <- ${describeEdge(edge)}`,
          depth: cur.depth + 1,
        });
      }
    }
    return fallback;
  }

  function directChainFor(idx: number): string {
    const backing = `${nodeType(idx)} ${nodeName(idx)}`;
    const first = (incoming[idx] ?? []).filter((edge) => edge.type !== "weak");
    const interesting: string[] = [];
    for (let i = 0; i < first.length; i++) {
      const a = first[i]!;
      const aText = `${backing} <- ${describeEdge(a)}`;
      const second = (incoming[a.from] ?? []).filter((edge) => edge.type !== "weak");
      for (let j = 0; j < second.length; j++) {
        const b = second[j]!;
        const bText = `${aText} <- ${describeEdge(b)}`;
        const third = (incoming[b.from] ?? []).filter((edge) => edge.type !== "weak");
        for (let k = 0; k < third.length; k++) {
          const c = third[k]!;
          const cText = `${bText} <- ${describeEdge(c)}`;
          const cls = classify(cText);
          if (cls !== "typed-array backing store" && cls !== "other backing store") interesting.push(cText);
        }
        const cls = classify(bText);
        if (cls !== "typed-array backing store" && cls !== "other backing store") interesting.push(bText);
      }
      const cls = classify(aText);
      if (cls !== "typed-array backing store" && cls !== "other backing store") interesting.push(aText);
    }
    if (interesting.length > 0) return interesting.sort((a, b) => classify(a).localeCompare(classify(b)))[0]!;
    return first[0] ? `${backing} <- ${describeEdge(first[0]!)}` : backing;
  }

  const rows = new Map<string, ClassRow>();
  const rootRows = new Map<string, ClassRow>();
  const top: Array<{ bytes: number; chain: string; cls: string }> = [];
  const layerBitmapSamples: LayerBitmapSample[] = [];
  const layerBitmapHistogram = new Map<string, { bytes: number; refs: number; buffers: Set<number> }>();
  const distinctLayerBitmapBuffers = new Set<number>();
  let layerBitmapRefs = 0;
  let total = 0;
  let count = 0;
  for (let i = 0; i < nodeCount; i++) {
    const self = nodeSelf(i);
    if (self < 64 * 1024) continue;
    const type = nodeType(i);
    const name = nodeName(i);
    const lower = name.toLowerCase();
    const looksLikeBacking =
      type === "native" ||
      lower.includes("arraybuffer") ||
      lower.includes("backing") ||
      lower.includes("typedarray") ||
      lower.includes("uint8array");
    if (!looksLikeBacking) continue;
    const chain = directChainFor(i);
    const cls = classify(chain);
    const rootChain = rootChainFor(i);
    const rootCls = classify(rootChain);
    if (chain.includes("Object.bitmap")) {
      const incomingToBacking = incoming[i] ?? [];
      for (let a = 0; a < incomingToBacking.length; a++) {
        const arrayBufferEdge = incomingToBacking[a]!;
        if (arrayBufferEdge.type === "weak") continue;
        const incomingToBuffer = incoming[arrayBufferEdge.from] ?? [];
        for (let b = 0; b < incomingToBuffer.length; b++) {
          const viewEdge = incomingToBuffer[b]!;
          if (viewEdge.type === "weak" || viewEdge.name !== "buffer") continue;
          const incomingToView = incoming[viewEdge.from] ?? [];
          for (let c = 0; c < incomingToView.length; c++) {
            const layerEdge = incomingToView[c]!;
            if (layerEdge.type === "weak" || layerEdge.name !== "bitmap") continue;
            const ownerNode = layerEdge.from;
            const ownerClass = bitmapOwnerClass(ownerNode);
            layerBitmapRefs++;
            distinctLayerBitmapBuffers.add(i);
            const width = nodeValue(outgoingProp(ownerNode, "width"));
            const height = nodeValue(outgoingProp(ownerNode, "height"));
            const stride = nodeValue(outgoingProp(ownerNode, "stride"));
            const gpuFilter = outgoingProp(ownerNode, "gpuFilter") !== null;
            const clip = outgoingProp(ownerNode, "clip") !== null;
            const key = self < 1024 * 1024
              ? `${ownerClass} <1MiB`
              : self < 2 * 1024 * 1024
                ? `${ownerClass} 1-2MiB`
                : self < 4 * 1024 * 1024
                  ? `${ownerClass} 2-4MiB`
                  : self < 8 * 1024 * 1024
                    ? `${ownerClass} 4-8MiB`
                    : `${ownerClass} >=8MiB`;
            const hist = layerBitmapHistogram.get(key) ?? { bytes: 0, refs: 0, buffers: new Set<number>() };
            hist.refs++;
            if (!hist.buffers.has(i)) {
              hist.buffers.add(i);
              hist.bytes += self;
            }
            layerBitmapHistogram.set(key, hist);
            layerBitmapSamples.push({
              bytes: self,
              bufferNode: i,
              ownerNode,
              viewNode: viewEdge.from,
              ownerClass,
              width,
              height,
              stride,
              gpuFilter,
              clip,
              root: rootChain,
            });
          }
        }
      }
    }
    total += self;
    count++;
    const row = rows.get(cls) ?? { cls, bytes: 0, count: 0, sample: chain };
    row.bytes += self;
    row.count++;
    if (chain.length < row.sample.length) row.sample = chain;
    rows.set(cls, row);
    const rootRow = rootRows.get(rootCls) ?? { cls: rootCls, bytes: 0, count: 0, sample: rootChain };
    rootRow.bytes += self;
    rootRow.count++;
    if (rootChain.length < rootRow.sample.length) rootRow.sample = rootChain;
    rootRows.set(rootCls, rootRow);
    top.push({ bytes: self, chain, cls });
  }

  console.log(`\n${path}`);
  console.log(`large backing: ${bytesToMiB(total).toFixed(1)} MiB, nodes ${count}`);
  console.log("direct holder classes:");
  for (const row of [...rows.values()].sort((a, b) => b.bytes - a.bytes).slice(0, 12)) {
    console.log(`  ${bytesToMiB(row.bytes).toFixed(1)} MiB  n=${row.count}  ${row.cls}  sample=${row.sample.slice(0, 180)}`);
  }
  console.log("root holder classes:");
  for (const row of [...rootRows.values()].sort((a, b) => b.bytes - a.bytes).slice(0, 12)) {
    console.log(`  ${bytesToMiB(row.bytes).toFixed(1)} MiB  n=${row.count}  ${row.cls}  sample=${row.sample.slice(0, 220)}`);
  }
  console.log("largest direct holder nodes:");
  for (const row of top.sort((a, b) => b.bytes - a.bytes).slice(0, 12)) {
    console.log(`  ${bytesToMiB(row.bytes).toFixed(1)} MiB  ${row.cls}  ${row.chain.slice(0, 220)}`);
  }
  if (layerBitmapRefs > 0) {
    console.log("object.bitmap backing histogram:");
    for (const [key, row] of [...layerBitmapHistogram.entries()].sort((a, b) => b[1].bytes - a[1].bytes)) {
      console.log(`  ${key}: refs=${row.refs} distinctBuffers=${row.buffers.size} bytes=${bytesToMiB(row.bytes).toFixed(1)} MiB`);
    }
    console.log(`  totalRefs=${layerBitmapRefs} distinctBuffers=${distinctLayerBitmapBuffers.size}`);
    console.log("largest layer.bitmap samples:");
    for (const sample of layerBitmapSamples.sort((a, b) => b.bytes - a.bytes).slice(0, 10)) {
      const dims = `${sample.width ?? "?"}x${sample.height ?? "?"}/stride ${sample.stride ?? "?"}`;
      console.log(
        `  ${bytesToMiB(sample.bytes).toFixed(1)} MiB  owner=${sample.ownerClass} dims=${dims} gpu=${sample.gpuFilter ? 1 : 0} clip=${sample.clip ? 1 : 0} root=${sample.root.slice(0, 220)}`,
      );
    }
  }
}

const paths = process.argv.slice(2);
if (paths.length === 0) {
  console.error("usage: bun run tools/gpu-headless/analyze-heapsnapshot.ts <snapshot...>");
  process.exit(2);
}
for (const path of paths) analyze(path);
