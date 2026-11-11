import { BrokerError } from "./types.js";
import type { ConnectionsHttp } from "./connections-http.js";
/** Counts are separate provider series: their sums are not deduplicated people. */
const definitions = {
  BUSINESS_IMPRESSIONS_DESKTOP_MAPS: "Desktop Maps impressions; repeated views by one user in one day count once within this metric.",
  BUSINESS_IMPRESSIONS_DESKTOP_SEARCH: "Desktop Search impressions; repeated views by one user in one day count once within this metric.",
  BUSINESS_IMPRESSIONS_MOBILE_MAPS: "Mobile Maps impressions; repeated views by one user in one day count once within this metric.",
  BUSINESS_IMPRESSIONS_MOBILE_SEARCH: "Mobile Search impressions; repeated views by one user in one day count once within this metric.",
  BUSINESS_DIRECTION_REQUESTS: "Requests for directions to this business location.",
  CALL_CLICKS: "Clicks on the business profile call button; not completed phone calls.",
  WEBSITE_CLICKS: "Clicks on the business profile website link.",
} as const;
type Metric = keyof typeof definitions;
const metricIds = Object.keys(definitions) as Metric[];
function dateLabel(value: unknown): string {
  const d = value as { year?: number; month?: number; day?: number } | undefined;
  if (!d || !Number.isInteger(d.year) || !Number.isInteger(d.month) || !Number.isInteger(d.day) || d.year! < 2000 || d.year! > 9999 || d.month! < 1 || d.month! > 12 || d.day! < 1 || d.day! > 31) throw new BrokerError("provider_response_invalid");
  const date = `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
  if (new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) throw new BrokerError("provider_response_invalid");
  return date;
}
function rows(value: unknown, max: number): Record<string, any>[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max || value.some(v => !v || typeof v !== "object" || Array.isArray(v))) throw new BrokerError("provider_response_invalid");
  return value;
}
export async function readGoogleDailyMetrics(http: ConnectionsHttp, location: string, headers: Record<string, string>, now = Date.now()) {
  if (!/^locations\/\d{1,64}$/.test(location)) throw new BrokerError("resource_not_owned");
  // Date labels chosen from UTC; do not claim the API's aggregation timezone is UTC.
  const today = new Date(now); today.setUTCHours(0, 0, 0, 0);
  const startDate = new Date(today.getTime() - 7 * 86400000).toISOString().slice(0, 10), endDate = new Date(today.getTime() - 86400000).toISOString().slice(0, 10);
  const u = new URL(`https://businessprofileperformance.googleapis.com/v1/${location}:fetchMultiDailyMetricsTimeSeries`);
  for (const metric of metricIds) u.searchParams.append("dailyMetrics", metric);
  for (const [name, value] of [["startDate", startDate], ["endDate", endDate]]) {
    const [year, month, day] = value.split("-");
    u.searchParams.set(`dailyRange.${name}.year`, String(Number(year))); u.searchParams.set(`dailyRange.${name}.month`, String(Number(month))); u.searchParams.set(`dailyRange.${name}.day`, String(Number(day)));
  }
  const response = await http.json(u.toString(), { headers });
  const series = new Map<Metric, { metric: Metric; definition: string; points: { date: string; value: string }[] }>();
  for (const group of rows(response.multiDailyMetricTimeSeries, 7)) for (const raw of rows(group.dailyMetricTimeSeries, 7)) {
    const metric = raw.dailyMetric as Metric;
    if (!Object.hasOwn(definitions, metric) || series.has(metric) || raw.dailySubEntityType && Object.keys(raw.dailySubEntityType).length) throw new BrokerError("provider_response_invalid");
    const seen = new Set<string>();
    const points = rows(raw.timeSeries?.datedValues, 7).map(point => {
      const date = dateLabel(point.date);
      if (date < startDate || date > endDate || seen.has(date)) throw new BrokerError("provider_response_invalid"); seen.add(date);
      // Google explicitly omits value on a PRESENT dated point when the count is zero.
      const value = point.value === undefined ? "0" : point.value;
      if (typeof value !== "string" || !/^(0|[1-9]\d{0,18})$/.test(value) || BigInt(value) > 9223372036854775807n) throw new BrokerError("provider_response_invalid");
      return { date, value };
    }).sort((a, b) => a.date.localeCompare(b.date));
    series.set(metric, { metric, definition: definitions[metric], points });
  }
  const available = [...series.values()], missingMetrics = metricIds.filter(metric => !series.has(metric));
  return { source: "google_business_profile_performance_v1", metrics: { series: available, missingMetrics, coverage: available.every(s => !s.points.length) ? "empty" : missingMetrics.length || available.some(s => s.points.length < 7) ? "partial" : "complete" }, window: "daily_range", range: { startDate, endDate, inclusive: true, selectionTimezone: "UTC" }, timezone: "provider_unspecified", definition: "Provider date-labelled daily counts; no aggregate timezone is supplied by this API. Absent dates/series are unknown; only a present DatedValue with omitted value is documented zero. Int64 values remain decimal strings; no cross-metric or cross-date total is synthesized." };
}
