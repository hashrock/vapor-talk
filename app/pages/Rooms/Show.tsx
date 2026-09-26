import { Head, Link } from "@inertiajs/react";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { CallSession, type CallState, type EndReason } from "../../client/callSession";
import type { Participant } from "../../domain/protocol";
import { DISPLAY_NAME_MAX } from "../../domain/room";
import { Logo } from "../../components/Logo";
import { LinkIcon, MicIcon, MicOffIcon, PhoneOffIcon, ScreenIcon, TrashIcon, UsersIcon, VolumeIcon } from "../../components/icons";
import { useCopy } from "../../lib/clipboard";
import { formatRemaining } from "../../lib/format";
import { forgetManageKey, getManageKey } from "../../lib/manageKeys";

interface RoomProps {
  id: string;
  name: string;
  url: string;
  maxParticipants: number;
  guestAccess: boolean;
  expiresAt: string;
}

interface Props {
  room: RoomProps;
  invite: { token: string; valid: boolean; name: string | null } | null;
}

const NAME_KEY = "vapor-talk:name";

export default function Show({ room, invite }: Props) {
  const [session, setSession] = useState<CallSession | null>(null);

  useEffect(() => () => session?.leave(), [session]);
  useEffect(() => {
    if (!session) return;
    const onUnload = () => session.leave();
    window.addEventListener("pagehide", onUnload);
    return () => window.removeEventListener("pagehide", onUnload);
  }, [session]);

  return (
    <>
      <Head title={room.name} />
      {session ? (
        <Call room={room} session={session} onRejoin={() => setSession(null)} />
      ) : (
        <Lobby
          room={room}
          invite={invite}
          onJoin={(name) => {
            const s = new CallSession(room.id, name, invite?.valid ? invite.token : null);
            setSession(s);
            void s.start();
          }}
        />
      )}
    </>
  );
}

// --- Lobby ---

function Lobby({ room, invite, onJoin }: { room: RoomProps; invite: Props["invite"]; onJoin: (name: string) => void }) {
  const fixedName = invite?.valid ? invite.name : null;
  const [name, setName] = useState(fixedName ?? "");
  useEffect(() => {
    if (!fixedName) setName(localStorage.getItem(NAME_KEY) ?? "");
  }, [fixedName]);

  const blocked = invite ? !invite.valid : !room.guestAccess;
  const canJoin = !blocked && name.trim().length > 0;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canJoin) return;
    if (!fixedName) localStorage.setItem(NAME_KEY, name.trim());
    onJoin(name.trim());
  };

  return (
    <div className="flex min-h-screen flex-col bg-[radial-gradient(ellipse_at_top,_rgb(124_58_237/0.2),_transparent_60%)]">
      <header className="mx-auto w-full max-w-5xl px-6 py-5">
        <Logo />
      </header>
      <main className="flex flex-1 items-center justify-center px-6 pb-24">
        <form onSubmit={submit} className="w-full max-w-sm rounded-2xl border border-white/10 bg-slate-900/80 p-6 shadow-2xl shadow-violet-950/40">
          <p className="text-sm text-slate-400">ボイスチャットに参加</p>
          <h1 className="mt-1 text-2xl font-semibold break-words">{room.name}</h1>
          <p className="mt-1 text-xs text-slate-500">残り {formatRemaining(Date.parse(room.expiresAt) - Date.now())}・最大 {room.maxParticipants} 人</p>

          {blocked ? (
            <p className="mt-6 rounded-lg bg-rose-500/10 px-3 py-2.5 text-sm text-rose-300">
              {invite ? "招待トークンが無効か、有効期限が切れています。" : "このルームは招待制です。招待 URL から参加してください。"}
            </p>
          ) : (
            <>
              <label htmlFor="display-name" className="mt-6 block text-sm text-slate-400">
                表示名
              </label>
              <input
                id="display-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                readOnly={!!fixedName}
                maxLength={DISPLAY_NAME_MAX}
                autoFocus={!fixedName}
                placeholder="名前を入力"
                className="mt-1.5 w-full rounded-lg border border-white/10 bg-slate-950 px-3 py-2.5 outline-none read-only:text-slate-400 focus:border-violet-500"
              />
              <button
                type="submit"
                disabled={!canJoin}
                className="mt-6 flex w-full items-center justify-center gap-2 rounded-lg bg-violet-600 py-3 font-medium transition hover:bg-violet-500 disabled:opacity-40"
              >
                <MicIcon /> 参加する
              </button>
              <p className="mt-3 text-center text-xs text-slate-500">参加するとマイクの使用許可を求められます</p>
            </>
          )}
        </form>
      </main>
    </div>
  );
}

