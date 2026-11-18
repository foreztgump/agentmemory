export function quantiles(values: number[], points = 101): number[] {
  if (values.length === 0) return [];
  const sorted = Float64Array.from(values).sort();
  const out: number[] = [];
  for (let i = 0; i < points; i++) {
    const rank = (i / (points - 1)) * (sorted.length - 1);
    out.push(sorted[Math.round(rank)]);
  }
  return out;
}

// Inverse-CDF sample from evenly spaced quantiles. The last point (the maximum)
// is excluded so one outlier cannot dominate the mean of the samples.
export function sampleQuantile(q: number[], u: number): number {
  if (q.length === 0) return 0;
  if (q.length < 3) return q[0];
  const pos = u * (q.length - 2);
  const lo = Math.floor(pos);
  const hi = Math.min(q.length - 1, lo + 1);
  return q[lo] + (q[hi] - q[lo]) * (pos - lo);
}

export function histogram(values: number[], edges: number[]): Record<string, number> {
  const out: Record<string, number> = {};
  const labels = edges.map((edge, i) => (i + 1 < edges.length ? `${edge}-${edges[i + 1] - 1}` : `${edge}+`));
  for (const label of labels) out[label] = 0;
  for (const v of values) {
    let i = edges.length - 1;
    while (i > 0 && v < edges[i]) i--;
    out[labels[i]]++;
  }
  return out;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pickWeighted<T extends string>(weights: Record<T, number>, u: number): T {
  const entries = Object.entries(weights) as [T, number][];
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  let target = u * total;
  for (const [key, w] of entries) {
    target -= w;
    if (target < 0) return key;
  }
  return entries[entries.length - 1][0];
}
