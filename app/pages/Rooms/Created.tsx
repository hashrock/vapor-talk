import { Head, Link } from "@inertiajs/react";
import { useEffect } from "react";
import { Logo } from "../../components/Logo";
import { useCopy } from "../../lib/clipboard";
import { saveManageKey } from "../../lib/manageKeys";
import { formatDateTime } from "../../lib/format";

interface Props {
  room: { id: string; name: string; url: string; expiresAt: string; maxParticipants: number };
  manageKey: string;
}

export default function Created({ room, manageKey }: Props) {
  useEffect(() => saveManageKey(room.id, manageKey), [room.id, manageKey]);

  return (
    <div className="mx-auto max-w-xl px-6 py-10">
      <Head title={`${room.name} を作成しました`} />
      <Logo />
      <div className="mt-10 rounded-2xl border border-white/10 bg-slate-900/80 p-6">
        <p className="text-sm text-emerald-400">ルームを作成しました</p>
        <h1 className="mt-1 text-2xl font-semibold">{room.name}</h1>
        <p className="mt-1 text-sm text-slate-400">
          {formatDateTime(room.expiresAt)} まで・最大 {room.maxParticipants} 人
        </p>

        <CopyField label="招待 URL（参加者に共有）" value={room.url} />
        <CopyField label="管理キー（ルームの削除に使います。このページでしか表示されません）" value={manageKey} secret />

        <Link
          href={`/r/${room.id}`}
          className="mt-8 block w-full rounded-lg bg-violet-600 py-3 text-center font-medium transition hover:bg-violet-500"
        >
          ルームに入る
        </Link>
      </div>
    </div>
  );
}

function CopyField({ label, value, secret }: { label: string; value: string; secret?: boolean }) {
  const [copied, copy] = useCopy();
  return (
    <div className="mt-6">
      <span className="text-sm text-slate-400">{label}</span>
      <div className="mt-1.5 flex gap-2">
        <input
          readOnly
          value={value}
          onFocus={(e) => e.target.select()}
          className={`min-w-0 flex-1 rounded-lg border border-white/10 bg-slate-950 px-3 py-2 text-sm ${secret ? "font-mono text-amber-200" : ""}`}
        />
        <button
          type="button"
          onClick={() => copy(value)}
          className="shrink-0 rounded-lg border border-white/10 px-3 text-sm hover:bg-white/5"
        >
          {copied ? "コピー済み" : "コピー"}
        </button>
      </div>
    </div>
  );
}
