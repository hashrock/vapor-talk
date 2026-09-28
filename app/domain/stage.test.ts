import { describe, expect, it } from "vitest";
import type { Participant } from "./protocol";
import { applyRoleCommand, applyUpdate, initialRole, type StageRules } from "./stage";

const rules: StageRules = { hosted: true, maxSpeakers: 2 };

const p = (id: string, patch: Partial<Participant> = {}): Participant => ({
  id,
  name: id,
  sessionId: `s-${id}`,
  tracks: [],
  muted: false,
  joinedAt: 0,
  role: "listener",
  host: false,
  loggedIn: true,
  handRaised: false,
  ...patch,
});

const host = p("host", { role: "speaker", host: true });

describe("initialRole", () => {
  it("ホストは定員に関係なくスピーカー", () => {
    expect(initialRole({ host: true, invitedRole: null, granted: false }, 4, 4)).toBe("speaker");
  });

  it("スピーカー用トークン・許可済みユーザーは、定員に空きがあればスピーカー", () => {
    expect(initialRole({ host: false, invitedRole: "speaker", granted: false }, 1, 2)).toBe("speaker");
    expect(initialRole({ host: false, invitedRole: null, granted: true }, 1, 2)).toBe("speaker");
    expect(initialRole({ host: false, invitedRole: "speaker", granted: false }, 2, 2)).toBe("listener");
  });

  it("それ以外はリスナー", () => {
    expect(initialRole({ host: false, invitedRole: null, granted: false }, 0, 2)).toBe("listener");
    expect(initialRole({ host: false, invitedRole: "listener", granted: false }, 0, 2)).toBe("listener");
  });
});

describe("applyUpdate", () => {
  it("リスナーの公開トラックは捨てる", () => {
    const next = applyUpdate(p("a"), { type: "update", tracks: [{ trackName: "mic-1", kind: "mic" }] });
    expect(next.tracks).toEqual([]);
  });

  it("スピーカーは公開トラックとミュートを更新できる", () => {
    const next = applyUpdate(p("a", { role: "speaker" }), { type: "update", tracks: [{ trackName: "mic-1", kind: "mic" }], muted: true });
    expect(next.tracks).toHaveLength(1);
    expect(next.muted).toBe(true);
  });
});

describe("applyRoleCommand", () => {
  it("ログイン済みのリスナーは挙手できる", () => {
    const a = p("a");
    expect(applyRoleCommand(a, { type: "hand", raised: true }, [host, a], rules)).toEqual([{ ...a, handRaised: true }]);
  });

  it("未ログイン・スピーカー・ホストなしのルームでは挙手できない", () => {
    const guest = p("g", { loggedIn: false });
    expect(applyRoleCommand(guest, { type: "hand", raised: true }, [host, guest], rules)).toEqual([]);
    const s = p("s", { role: "speaker" });
    expect(applyRoleCommand(s, { type: "hand", raised: true }, [host, s], rules)).toEqual([]);
    const a = p("a");
    expect(applyRoleCommand(a, { type: "hand", raised: true }, [a], { ...rules, hosted: false })).toEqual([]);
  });

  it("ホストは挙手したリスナーをスピーカーにでき、挙手は下りる", () => {
    const a = p("a", { handRaised: true, muted: true });
    const [changed] = applyRoleCommand(host, { type: "promote", id: "a" }, [host, a], rules);
    expect(changed).toMatchObject({ id: "a", role: "speaker", handRaised: false, muted: false });
  });

  it("スピーカーが定員なら許可できない", () => {
    const s = p("s", { role: "speaker" });
    const a = p("a", { handRaised: true });
    expect(applyRoleCommand(host, { type: "promote", id: "a" }, [host, s, a], rules)).toEqual([]);
  });

  it("未ログインの参加者はスピーカーにできない", () => {
    const guest = p("g", { loggedIn: false });
    expect(applyRoleCommand(host, { type: "promote", id: "g" }, [host, guest], rules)).toEqual([]);
  });

  it("ホスト以外は昇格・降格・却下できない", () => {
    const s = p("s", { role: "speaker" });
    const a = p("a", { handRaised: true });
    for (const cmd of [
      { type: "promote", id: "a" },
      { type: "demote", id: "s" },
      { type: "reject", id: "a" },
    ] as const) {
      expect(applyRoleCommand(s, cmd, [host, s, a], rules)).toEqual([]);
    }
  });

  it("降格するとリスナーに戻り、公開トラックは消える", () => {
    const s = p("s", { role: "speaker", tracks: [{ trackName: "mic-1", kind: "mic" }] });
    const [changed] = applyRoleCommand(host, { type: "demote", id: "s" }, [host, s], rules);
    expect(changed).toMatchObject({ id: "s", role: "listener", tracks: [], muted: true });
  });

  it("ホストは降格できない", () => {
    expect(applyRoleCommand(host, { type: "demote", id: "host" }, [host], rules)).toEqual([]);
  });

  it("却下すると挙手が下りる", () => {
    const a = p("a", { handRaised: true });
    expect(applyRoleCommand(host, { type: "reject", id: "a" }, [host, a], rules)).toEqual([{ ...a, handRaised: false }]);
    expect(applyRoleCommand(host, { type: "reject", id: "a" }, [host, { ...a, handRaised: false }], rules)).toEqual([]);
  });
});
