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
