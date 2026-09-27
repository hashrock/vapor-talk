CREATE TABLE `users` (
  `id` text PRIMARY KEY NOT NULL,
  `email` text NOT NULL UNIQUE,
  `name` text NOT NULL,
  `avatar_url` text NOT NULL DEFAULT '',
  `created_at` text NOT NULL
);

-- Web でログインユーザーが作ったルームの持ち主。API で作ったルームは NULL
ALTER TABLE `rooms` ADD COLUMN `owner_id` text REFERENCES `users`(`id`);
CREATE INDEX `rooms_owner_id` ON `rooms` (`owner_id`);
