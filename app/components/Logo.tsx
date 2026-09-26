import { Link } from "@inertiajs/react";

export function Logo() {
  return (
    <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight text-slate-100">
      <img src="/icon.svg" alt="" className="size-7" />
      vapor-talk
    </Link>
  );
}
