type CronParts = [minute: string, hour: string, dom: string, month: string, dow: string];

function parseParts(cron: string): CronParts | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  return parts as unknown as CronParts;
}

function matchesEntry(value: number, entry: string): boolean {
  if (entry === '*') return true;
  if (entry.startsWith('*/')) {
    const step = parseInt(entry.slice(2), 10);
    return step > 0 && value % step === 0;
  }
  const dashIdx = entry.indexOf('-');
  if (dashIdx > 0) {
    const start = parseInt(entry.slice(0, dashIdx), 10);
    const end = parseInt(entry.slice(dashIdx + 1), 10);
    if (!isNaN(start) && !isNaN(end)) {
      return value >= start && value <= end;
    }
  }
  return parseInt(entry, 10) === value;
}

function matchesField(value: number, field: string): boolean {
  return field.split(',').some(entry => matchesEntry(value, entry.trim()));
}

function matchesCron(date: Date, parts: CronParts): boolean {
  return matchesField(date.getMinutes(), parts[0]) &&
    matchesField(date.getHours(), parts[1]) &&
    matchesField(date.getDate(), parts[2]) &&
    matchesField(date.getMonth() + 1, parts[3]) &&
    matchesField(date.getDay(), parts[4]);
}

export function getNextCronMatch(cron: string, after?: Date): Date | null {
  const p = parseParts(cron);
  if (!p) return null;

  const start = after ?? new Date();
  const candidate = new Date(start);
  candidate.setSeconds(0, 0);
  if (candidate.getTime() <= start.getTime()) {
    candidate.setMinutes(candidate.getMinutes() + 1);
  }

  const maxChecks = 7 * 24 * 60;
  for (let i = 0; i < maxChecks; i++) {
    if (matchesCron(candidate, p)) {
      return candidate;
    }
    candidate.setMinutes(candidate.getMinutes() + 1);
  }
  return null;
}

export function cronToIntervalLabel(cron: string): string {
  const p = parseParts(cron);
  if (!p) return cron;
  const [minute, hour, dom, month, dow] = p;

  if (month !== '*' || dow !== '*') return cron;

  if (minute.startsWith('*/') && hour === '*' && dom === '*') {
    return `every ${minute.slice(2)}m`;
  }
  if (minute === '0' && hour.startsWith('*/') && dom === '*') {
    return `every ${hour.slice(2)}h`;
  }
  if (minute === '0' && hour === '0' && dom.startsWith('*/')) {
    return `every ${dom.slice(2)}d`;
  }

  return cron;
}
