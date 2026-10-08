export function mean(values) {
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}
