import { Link, usePage } from "@inertiajs/react";
import type { SessionUser } from "../user";
import { Logo } from "./Logo";

/** ページ共通のヘッダー。ログイン状態は inertia の share（props.user）から読む。 */
export function Header({ children }: { children?: React.ReactNode }) {
  const { user } = usePage<{ user: SessionUser | null }>().props;
  return (
    <header className="mx-auto flex w-full max-w-5xl items-center gap-5 px-6 py-5 text-sm">
      <div className="flex-1">
        <Logo />
      </div>
      {children}
      {user ? (
        <>
          <Link href="/rooms" className="text-slate-300 hover:text-white">
            マイルーム
          </Link>
          <span className="flex items-center gap-2 text-slate-400">
            {user.avatarUrl && <img src={user.avatarUrl} alt="" className="size-6 rounded-full" />}
            <span className="hidden sm:inline">{user.name}</span>
          </span>
          <a href="/auth/logout" className="text-slate-500 hover:text-slate-300">
            ログアウト
          </a>
        </>
      ) : (
        <a href="/auth/google" className="rounded-lg border border-white/15 px-3 py-1.5 text-slate-200 hover:bg-white/5">
          ログイン
        </a>
      )}
    </header>
  );
}
