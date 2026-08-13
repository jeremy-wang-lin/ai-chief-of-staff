import type { Note } from "./api";

/** Scratch 通常沒有標題,列表就拿內文首行當名字;兩者都空的筆記不能變成一列看不見的東西。 */
export function noteLabel(n: Pick<Note, "title" | "bodyMd">): string {
  return n.title || n.bodyMd.split("\n")[0].slice(0, 40).trim() || "(未命名)";
}
