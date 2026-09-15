// Child age in whole months, computed the SAME way as the user_mlp_data view (migration 059):
//   age(current_date, make_date(birth_year, birth_month + 1, 1)) -> years * 12 + months
// i.e. birth_month is 0-11 and the child is treated as born on the 1st of that month. PURE.
// Returns null when birth data is missing, out of range, or in the future — callers treat null
// as "unknown age" (H-D3: evaluate every rule for the flag and take the highest band).

export function ageMonths(birthYear: unknown, birthMonth: unknown, now: Date = new Date()): number | null {
  const y = typeof birthYear === "string" ? Number(birthYear) : birthYear;
  const m = typeof birthMonth === "string" ? Number(birthMonth) : birthMonth;
  if (typeof y !== "number" || typeof m !== "number") return null;
  if (!Number.isInteger(y) || !Number.isInteger(m) || y < 1900 || m < 0 || m > 11) return null;
  let months = (now.getUTCFullYear() - y) * 12 + (now.getUTCMonth() - m);
  // age() counts a month only once the day-of-month is reached; born on the 1st, that is always true.
  if (months < 0) return null;
  return months;
}
