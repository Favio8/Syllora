
export function dayKey(date = new Date()) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

export function recentDays(count: number, today = dayKey()) {
  const end = new Date(`${today}T12:00:00+08:00`);
  return Array.from({ length: count }, (_, i) => {
    const date = new Date(end);
    date.setUTCDate(date.getUTCDate() - count + 1 + i);
    return dayKey(date);
  });
}
