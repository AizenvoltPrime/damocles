import { useI18n } from 'vue-i18n';
import { useNow } from '@/composables/useNow';
import { formatClock, formatResetTime } from '@/utils/clock';

type Translate = (key: string, named: Record<string, unknown>) => string;

/**
 * The time a pending switch's text reads: now() reruns its reader each second, time() is the locale's short time, deadline()
 * adds the weekday or the date to a time that is not today.
 */
export interface UpdateClock {
  now(): number;
  time(at: number): string;
  deadline(at: number): { day?: string; time: string };
}

export function useUpdateClock(): UpdateClock {
  const now = useNow();
  const { locale } = useI18n();
  return { now, time: (at) => formatClock(at, locale.value), deadline: (at) => formatResetTime(at, now(), locale.value) };
}

/** A deadline as its sentence says it: "by 16:30" today, "by Saturday 09:00" within a week, "by Jan 22 09:00" further out. */
export function byDeadline(at: number, clock: UpdateClock, t: Translate): string {
  const { day, time } = clock.deadline(at);
  return day === undefined ? t('hostUpdate.byTime', { time }) : t('hostUpdate.byDay', { day, time });
}

/** A required switch's deadline and its distance, ", in 3 h", which live text hides since it changes each minute. */
export function deadlineParts(at: number, clock: UpdateClock, t: Translate): { by: string; left: string } {
  return { by: byDeadline(at, clock, t), left: t('hostUpdate.left', { in: timeLeft(at - clock.now(), t) }) };
}

/** The time left as the countdown shows it, "12:41". */
export function countdownText(ms: number): string {
  const total = Math.ceil(Math.max(0, ms) / 1000);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * The minutes left as every countdown's words count them, rounded up so none says less time than is left (GOV.UK's timeout
 * warning); 0 once the deadline passed.
 */
export function minutesLeft(ms: number): number {
  return Math.max(0, Math.ceil(ms / 60_000));
}

/** A deadline's distance in whole hours or, under an hour, minutes, rounded as main's reminders round it: "in 3 h", "in 45 minutes". */
export function timeLeft(ms: number, t: Translate): string {
  if (ms >= 3_600_000) return t('hostUpdate.inHours', { count: Math.round(ms / 3_600_000) });
  return t('hostUpdate.inMinutes', { count: Math.max(1, Math.ceil(ms / 60_000)) });
}
