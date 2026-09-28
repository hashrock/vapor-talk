# vapor-talk

ブラウザで使える軽量なボイスチャット。ルームの作成と、話す（スピーカーになる）には Google ログインが必要だが、聞くだけならアカウント不要で、招待 URL を共有するだけで最大 20 人が参加できる。外部サービスから REST API で通話ルームを作成できる。

### 役割

| 役割 | できること | なり方 |
| --- | --- | --- |
| ホスト | スピーカーの操作に加え、挙手の許可・却下、スピーカーの降格、ログイン済みリスナーの指名 | ルームの作成者がログインして入る |
| スピーカー（ホストを含め最大 4 人） | マイク・画面共有 | ホストが許可・指名する（ログイン必須）。一度許可された人は入り直してもスピーカー |
| リスナー | 聞く・見る。ログイン済みなら挙手 | それ以外の全員。マイクは取らず、SFU に何も送らない |

API で作ったルームにはホストがいない。参加トークンの `role`（既定は `speaker`）で決まり、トークンなしのゲストはリスナーになる（挙手はない）。

## 構成

| 層 | 技術 |
| --- | --- |
| UI | React + TypeScript + Vite（Inertia: `@hono/inertia` + `@inertiajs/react`、Tailwind） |
| API | Cloudflare Workers + Hono（`app/app.ts`） |
| DB | D1（`rooms` / `users` テーブル。`migrations/`） |
| ログイン | Google OAuth（`@hono/oauth-providers`）+ 署名付き Cookie（`app/auth.ts`）。ルーム作成・マイルーム・削除に使う |
| リアルタイム | Durable Objects（`app/room-do.ts`。1ルーム=1インスタンス、在室者と公開トラックを WebSocket で配る） |
| 通話 | WebRTC + Cloudflare Realtime SFU（`app/client/callSession.ts`。SFU の App トークンはサーバーの中継 `/api/rooms/:id/sfu/*` だけが持つ） |

### 入室の流れ

1. `POST /api/rooms/:id/join`: 期限・招待トークン・定員を確認し、SFU セッションを作ってセッションチケット（JWT）を返す。チケットには通話中に変わらないもの（ログイン中のユーザー、ホストか、招待トークンの role）だけを入れる
2. `GET /api/rooms/:id/ws?ticket=` で RoomDO に接続する。RoomDO が今のロールを決めて `welcome` で返す（判断は `app/domain/stage.ts`）
3. スピーカーならマイクを取って SFU に push（`/sfu/tracks/new` 経由）し、公開トラックを `update` で知らせる。昇格・降格は `updated` で届き、マイクを取る・手放す
4. 他の参加者の公開トラックを pull する（差分計算は `app/client/trackPlan.ts`）

ロールは RoomDO だけが持つ。SFU 中継は push（`location: "local"`）の前に RoomDO に聞いてリスナーなら 403 を返し、RoomDO はリスナーの `update` の公開トラックを捨てる。

## 開発

```bash
pnpm install
cp .dev.vars.example .dev.vars   # CALLS_APP_ID / CALLS_APP_TOKEN を埋める（DEV_BYPASS_AUTH=1 で Google なしに Dev User でログイン。/auth/google?as=alice で別ユーザー）
pnpm migrate                     # ローカル D1
pnpm dev
pnpm test
pnpm typecheck
```

SFU の認証情報は Cloudflare ダッシュボードの Realtime > Serverless SFU で App を作ると得られる。未設定でも画面とルーム API は動くが、入室は 503 になる。

## デプロイ

```bash
wrangler d1 create vapor-talk-db     # 出力された database_id を wrangler.jsonc に書く
pnpm migrate:remote
wrangler secret put CALLS_APP_TOKEN
wrangler secret put API_KEY
wrangler secret put TOKEN_SECRET
wrangler secret put SESSION_SECRET
wrangler secret put GOOGLE_ID       # Google OAuth クライアント（リダイレクト URI は https://<host>/auth/google）
wrangler secret put GOOGLE_SECRET
# wrangler.jsonc の vars.CALLS_APP_ID を設定
pnpm deploy
```

## REST API

すべて `Authorization: Bearer <API_KEY>`（`API_KEY` 未設定なら 503）。

| メソッド | パス | 内容 |
| --- | --- | --- |
| POST | `/api/v1/rooms` | ルーム作成。`{ name?, expiresIn?(秒, 300〜604800, 既定 86400), maxParticipants?(2〜20), guestAccess?(既定 true), externalId? }` → ルーム + `manageKey` |
| GET | `/api/v1/rooms/:id` | ルーム情報と在室者（`role` 付き） |
| DELETE | `/api/v1/rooms/:id` | 削除（在室者は切断）。API キーの代わりに作成時の `manageKey` でも可 |
| POST | `/api/v1/rooms/:id/tokens` | 参加トークン発行。`{ name?, role?("speaker" \| "listener", 既定 "speaker"), expiresIn? }` → `{ token, url }`。`name` を入れると表示名が固定される |

`guestAccess: false` のルームは、参加トークン付きの URL（`/r/:id?token=...`）からしか入れない。`guestAccess: true` でもトークンなしで入った人はリスナーになる。スピーカー用トークンの人も、スピーカーが 4 人いるとリスナーで入る。

有効期限を過ぎたルームは、RoomDO の alarm が在室者を切断し、Cron（30 分ごと）が行を消す。
