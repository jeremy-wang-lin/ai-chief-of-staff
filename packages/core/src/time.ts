function pad(n: number): string { return String(n).padStart(2, "0"); }

/** 本地時間 'YYYY-MM-DDTHH:mm:ss'。禁止改用 toISOString()(那是 UTC)。 */
export function nowLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 本地日期 'YYYY-MM-DD' */
export function todayLocal(): string {
  return nowLocal().slice(0, 10);
}

/** date('YYYY-MM-DD') 加減天數(以中午起算避免 DST 邊界) */
export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00`);
  if (Number.isNaN(d.getTime())) throw new Error(`invalid date: ${date}`);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