// --- Call ---

const END_MESSAGES: Record<EndReason, string> = {
  left: "通話から退出しました",
  "room-full": "ルームが満員です",
  "room-deleted": "ルームは削除されました",
  "room-expired": "ルームの有効期限が切れました",
  replaced: "別のタブで同じ参加者が接続しました",
  error: "接続できませんでした",
};

function Call({ room, session, onRejoin }: { room: RoomProps; session: CallSession; onRejoin: () => void }) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const [showList, setShowList] = useState(false);
  const manageKey = useMemo(() => getManageKey(room.id), [room.id]);

  if (state.status === "ended") {
    const canRejoin = state.endReason === "left" || state.endReason === "error" || state.endReason === "replaced";
    return (
      <div className="flex min-h-screen flex-col items-center justify-center px-6 text-center">
        <h1 className="text-2xl font-semibold">{END_MESSAGES[state.endReason ?? "left"]}</h1>
        {state.error && <p className="mt-3 max-w-md text-sm text-slate-400">{state.error}</p>}
        <div className="mt-8 flex gap-3">
          {canRejoin && (
            <button onClick={onRejoin} className="rounded-lg bg-violet-600 px-5 py-2.5 font-medium hover:bg-violet-500">
              もう一度参加する
            </button>
          )}
          <Link href="/" className="rounded-lg border border-white/10 px-5 py-2.5 hover:bg-white/5">
            トップへ
          </Link>
        </div>
      </div>
    );
  }

  const others = state.participants.filter((p) => p.id !== state.selfId);
  const shares = state.participants.filter((p) => state.media[p.id]?.screen);

  return (
    <div className="flex h-dvh flex-col">
      <TopBar room={room} state={state} />

      <div className="flex min-h-0 flex-1">
        <main className="min-w-0 flex-1 p-3 md:p-4">
          {state.status === "joining" ? (
            <div className="flex h-full items-center justify-center text-slate-400">接続しています…</div>
          ) : shares.length > 0 ? (
            <Stage state={state} shares={shares} session={session} />
          ) : (
            <Grid state={state} session={session} />
          )}
        </main>
        <aside className={`${showList ? "flex" : "hidden"} w-72 shrink-0 flex-col border-l border-white/10 bg-slate-900/60 lg:flex`}>
          <ParticipantList state={state} session={session} />
        </aside>
      </div>

      <Controls
        state={state}
        session={session}
        showList={showList}
        onToggleList={() => setShowList((v) => !v)}
        manageKey={manageKey}
        roomId={room.id}
      />

      {others.map((p) => (
        <AudioSink key={p.id} media={state.media[p.id]} volume={state.volumes[p.id] ?? 1} />
      ))}
    </div>
  );
}

function TopBar({ room, state }: { room: RoomProps; state: CallState }) {
  const [copied, copy] = useCopy();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const remaining = Date.parse(state.expiresAt ?? room.expiresAt) - now;

  return (
    <header className="flex items-center gap-3 border-b border-white/10 px-4 py-3">
      <div className="min-w-0 flex-1">
        <h1 className="truncate font-semibold">{room.name}</h1>
        <p className="text-xs text-slate-500">
          {state.participants.length} / {room.maxParticipants} 人・残り {formatRemaining(remaining)}
          {state.status === "reconnecting" && <span className="ml-2 text-amber-400">再接続中…</span>}
        </p>
      </div>
      {room.guestAccess && (
        <button
          onClick={() => copy(room.url)}
          className="flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-1.5 text-sm hover:bg-white/5"
        >
          <LinkIcon className="size-4" />
          {copied ? "コピーしました" : "招待リンク"}
        </button>
      )}
    </header>
  );
}

function Grid({ state, session }: { state: CallState; session: CallSession }) {
  const n = state.participants.length;
  const cols = n <= 1 ? "grid-cols-1" : n <= 4 ? "grid-cols-2" : n <= 9 ? "grid-cols-2 sm:grid-cols-3" : "grid-cols-3 sm:grid-cols-4 xl:grid-cols-5";
  return (
    <div className={`grid h-full auto-rows-fr gap-3 ${cols}`}>
      {state.participants.map((p) => (
        <Tile key={p.id} p={p} self={p.id === state.selfId} session={session} />
      ))}
    </div>
  );
}

