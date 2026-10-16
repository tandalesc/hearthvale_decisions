// 60-point sparkline as inline SVG (design-visual §8.4): 96×20, 1.5 px
// stroke, 12 % fill under the line, no axes, a dot on the latest value.

export function sparkline(series, {width = 96, height = 20} = {}) {
  const values = (series ?? []).filter(Number.isFinite);
  if (values.length < 2) return `<svg class="spark" viewBox="0 0 ${width} ${height}" aria-hidden="true"></svg>`;
  let min = Math.min(...values), max = Math.max(...values);
  if (max - min < 1e-9) { min -= 1; max += 1; }
  const pad = 2;
  const x = (i) => (i / (values.length - 1)) * width;
  const y = (v) => pad + (1 - (v - min) / (max - min)) * (height - pad * 2);
  let line = '';
  values.forEach((v, i) => { line += `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`; });
  const area = `${line}L${width} ${height}L0 ${height}Z`;
  const last = values[values.length - 1];
  return `<svg class="spark" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true"><path class="area" d="${area}"/><path class="line" d="${line}"/><circle cx="${width}" cy="${y(last).toFixed(1)}" r="1.8"/></svg>`;
}

// The larger variant: a yearly series of percentages over the whole history,
// with a dashed line at the halfway mark and the range and years as labels.
// points: [{y: year, v: 0..100}]. Stretches to its box's width.
export function historyChart(points, {height = 76, guide = 50} = {}) {
  const pts = (points ?? []).filter((p) => Number.isFinite(p?.v));
  if (pts.length < 2) return '';
  const width = 300;
  const vs = pts.map((p) => p.v);
  // A range of at least twenty points around the values (and the guide when near).
  let lo = Math.max(0, Math.floor((Math.min(...vs) - 4) / 10) * 10);
  let hi = Math.min(100, Math.ceil((Math.max(...vs) + 4) / 10) * 10);
  if (hi - lo < 20) { const mid = (hi + lo) / 2; lo = Math.max(0, Math.round(mid - 10)); hi = Math.min(100, lo + 20); }
  const pad = 3;
  const x = (i) => (i / (pts.length - 1)) * width;
  const y = (v) => pad + (1 - (v - lo) / (hi - lo)) * (height - pad * 2);
  let line = '';
  pts.forEach((p, i) => { line += `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p.v).toFixed(1)}`; });
  const area = `${line}L${width} ${height}L0 ${height}Z`;
  const g = guide > lo && guide < hi ? `<path class="guide" d="M0 ${y(guide).toFixed(1)}H${width}"/>` : '';
  return `<div class="hchart" style="--h:${height}px">
    <span class="hchart-hi">${hi}%</span><span class="hchart-lo">${lo}%</span>
    <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">${g}<path class="area" d="${area}"/><path class="line" d="${line}"/></svg>
    <i class="hchart-dot" style="top:${y(pts.at(-1).v).toFixed(1)}px"></i>
    <span class="hchart-from">Year ${pts[0].y}</span><span class="hchart-to">Year ${pts.at(-1).y}</span>
  </div>`;
}
