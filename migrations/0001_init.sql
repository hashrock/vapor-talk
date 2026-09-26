CREATE TABLE `rooms` (
  `id` text PRIMARY KEY NOT NULL,
  `name` text NOT NULL,
  `max_participants` integer NOT NULL,
  -- 1: 招待URLを知っていれば誰でも参加可 / 0: 参加トークン必須
  `guest_access` integer NOT NULL DEFAULT 1,
  -- ルーム作成者が削除に使う管理キーの SHA-256（API キーでも削除できる）
  `manage_key_hash` text NOT NULL,
  -- 外部サービスが紐付けに使う任意の文字列
  `external_id` text,
  `created_at` text NOT NULL,
  `expires_at` text NOT NULL
);

CREATE INDEX `rooms_expires_at` ON `rooms` (`expires_at`);