function Tile({ p, self, session, compact }: { p: Participant; self: boolean; session: CallSession; compact?: boolean }) {
  return (
    <div
      className={`relative flex min-h-24 flex-col items-center justify-center rounded-2xl border border-white/5 bg-slate-900 ${
        compact ? "h-24 w-32 shrink-0" : ""
      }`}
    >
      <Avatar p={p} session={session} className={compact ? "size-10 text-base" : "size-16 text-2xl"} />
      <div className="absolute inset-x-2 bottom-2 flex items-center justify-center gap-1 text-xs text-slate-300">
        {p.muted && <MicOffIcon className="size-3.5 shrink-0 text-rose-400" />}
        <span className="truncate">{displayName(p, self)}</span>
      </div>
    </div>
  );
}

function Stage({ state, shares, session }: { state: CallState; shares: Participant[]; session: CallSession }) {
  const [selected, setSelected] = useState<string | null>(null);
  const current = shares.find((p) => p.id === selected) ?? shares[0];
  const stream = state.media[current.id]?.screen;

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="relative min-h-0 flex-1 overflow-hidden rounded-2xl bg-black">
        {stream && <Video stream={stream} />}
        <span className="absolute left-3 top-3 rounded-md bg-black/60 px-2 py-1 text-xs">
          {displayName(current, current.id === state.selfId)} の画面
        </span>
      </div>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {shares.length > 1 &&
          shares.map((p) => (
            <button
              key={`share-${p.id}`}
              onClick={() => setSelected(p.id)}
              className={`h-24 shrink-0 rounded-2xl border px-4 text-xs ${
                p.id === current.id ? "border-violet-500 bg-violet-500/10" : "border-white/10 bg-slate-900"
              }`}
            >
              <ScreenIcon className="mx-auto mb-1 size-5" />
              {p.name}
            </button>
          ))}
        {state.participants.map((p) => (
          <Tile key={p.id} p={p} self={p.id === state.selfId} session={session} compact />
        ))}
      </div>
    </div>
  );
}

function Video({ stream }: { stream: MediaStream }) {
  return <video ref={bindStream(stream)} autoPlay playsInline muted className="size-full object-contain" />;
}

function AudioSink({ media, volume }: { media: CallState["media"][string] | undefined; volume: number }) {
  return (
    <>
      {media?.mic && <Audio stream={media.mic} volume={volume} />}
      {media?.["screen-audio"] && <Audio stream={media["screen-audio"]} volume={volume} />}
    </>
  );
}

function Audio({ stream, volume }: { stream: MediaStream; volume: number }) {
  return (
    <audio
      ref={(el) => {
        bindStream(stream)(el);
        if (el) el.volume = volume;
      }}
      autoPlay
    />
  );
}

function bindStream(stream: MediaStream) {
  return (el: HTMLMediaElement | null) => {
    if (el && el.srcObject !== stream) el.srcObject = stream;
  };
}

