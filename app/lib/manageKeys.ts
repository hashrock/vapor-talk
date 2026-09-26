/** このブラウザで作成したルームの管理キー（削除ボタンを出すため）。 */
const KEY = "vapor-talk:manage-keys";

function load(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
}

export function saveManageKey(roomId: string, manageKey: string) {
  localStorage.setItem(KEY, JSON.stringify({ ...load(), [roomId]: manageKey }));
}

export function getManageKey(roomId: string): string | null {
  return load()[roomId] ?? null;
}

export function forgetManageKey(roomId: string) {
  const { [roomId]: _, ...rest } = load();
  localStorage.setItem(KEY, JSON.stringify(rest));
}
