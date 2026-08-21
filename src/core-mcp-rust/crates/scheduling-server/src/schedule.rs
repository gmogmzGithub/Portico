use crate::model::{ScheduleKind, TaskSchedule};
use anyhow::{bail, Context, Result};
use chrono::{DateTime, Datelike, Duration, Timelike, Utc};
use chrono_tz::Tz;
use std::str::FromStr;

const CRON_FIELD_COUNT: usize = 5;
const CRON_SEARCH_YEARS: i64 = 16;
/// Backward search bound for `most_recent_run_at_or_before`. Any cron
/// sparser than this (no occurrence in the last year) has no meaningful
/// "current period" to catch up, so the caller falls back to the stored
/// `next_run_at`.
const MOST_RECENT_SEARCH_DAYS: i64 = 366;

#[derive(Clone, Debug, PartialEq, Eq)]
struct ParsedTaskSchedule {
    kind: ScheduleKind,
    timezone: Tz,
    cron: Option<CronSchedule>,
    run_at: Option<DateTime<Utc>>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct CronSchedule {
    minute: CronField,
    hour: CronField,
    day_of_month: CronField,
    month: CronField,
    day_of_week: CronField,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct CronField {
    min: u32,
    max: u32,
    allowed: Vec<bool>,
    wildcard: bool,
}

impl CronField {
    fn new(min: u32, max: u32, wildcard: bool) -> Self {
        Self {
            min,
            max,
            allowed: vec![false; (max - min + 1) as usize],
            wildcard,
        }
    }

    fn set(&mut self, value: u32) {
        self.allowed[(value - self.min) as usize] = true;
    }

    fn set_range(&mut self, start: u32, end: u32, step: u32) {
        let mut current = start;
        while current <= end {
            self.set(current);
            match current.checked_add(step) {
                Some(next) => current = next,
                None => break,
            }
        }
    }

    fn matches(&self, value: u32) -> bool {
        if value < self.min || value > self.max {
            return false;
        }
        self.allowed[(value - self.min) as usize]
    }

    fn has_values(&self) -> bool {
        self.allowed.iter().any(|value| *value)
    }
}

impl CronSchedule {
    fn parse(expression: &str) -> Result<Self> {
        let parts = expression
            .split_whitespace()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .collect::<Vec<_>>();
        if parts.len() != CRON_FIELD_COUNT {
            bail!(
                "Cron expression must contain exactly 5 fields (minute hour day-of-month month day-of-week)"
            );
        }

        Ok(Self {
            minute: parse_field(parts[0], 0, 59, &[], false)?,
            hour: parse_field(parts[1], 0, 23, &[], false)?,
            day_of_month: parse_field(parts[2], 1, 31, &[], false)?,
            month: parse_field(
                parts[3],
                1,
                12,
                &[
                    ("JAN", 1),
                    ("FEB", 2),
                    ("MAR", 3),
                    ("APR", 4),
                    ("MAY", 5),
                    ("JUN", 6),
                    ("JUL", 7),
                    ("AUG", 8),
                    ("SEP", 9),
                    ("OCT", 10),
                    ("NOV", 11),
                    ("DEC", 12),
                ],
                false,
            )?,
            day_of_week: parse_field(
                parts[4],
                0,
                6,
                &[
                    ("SUN", 0),
                    ("MON", 1),
                    ("TUE", 2),
                    ("WED", 3),
                    ("THU", 4),
                    ("FRI", 5),
                    ("SAT", 6),
                ],
                true,
            )?,
        })
    }

    fn matches_local(&self, local: &DateTime<Tz>) -> bool {
        let minute_matches = self.minute.matches(local.minute());
        let hour_matches = self.hour.matches(local.hour());
        let month_matches = self.month.matches(local.month());
        let day_of_month_matches = self.day_of_month.matches(local.day());
        let day_of_week_matches = self
            .day_of_week
            .matches(local.weekday().num_days_from_sunday());
        let day_matches = match (self.day_of_month.wildcard, self.day_of_week.wildcard) {
            (true, true) => true,
            (true, false) => day_of_week_matches,
            (false, true) => day_of_month_matches,
            (false, false) => day_of_month_matches || day_of_week_matches,
        };

        minute_matches && hour_matches && month_matches && day_matches
    }

    fn next_after(
        &self,
        timezone: Tz,
        after: DateTime<Utc>,
        inclusive: bool,
    ) -> Result<DateTime<Utc>> {
        let mut candidate = aligned_minute_start(after, inclusive);
        let deadline = candidate + Duration::days(366 * CRON_SEARCH_YEARS);

        while candidate <= deadline {
            if self.matches_local(&candidate.with_timezone(&timezone)) {
                return Ok(candidate);
            }
            candidate += Duration::minutes(1);
        }

        bail!("Could not find a matching cron occurrence within {CRON_SEARCH_YEARS} years")
    }

    /// Most recent occurrence at or before `at`, walking backward
    /// minute-by-minute, bounded to `MOST_RECENT_SEARCH_DAYS`.
    fn most_recent_at_or_before(&self, timezone: Tz, at: DateTime<Utc>) -> Option<DateTime<Utc>> {
        let mut candidate = floor_to_minute(at);
        let deadline = candidate - Duration::days(MOST_RECENT_SEARCH_DAYS);
        while candidate >= deadline {
            if self.matches_local(&candidate.with_timezone(&timezone)) {
                return Some(candidate);
            }
            candidate -= Duration::minutes(1);
        }
        None
    }
}

fn floor_to_minute(at: DateTime<Utc>) -> DateTime<Utc> {
    at.with_second(0)
        .and_then(|value| value.with_nanosecond(0))
        .unwrap_or(at)
}

fn aligned_minute_start(after: DateTime<Utc>, inclusive: bool) -> DateTime<Utc> {
    let truncated = after
        .with_second(0)
        .and_then(|value| value.with_nanosecond(0))
        .unwrap_or(after);
    if inclusive && after == truncated {
        truncated
    } else {
        truncated + Duration::minutes(1)
    }
}

fn parse_field(
    raw: &str,
    min: u32,
    max: u32,
    names: &[(&str, u32)],
    map_seven_to_zero: bool,
) -> Result<CronField> {
    let wildcard = raw.trim() == "*" || raw.trim().starts_with("*/");
    let mut field = CronField::new(min, max, wildcard);

    for part in raw.split(',') {
        let part = part.trim();
        if part.is_empty() {
            bail!("Cron field contains an empty list item");
        }
        let (base, step) = match part.split_once('/') {
            Some((base, step_raw)) => {
                let step = step_raw
                    .trim()
                    .parse::<u32>()
                    .with_context(|| format!("Invalid cron step value: {step_raw}"))?;
                if step == 0 {
                    bail!("Cron step values must be greater than zero");
                }
                (base.trim(), step)
            }
            None => (part, 1),
        };

        let (start, end) = if base == "*" {
            (min, max)
        } else if let Some((start_raw, end_raw)) = base.split_once('-') {
            let start = parse_field_value(start_raw.trim(), min, max, names, map_seven_to_zero)?;
            let end = parse_field_value(end_raw.trim(), min, max, names, map_seven_to_zero)?;
            if start > end {
                bail!("Cron ranges must be ascending: {base}");
            }
            (start, end)
        } else {
            let value = parse_field_value(base, min, max, names, map_seven_to_zero)?;
            (value, value)
        };

        field.set_range(start, end, step);
    }

    if !field.has_values() {
        bail!("Cron field does not match any values: {raw}");
    }

    Ok(field)
}

fn parse_field_value(
    raw: &str,
    min: u32,
    max: u32,
    names: &[(&str, u32)],
    map_seven_to_zero: bool,
) -> Result<u32> {
    let normalized = raw.trim().to_ascii_uppercase();
    let mut value = names
        .iter()
        .find_map(|(name, mapped)| (*name == normalized).then_some(*mapped))
        .or_else(|| normalized.parse::<u32>().ok())
        .with_context(|| format!("Invalid cron field value: {raw}"))?;

    if map_seven_to_zero && value == 7 {
        value = 0;
    }

    if value < min || value > max {
        bail!("Cron field value out of range ({min}-{max}): {raw}");
    }

    Ok(value)
}

impl ParsedTaskSchedule {
    fn parse(schedule: &TaskSchedule) -> Result<Self> {
        let timezone = Tz::from_str(schedule.timezone.trim())
            .with_context(|| format!("Invalid IANA timezone: {}", schedule.timezone))?;

        match schedule.kind {
            ScheduleKind::Cron => {
                let expression = schedule
                    .cron_expression
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .context("schedule.cron_expression is required for cron schedules")?;
                if schedule
                    .run_at
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .is_some()
                {
                    bail!("schedule.run_at is not allowed for cron schedules");
                }
                Ok(Self {
                    kind: ScheduleKind::Cron,
                    timezone,
                    cron: Some(CronSchedule::parse(expression)?),
                    run_at: None,
                })
            }
            ScheduleKind::Once => {
                let run_at = schedule
                    .run_at_utc()?
                    .context("schedule.run_at is required for one-off schedules")?;
                if schedule
                    .cron_expression
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .is_some()
                {
                    bail!("schedule.cron_expression is not allowed for one-off schedules");
                }
                Ok(Self {
                    kind: ScheduleKind::Once,
                    timezone,
                    cron: None,
                    run_at: Some(run_at),
                })
            }
        }
    }
}

pub fn validate_schedule(schedule: &TaskSchedule) -> Result<()> {
    ParsedTaskSchedule::parse(schedule).map(|_| ())
}

pub fn initial_next_run_at(
    schedule: &TaskSchedule,
    now: DateTime<Utc>,
) -> Result<Option<DateTime<Utc>>> {
    let parsed = ParsedTaskSchedule::parse(schedule)?;
    match parsed.kind {
        ScheduleKind::Cron => parsed
            .cron
            .as_ref()
            .map(|cron| cron.next_after(parsed.timezone, now, true))
            .transpose(),
        ScheduleKind::Once => Ok(parsed.run_at),
    }
}

pub fn next_future_run_at(
    schedule: &TaskSchedule,
    after: DateTime<Utc>,
) -> Result<Option<DateTime<Utc>>> {
    let parsed = ParsedTaskSchedule::parse(schedule)?;
    match parsed.kind {
        ScheduleKind::Cron => parsed
            .cron
            .as_ref()
            .map(|cron| cron.next_after(parsed.timezone, after, false))
            .transpose(),
        ScheduleKind::Once => Ok(None),
    }
}

/// Most recent occurrence at or before `at`, or `None` when the schedule
/// has no occurrence within the backward search bound (~1 year). Used to
/// find the "current" occurrence a task should catch up with after the
/// scheduler was down at its original fire time.
pub fn most_recent_run_at_or_before(
    schedule: &TaskSchedule,
    at: DateTime<Utc>,
) -> Result<Option<DateTime<Utc>>> {
    let parsed = ParsedTaskSchedule::parse(schedule)?;
    match parsed.kind {
        ScheduleKind::Cron => Ok(parsed
            .cron
            .as_ref()
            .and_then(|cron| cron.most_recent_at_or_before(parsed.timezone, at))),
        ScheduleKind::Once => Ok(parsed.run_at.filter(|run_at| *run_at <= at)),
    }
}

/// Count occurrences in the half-open interval `[from, to)`, capped at
/// `cap` to bound the enumeration. Returns `(count, capped)`; `capped`
/// is true when the count hit the cap and the real number is larger.
pub fn count_occurrences_between(
    schedule: &TaskSchedule,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
    cap: usize,
) -> Result<(usize, bool)> {
    if to <= from || cap == 0 {
        return Ok((0, false));
    }
    let parsed = ParsedTaskSchedule::parse(schedule)?;
    match parsed.kind {
        ScheduleKind::Once => Ok((
            parsed
                .run_at
                .map(|run_at| run_at >= from && run_at < to)
                .unwrap_or(false) as usize,
            false,
        )),
        ScheduleKind::Cron => {
            let cron = parsed
                .cron
                .as_ref()
                .context("cron schedule without a parsed expression")?;
            let mut count = 0usize;
            let mut cursor = from;
            let mut inclusive = true;
            while count < cap {
                let occurrence = cron.next_after(parsed.timezone, cursor, inclusive)?;
                if occurrence >= to {
                    return Ok((count, false));
                }
                count += 1;
                cursor = occurrence;
                inclusive = false;
            }
            Ok((count, true))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::TaskSchedule;

    fn utc(raw: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(raw)
            .unwrap()
            .with_timezone(&Utc)
    }

    fn cron(expression: &str, timezone: &str) -> TaskSchedule {
        TaskSchedule {
            kind: ScheduleKind::Cron,
            cron_expression: Some(expression.to_string()),
            run_at: None,
            timezone: timezone.to_string(),
        }
    }

    fn once(run_at: &str, timezone: &str) -> TaskSchedule {
        TaskSchedule {
            kind: ScheduleKind::Once,
            cron_expression: None,
            run_at: Some(run_at.to_string()),
            timezone: timezone.to_string(),
        }
    }

    #[test]
    fn schedule_validation_covers_required_fields_invalid_values_and_timezones() {
        validate_schedule(&cron("15 9 * * MON-FRI", "America/New_York")).unwrap();
        validate_schedule(&once("2026-04-01T12:00:00Z", "UTC")).unwrap();

        assert!(validate_schedule(&TaskSchedule {
            kind: ScheduleKind::Cron,
            cron_expression: None,
            run_at: None,
            timezone: "UTC".to_string(),
        })
        .is_err());
        assert!(validate_schedule(&TaskSchedule {
            kind: ScheduleKind::Once,
            cron_expression: None,
            run_at: None,
            timezone: "UTC".to_string(),
        })
        .is_err());
        assert!(validate_schedule(&cron("61 * * * *", "UTC")).is_err());
        assert!(validate_schedule(&cron("* * * *", "UTC")).is_err());
        assert!(validate_schedule(&cron("* * * * *", "Mars/Olympus")).is_err());
        assert!(validate_schedule(&once("not-a-date", "UTC")).is_err());
        assert!(validate_schedule(&TaskSchedule {
            kind: ScheduleKind::Cron,
            cron_expression: Some("* * * * *".to_string()),
            run_at: Some("2026-04-01T12:00:00Z".to_string()),
            timezone: "UTC".to_string(),
        })
        .is_err());
        assert!(validate_schedule(&TaskSchedule {
            kind: ScheduleKind::Once,
            cron_expression: Some("* * * * *".to_string()),
            run_at: Some("2026-04-01T12:00:00Z".to_string()),
            timezone: "UTC".to_string(),
        })
        .is_err());
    }

    #[test]
    fn cron_next_run_covers_boundaries_rollovers_and_named_fields() {
        assert_eq!(
            initial_next_run_at(&cron("0 9 * * MON-FRI", "UTC"), utc("2026-04-01T08:00:00Z"))
                .unwrap()
                .unwrap(),
            utc("2026-04-01T09:00:00Z")
        );
        assert_eq!(
            initial_next_run_at(&cron("0 9 * * MON-FRI", "UTC"), utc("2026-04-01T09:00:00Z"))
                .unwrap()
                .unwrap(),
            utc("2026-04-01T09:00:00Z")
        );
        assert_eq!(
            next_future_run_at(&cron("0 9 * * MON-FRI", "UTC"), utc("2026-04-01T09:00:00Z"))
                .unwrap()
                .unwrap(),
            utc("2026-04-02T09:00:00Z")
        );
        assert_eq!(
            initial_next_run_at(&cron("15 * * * *", "UTC"), utc("2026-04-01T10:15:59Z"))
                .unwrap()
                .unwrap(),
            utc("2026-04-01T11:15:00Z")
        );
        assert_eq!(
            initial_next_run_at(&cron("0 0 1 * *", "UTC"), utc("2026-04-30T23:59:00Z"))
                .unwrap()
                .unwrap(),
            utc("2026-05-01T00:00:00Z")
        );
        assert_eq!(
            initial_next_run_at(&cron("0 9 31 * *", "UTC"), utc("2026-04-01T00:00:00Z"))
                .unwrap()
                .unwrap(),
            utc("2026-05-31T09:00:00Z")
        );
        assert_eq!(
            initial_next_run_at(&cron("0 0 29 2 *", "UTC"), utc("2026-03-01T00:00:00Z"))
                .unwrap()
                .unwrap(),
            utc("2028-02-29T00:00:00Z")
        );
    }

    #[test]
    fn cron_next_run_covers_day_of_month_or_day_of_week_semantics() {
        let schedule = cron("0 9 15 * MON", "UTC");
        assert_eq!(
            initial_next_run_at(&schedule, utc("2026-06-13T12:00:00Z"))
                .unwrap()
                .unwrap(),
            utc("2026-06-15T09:00:00Z")
        );
        assert_eq!(
            next_future_run_at(&schedule, utc("2026-06-15T09:00:00Z"))
                .unwrap()
                .unwrap(),
            utc("2026-06-22T09:00:00Z")
        );
    }

    #[test]
    fn cron_next_run_covers_dst_spring_forward_and_fall_back() {
        let spring = cron("30 2 * * *", "America/New_York");
        assert_eq!(
            initial_next_run_at(&spring, utc("2026-03-08T00:00:00Z"))
                .unwrap()
                .unwrap(),
            utc("2026-03-09T06:30:00Z")
        );

        let fall = cron("30 1 * * *", "America/New_York");
        assert_eq!(
            initial_next_run_at(&fall, utc("2026-11-01T05:30:00Z"))
                .unwrap()
                .unwrap(),
            utc("2026-11-01T05:30:00Z")
        );
        assert_eq!(
            next_future_run_at(&fall, utc("2026-11-01T05:30:00Z"))
                .unwrap()
                .unwrap(),
            utc("2026-11-01T06:30:00Z")
        );
    }

    #[test]
    fn once_schedule_next_run_covers_inclusive_and_future_behavior() {
        let schedule = once("2026-04-01T12:30:00Z", "UTC");
        assert_eq!(
            initial_next_run_at(&schedule, utc("2026-04-01T11:00:00Z"))
                .unwrap()
                .unwrap(),
            utc("2026-04-01T12:30:00Z")
        );
        assert_eq!(
            initial_next_run_at(&schedule, utc("2026-04-01T13:00:00Z"))
                .unwrap()
                .unwrap(),
            utc("2026-04-01T12:30:00Z")
        );
        assert_eq!(
            next_future_run_at(&schedule, utc("2026-04-01T12:30:00Z")).unwrap(),
            None
        );
    }
}