function ParticipantList({ state, session }: { state: CallState; session: CallSession }) {
  return (
    <>
      <h2 className="flex items-center gap-2 border-b border-white/10 px-4 py-3 text-sm font-medium">
        <UsersIcon className="size-4" /> 参加者 {state.participants.length}
      </h2>
      <ul className="flex-1 overflow-y-auto p-2">
        {state.participants.map((p) => {
          const self = p.id === state.selfId;
          const volume = state.volumes[p.id] ?? 1;
          return (
            <li key={p.id} className="rounded-lg px-2 py-2 hover:bg-white/[0.03]">
              <div className="flex items-center gap-2.5">
                <Avatar p={p} session={session} className="size-8 shrink-0 text-sm" />
                <span className="min-w-0 flex-1 truncate text-sm">{displayName(p, self)}</span>
                {p.tracks.some((t) => t.kind === "screen") && <ScreenIcon className="size-4 text-sky-400" />}
                {p.muted ? <MicOffIcon className="size-4 text-rose-400" /> : <MicIcon className="size-4 text-slate-500" />}
              </div>
              {!self && (
                <label className="mt-1.5 flex items-center gap-2 pl-10 text-xs text-slate-500">
                  <VolumeIcon className="size-3.5 shrink-0" />
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={Math.round(volume * 100)}
                    onChange={(e) => session.setVolume(p.id, Number(e.target.value) / 100)}
                    aria-label={`${p.name} の音量`}
                    className="volume min-w-0 flex-1"
                  />
                  <span className="w-8 text-right tabular-nums">{Math.round(volume * 100)}</span>
                </label>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}

function Controls({
  state,
  session,
  showList,
  onToggleList,
  manageKey,
  roomId,
}: {
  state: CallState;
  session: CallSession;
  showList: boolean;
  onToggleList: () => void;
  manageKey: string | null;
  roomId: string;
}) {
  const canShare = typeof navigator !== "undefined" && !!navigator.mediaDevices?.getDisplayMedia;
  const [confirmDelete, setConfirmDelete] = useState(false);

  const deleteRoom = async () => {
    const res = await fetch(`/api/v1/rooms/${roomId}`, { method: "DELETE", headers: { Authorization: `Bearer ${manageKey}` } });
    if (res.ok || res.status === 404) forgetManageKey(roomId);
    setConfirmDelete(false);
  };

  return (
    <footer className="flex items-center justify-center gap-3 border-t border-white/10 px-4 py-3">
      <ControlButton
        active={!state.muted}
        danger={state.muted}
        disabled={!state.micAvailable}
        onClick={() => session.setMuted(!state.muted)}
        label={!state.micAvailable ? "マイクなし" : state.muted ? "ミュート解除" : "ミュート"}
      >
        {state.muted ? <MicOffIcon /> : <MicIcon />}
      </ControlButton>
      {canShare && (
        <ControlButton
          active={state.sharing}
          highlight={state.sharing}
          onClick={() => (state.sharing ? session.stopScreenShare() : session.startScreenShare())}
          label={state.sharing ? "共有を停止" : "画面共有"}
        >
          <ScreenIcon />
        </ControlButton>
      )}
      <ControlButton className="lg:hidden" active={showList} onClick={onToggleList} label="参加者">
        <UsersIcon />
      </ControlButton>
      {manageKey &&
        (confirmDelete ? (
          <div className="flex items-center gap-2 rounded-full bg-rose-500/10 px-3 py-1.5 text-sm">
            全員を退出させて削除？
            <button onClick={deleteRoom} className="rounded-full bg-rose-600 px-3 py-1 hover:bg-rose-500">
              削除
            </button>
            <button onClick={() => setConfirmDelete(false)} className="rounded-full px-2 py-1 text-slate-400 hover:text-slate-200">
              やめる
            </button>
          </div>
        ) : (
          <ControlButton onClick={() => setConfirmDelete(true)} label="ルームを削除">
            <TrashIcon />
          </ControlButton>
        ))}
      <button
        onClick={() => session.leave()}
        title="退出"
        className="flex h-11 items-center gap-2 rounded-full bg-rose-600 px-5 font-medium hover:bg-rose-500"
      >
        <PhoneOffIcon /> <span className="hidden sm:inline">退出</span>
      </button>
    </footer>
  );
}

function ControlButton({
  children,
  label,
  onClick,
  active,
  danger,
  highlight,
  disabled,
  className = "",
}: {
  children: React.ReactNode;
  label: string;
  onClick: () => void;
  active?: boolean;
  danger?: boolean;
  highlight?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  const tone = danger
    ? "bg-rose-500/15 text-rose-300 hover:bg-rose-500/25"
    : highlight
      ? "bg-sky-500/20 text-sky-200 hover:bg-sky-500/30"
      : active
        ? "bg-white/10 hover:bg-white/15"
        : "bg-white/5 text-slate-300 hover:bg-white/10";
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={`flex size-11 items-center justify-center rounded-full transition disabled:opacity-40 ${tone} ${className}`}
    >
      {children}
    </button>
  );
}

/** 発話中は光る。発話状態だけを購読するので、話すたびに画面全体が再描画されることはない。 */
function Avatar({ p, session, className }: { p: Participant; session: CallSession; className: string }) {
  const speaking = useSyncExternalStore(session.subscribeSpeaking, () => session.getSpeaking().has(p.id), () => false);
  return (
    <span
      className={`flex items-center justify-center rounded-full font-semibold text-white ${className} ${speaking ? "speaking" : ""}`}
      style={{ background: avatarColor(p.id) }}
    >
      {initial(p.name)}
    </span>
  );
}

function displayName(p: Participant, self: boolean): string {
  return self ? `${p.name}（自分）` : p.name;
}

function initial(name: string): string {
  return [...name.trim()][0]?.toUpperCase() ?? "?";
}

function avatarColor(id: string): string {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h} 55% 45%)`;
}
