export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** 残り時間を「2時間15分」「45分」のように表す。 */
export function formatRemaining(ms: number): string {
  if (ms <= 0) return "0分";
  const min = Math.ceil(ms / 60_000);
  if (min < 60) return `${min}分`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h}時間${min % 60 ? `${min % 60}分` : ""}`;
  return `${Math.floor(h / 24)}日`;
}
