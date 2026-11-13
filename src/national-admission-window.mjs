// The official national feed can publish an application long after its
// registration date. A short daily received-date window is insufficient for
// Agile-family authorities while access to their direct API is restricted.
const MAX_WEEKLY_NATIONAL_DAYS = 90
export function nationalAdmissionLookbackDays({
  authorityCode, agileAuthorities, agileAccessBlocked,
  utcDayOfWeek, regularDays = 21,
}) {
  const regular = Math.max(7, Math.min(Number(regularDays) || 21, 42))
  if (agileAccessBlocked && utcDayOfWeek === 1 &&
      Object.hasOwn(agileAuthorities || {}, String(authorityCode || "").toUpperCase())) {
    return MAX_WEEKLY_NATIONAL_DAYS
  }
  return regular
}
