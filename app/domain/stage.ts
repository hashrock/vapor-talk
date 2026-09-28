/**
 * スピーカー / リスナーの決まりごと。RoomDO はここで決めた結果を保存して配るだけ。
 *
 * - ホスト（作成者）は常にスピーカー
 * - スピーカーにできるのはホストだけで、相手はログイン済みの参加者に限る
 * - API で作ったルーム（ホストなし）は、参加トークンの role で決まる。挙手はない
 */
import type { ClientMessage, Participant, Role } from "./protocol";

/** 同時に話せる人数（ホストを含む）。 */
export const MAX_SPEAKERS = 4;

export type RoleCommand = Extract<ClientMessage, { type: "hand" | "promote" | "demote" | "reject" }>;

export interface StageRules {
  /** ホストがいるルーム（Web で作った）か。ホストなしのルームでは挙手できない */
  hosted: boolean;
  maxSpeakers: number;
}

export function speakerCount(participants: Iterable<Participant>): number {
  let n = 0;
  for (const p of participants) if (p.role === "speaker") n++;
  return n;
}

export function listenerCount(participants: Iterable<Participant>): number {
  let n = 0;
  for (const p of participants) if (p.role === "listener") n++;
  return n;
}

/**
 * viewer に個別の情報を配る参加者か。ホストは全員（挙手の許可・指名に使う）、
 * それ以外はスピーカーと自分だけ。リスナーの出入りは人数だけをまとめて配る。
 */
export function visibleTo(viewer: Participant, p: Participant): boolean {
  return viewer.host || p.role === "speaker" || p.id === viewer.id;
}

export interface Entry {
  host: boolean;
  /** 参加トークンで指定されたロール（トークンなしは null） */
  invitedRole: Role | null;
  /** 以前ホストにスピーカーにしてもらった（入り直しても戻す） */
  granted: boolean;
}

/** 入室時のロール。ホスト以外は、スピーカーの定員に空きがなければリスナーで入る。 */
export function initialRole(entry: Entry, speakers: number, maxSpeakers: number): Role {
  if (entry.host) return "speaker";
  if ((entry.invitedRole === "speaker" || entry.granted) && speakers < maxSpeakers) return "speaker";
  return "listener";
}

/** 自分の状態の更新。リスナーは何も公開できない。 */
export function applyUpdate(p: Participant, msg: Extract<ClientMessage, { type: "update" }>): Participant {
  if (p.role === "listener") return { ...p, tracks: [] };
  return { ...p, tracks: msg.tracks ?? p.tracks, muted: msg.muted ?? p.muted };
}

/** 挙手・昇格・降格・却下。変わった参加者だけを返す（許されない操作は空）。 */
export function applyRoleCommand(actor: Participant, cmd: RoleCommand, participants: readonly Participant[], rules: StageRules): Participant[] {
  if (cmd.type === "hand") {
    if (actor.handRaised === cmd.raised) return [];
    if (cmd.raised && !(rules.hosted && actor.role === "listener" && actor.loggedIn)) return [];
    return [{ ...actor, handRaised: cmd.raised }];
  }

  if (!actor.host) return [];
  const target = participants.find((p) => p.id === cmd.id);
  if (!target) return [];

  switch (cmd.type) {
    case "promote":
      if (target.role !== "listener" || !target.loggedIn) return [];
      if (speakerCount(participants) >= rules.maxSpeakers) return [];
      return [{ ...target, role: "speaker", handRaised: false, tracks: [], muted: false }];
    case "demote":
      if (target.role !== "speaker" || target.host) return [];
      return [{ ...target, role: "listener", tracks: [], muted: true }];
    case "reject":
      if (!target.handRaised) return [];
      return [{ ...target, handRaised: false }];
  }
}
