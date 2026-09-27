import { Head, useForm, usePage } from "@inertiajs/react";
import { MAX_PARTICIPANTS_LIMIT, ROOM_NAME_MAX } from "../domain/room";
import { Header } from "../components/Header";
import type { SessionUser } from "../user";
import { MicIcon, ScreenIcon, UsersIcon, LinkIcon } from "../components/icons";

const EXPIRY_OPTIONS = [
  { label: "1時間", sec: 60 * 60 },
  { label: "6時間", sec: 6 * 60 * 60 },
  { label: "24時間", sec: 24 * 60 * 60 },
  { label: "7日間", sec: 7 * 24 * 60 * 60 },
];

export default function Home({ error }: { error?: string }) {
  const { user } = usePage<{ user: SessionUser | null }>().props;
  const form = useForm({ name: "", expiresIn: EXPIRY_OPTIONS[2].sec });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    form.post("/rooms");
  };

  return (
    <div className="min-h-screen bg-[radial-gradient(ellipse_at_top,_rgb(124_58_237/0.25),_transparent_60%)]">
      <Head title="vapor-talk" />
      <Header>
        <a href="#api" className="text-slate-400 hover:text-slate-200">
          API
        </a>
      </Header>

      <main className="mx-auto max-w-5xl px-6 pb-24">
        <section className="grid items-center gap-12 py-12 md:grid-cols-2">
          <div>
            <h1 className="text-4xl font-bold leading-tight tracking-tight md:text-5xl">
              URL を送るだけの
              <br />
              <span className="bg-gradient-to-r from-violet-400 to-sky-400 bg-clip-text text-transparent">軽量ボイスチャット</span>
            </h1>
            <p className="mt-5 text-slate-400">
              参加にアカウントは不要。ルームを作って招待 URL を共有すれば、ブラウザだけで最大 {MAX_PARTICIPANTS_LIMIT} 人と音声通話・画面共有ができます。
            </p>
            <ul className="mt-8 grid grid-cols-2 gap-3 text-sm text-slate-300">
              <Feature icon={<MicIcon />} text="高音質な音声通話" />
              <Feature icon={<ScreenIcon />} text="画面共有" />
              <Feature icon={<UsersIcon />} text={`最大 ${MAX_PARTICIPANTS_LIMIT} 人`} />
              <Feature icon={<LinkIcon />} text="REST API で外部連携" />
            </ul>
          </div>

          {user ? (
          <form onSubmit={submit} className="rounded-2xl border border-white/10 bg-slate-900/80 p-6 shadow-2xl shadow-violet-950/40">
            <h2 className="text-lg font-semibold">ルームを作成</h2>
            <label className="mt-5 block text-sm text-slate-400" htmlFor="room-name">
              ルーム名
            </label>
            <input
              id="room-name"
              value={form.data.name}
              onChange={(e) => form.setData("name", e.target.value)}
              maxLength={ROOM_NAME_MAX}
              placeholder="ボイスチャット"
              className="mt-1.5 w-full rounded-lg border border-white/10 bg-slate-950 px-3 py-2.5 outline-none focus:border-violet-500"
            />
            <span className="mt-5 block text-sm text-slate-400">有効期限</span>
            <div className="mt-1.5 grid grid-cols-4 gap-2">
              {EXPIRY_OPTIONS.map((o) => (
                <button
                  type="button"
                  key={o.sec}
                  onClick={() => form.setData("expiresIn", o.sec)}
                  className={`rounded-lg border px-2 py-2 text-sm transition ${
                    form.data.expiresIn === o.sec ? "border-violet-500 bg-violet-500/15 text-violet-200" : "border-white/10 text-slate-400 hover:border-white/25"
                  }`}
                >
                  {o.label}
                </button>
              ))}
            </div>
            {error && <p className="mt-4 text-sm text-rose-400">{error}</p>}
            <button
              type="submit"
              disabled={form.processing}
              className="mt-6 w-full rounded-lg bg-violet-600 py-3 font-medium transition hover:bg-violet-500 disabled:opacity-50"
            >
              {form.processing ? "作成中…" : "ルームを作成"}
            </button>
          </form>
          ) : (
            <div className="rounded-2xl border border-white/10 bg-slate-900/80 p-6 text-center shadow-2xl shadow-violet-950/40">
              <h2 className="text-lg font-semibold">ルームを作成</h2>
              <p className="mt-3 text-sm text-slate-400">ルームの作成にはログインが必要です。参加する人はアカウント不要です。</p>
              <a
                href="/auth/google"
                className="mt-6 block w-full rounded-lg bg-violet-600 py-3 font-medium transition hover:bg-violet-500"
              >
                Google でログイン
              </a>
            </div>
          )}
        </section>

        <section id="api" className="mt-8 rounded-2xl border border-white/10 bg-slate-900/60 p-6">
          <h2 className="text-lg font-semibold">API で通話ルームを作る</h2>
          <p className="mt-2 text-sm text-slate-400">
            外部サービスから <code className="text-violet-300">Authorization: Bearer &lt;API_KEY&gt;</code> でルームを作成し、参加トークン付きの招待 URL を発行できます。
          </p>
          <pre className="mt-4 overflow-x-auto rounded-lg bg-slate-950 p-4 text-xs leading-relaxed text-slate-300">{`# ルーム作成（guestAccess:false で参加トークン必須にできる）
curl -X POST https://<host>/api/v1/rooms \\
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \\
  -d '{"name":"定例","expiresIn":3600,"maxParticipants":10,"guestAccess":false}'

# 参加トークン（表示名を固定した招待 URL）を発行
curl -X POST https://<host>/api/v1/rooms/<id>/tokens \\
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \\
  -d '{"name":"Alice"}'

# ルーム情報と在室者 / 削除
curl https://<host>/api/v1/rooms/<id> -H "Authorization: Bearer $API_KEY"
curl -X DELETE https://<host>/api/v1/rooms/<id> -H "Authorization: Bearer $API_KEY"`}</pre>
        </section>
      </main>
    </div>
  );
}

function Feature({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <li className="flex items-center gap-2 rounded-lg border border-white/5 bg-white/[0.03] px-3 py-2.5">
      <span className="text-violet-400">{icon}</span>
      {text}
    </li>
  );
}
