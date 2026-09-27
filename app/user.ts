/** ログイン中のユーザー（サーバーのセッションとページの props で共有）。 */
export type SessionUser = {
  id: string;
  email: string;
  name: string;
  avatarUrl: string;
};
