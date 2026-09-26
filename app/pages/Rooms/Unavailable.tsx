import { Head, Link } from "@inertiajs/react";
import { Logo } from "../../components/Logo";

const MESSAGES = {
  "not-found": { title: "ルームが見つかりません", body: "URL が間違っているか、ルームが削除されました。" },
  expired: { title: "ルームの有効期限が切れました", body: "新しいルームを作成してください。" },
} as const;

export default function Unavailable({ reason }: { reason: keyof typeof MESSAGES }) {
  const m = MESSAGES[reason];
  return (
    <div className="mx-auto max-w-xl px-6 py-10">
      <Head title={m.title} />
      <Logo />
      <div className="mt-16 text-center">
        <h1 className="text-2xl font-semibold">{m.title}</h1>
        <p className="mt-3 text-slate-400">{m.body}</p>
        <Link href="/" className="mt-8 inline-block rounded-lg bg-violet-600 px-5 py-2.5 font-medium hover:bg-violet-500">
          ルームを作成する
        </Link>
      </div>
    </div>
  );
}
