import { log } from '../../../logger';
import type { ProcessorDependencies, MessageProcessor } from '../types';

interface RateLimitInfo {
  status: 'allowed' | 'allowed_warning' | 'rejected';
  resetsAt?: number;
  rateLimitType?: 'five_hour' | 'seven_day' | 'seven_day_opus' | 'seven_day_sonnet' | 'overage';
  utilization?: number;
  overageStatus?: 'allowed' | 'allowed_warning' | 'rejected';
  isUsingOverage?: boolean;
  surpassedThreshold?: number;
}

interface RateLimitEvent {
  type: 'rate_limit_event';
  rate_limit_info: RateLimitInfo;
  uuid?: string;
  session_id?: string;
}

export function createRateLimitProcessor(_deps: ProcessorDependencies): Record<string, MessageProcessor> {
  const handler: MessageProcessor = (message: Record<string, unknown>): void => {
    const event = message as unknown as RateLimitEvent;
    const info = event.rate_limit_info;
    if (!info) return;

    const utilizationPct = typeof info.utilization === 'number'
      ? `${(info.utilization * 100).toFixed(1)}%`
      : 'n/a';
    const resetsAt = typeof info.resetsAt === 'number'
      ? new Date(info.resetsAt * 1000).toISOString()
      : 'n/a';

    log(
      '[StreamingManager] rate_limit_event status=%s type=%s utilization=%s resetsAt=%s overage=%s',
      info.status,
      info.rateLimitType ?? 'n/a',
      utilizationPct,
      resetsAt,
      info.isUsingOverage ? 'yes' : 'no',
    );
  };

  return { 'rate_limit_event': handler };
}
