export function money(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "לא זמין";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(value);
}

export function number(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "לא זמין";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: digits }).format(value);
}

export function percent(value: number | null | undefined, signed = false): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "לא זמין";
  const prefix = signed && value > 0 ? "+" : "";
  return `${prefix}${value.toFixed(2)}%`;
}

export function pnlClass(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value) || value === 0) return "neutral";
  return value > 0 ? "positive" : "negative";
}

export function ageLabel(ageSeconds: number | null | undefined): string {
  if (ageSeconds === null || ageSeconds === undefined || !Number.isFinite(ageSeconds)) return "זמן לא ידוע";
  if (ageSeconds < 10) return "עכשיו";
  if (ageSeconds < 60) return `לפני ${Math.floor(ageSeconds)} שנ׳`;
  if (ageSeconds < 3600) return `לפני ${Math.floor(ageSeconds / 60)} דק׳`;
  if (ageSeconds < 86400) return `לפני ${Math.floor(ageSeconds / 3600)} שע׳`;
  return `לפני ${Math.floor(ageSeconds / 86400)} ימים`;
}

export function freshnessHebrew(value: string | null | undefined): string {
  if (value === "fresh") return "מידע עדכני";
  if (value === "aging") return "מתעדכן";
  if (value === "stale") return "מידע מיושן";
  return "מקור לא זמין";
}

export function systemStateHebrew(value: string | null | undefined): string {
  if (value === "healthy") return "תקין";
  if (value === "limited") return "מוגבל";
  if (value === "protection") return "הגנה";
  if (value === "emergency_stop") return "עצירת חירום";
  return "לא ידוע";
}

export function modeHebrew(value: string | null | undefined): string {
  if (value === "paper") return "סימולציה";
  if (value === "shadow") return "צל";
  if (value === "demo") return "דמו";
  if (value === "live") return "חי";
  if (value === "research") return "מחקר";
  return "לא ידוע";
}
