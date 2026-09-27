import { Head, Link, router } from "@inertiajs/react";
import { useState } from "react";
import { Header } from "../../components/Header";
import { LinkIcon, TrashIcon } from "../../components/icons";
import { useCopy } from "../../lib/clipboard";
import { formatDateTime } from "../../lib/format";

interface RoomItem {
  id: string;
  name: string;
  url: string;
  maxParticipants: number;
  expiresAt: string;
}

export default function Index({ rooms }: { rooms: RoomItem[] }) {
  return (
    <div className="min-h-screen">
      <Head title="マイルーム" />
      <Header />
      <main className="mx-auto max-w-3xl px-6 pb-24">
        <div className="mt-6 flex items-center justify-between">
          <h1 className="text-2xl font-semibold">マイルーム</h1>
          <Link href="/" className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium hover:bg-violet-500">
            新しいルーム
          </Link>
        </div>
        {rooms.length === 0 ? (
          <p className="mt-16 text-center text-slate-400">有効なルームはありません。</p>
        ) : (
          <ul className="mt-6 divide-y divide-white/5 rounded-2xl border border-white/10 bg-slate-900/60">
            {rooms.map((room) => (
              <RoomRow key={room.id} room={room} />
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}

function RoomRow({ room }: { room: RoomItem }) {
  const [copied, copy] = useCopy();
  const [confirming, setConfirming] = useState(false);
  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <Link href={`/r/${room.id}`} className="block truncate font-medium hover:text-violet-300">
          {room.name}
        </Link>
        <p className="text-xs text-slate-500">
          {formatDateTime(room.expiresAt)} まで・最大 {room.maxParticipants} 人
        </p>
      </div>
      <button
        onClick={() => copy(room.url)}
        className="flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-1.5 text-sm hover:bg-white/5"
      >
        <LinkIcon className="size-4" />
        {copied ? "コピーしました" : "招待リンク"}
      </button>
      {confirming ? (
        <span className="flex items-center gap-1 text-sm">
          <button onClick={() => router.delete(`/rooms/${room.id}`)} className="rounded-lg bg-rose-600 px-3 py-1.5 hover:bg-rose-500">
            削除
          </button>
          <button onClick={() => setConfirming(false)} className="px-2 py-1.5 text-slate-400 hover:text-slate-200">
            やめる
          </button>
        </span>
      ) : (
        <button onClick={() => setConfirming(true)} title="ルームを削除" className="rounded-lg p-2 text-slate-400 hover:bg-white/5 hover:text-rose-300">
          <TrashIcon className="size-4" />
        </button>
      )}
    </li>
  );
}
