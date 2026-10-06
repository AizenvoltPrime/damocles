import type { Component } from 'vue';
import {
  ChartLine,
  Check,
  CircleX,
  ClipboardList,
  Eye,
  Gauge,
  Info,
  MessageCircleQuestion,
  MessageSquare,
  Pause,
  PencilLine,
  Reply,
  TriangleAlert,
  Users,
} from 'lucide-vue-next';
import { formatResetTime } from '@/utils/clock';
import type { NotificationBody, NotificationKind, NotificationProject, NoticeSeverity } from '../../preload/notifications';

export type Tone = 'warning' | 'accent' | 'info' | 'success' | 'danger';

interface ToneClasses {
  // the lead on a toast card, whose background never changes
  readonly cardLead: string;
  // the lead on a center row, which takes --d-hover when hovered or focused, so it is the text shade (D48)
  readonly rowLead: string;
  readonly badge: string;
  readonly lifeBar: string;
  // an action pill's tint, and its label on that tint (D48)
  readonly pill: string;
  readonly pillText: string;
}

export const TONE_CLASSES: Readonly<Record<Tone, ToneClasses>> = {
  warning: { cardLead: 'text-(--d-warning)', rowLead: 'text-(--d-warning-text)', badge: 'bg-(--d-warning)', lifeBar: 'bg-(--d-warning)', pill: 'bg-(--d-warning)/16', pillText: 'text-(--d-warning-text)' },
  accent: { cardLead: 'text-(--d-accent)', rowLead: 'text-(--d-accent-text)', badge: 'bg-(--d-accent)', lifeBar: 'bg-(--d-accent)', pill: 'bg-(--d-accent)/16', pillText: 'text-(--d-accent-text)' },
  info: { cardLead: 'text-(--d-info)', rowLead: 'text-(--d-info-text)', badge: 'bg-(--d-info)', lifeBar: 'bg-(--d-info)', pill: 'bg-(--d-info)/16', pillText: 'text-(--d-info-text)' },
  success: { cardLead: 'text-(--d-success)', rowLead: 'text-(--d-success-text)', badge: 'bg-(--d-success)', lifeBar: 'bg-(--d-success)', pill: 'bg-(--d-success)/16', pillText: 'text-(--d-success-text)' },
  danger: { cardLead: 'text-(--d-danger)', rowLead: 'text-(--d-danger-text)', badge: 'bg-(--d-danger)', lifeBar: 'bg-(--d-danger)', pill: 'bg-(--d-danger)/16', pillText: 'text-(--d-danger-text)' },
};

// The prototype's NT_KIND: badge icon, colour and action per kind.
const KINDS: Readonly<Record<NotificationKind, { readonly icon: Component; readonly tone: Tone; readonly actionIcon: Component }>> = {
  approval: { icon: PencilLine, tone: 'warning', actionIcon: Eye },
  plan: { icon: ClipboardList, tone: 'accent', actionIcon: Eye },
  question: { icon: MessageCircleQuestion, tone: 'info', actionIcon: Reply },
  team: { icon: Users, tone: 'warning', actionIcon: Users },
  done: { icon: Check, tone: 'success', actionIcon: MessageSquare },
  error: { icon: Pause, tone: 'danger', actionIcon: MessageSquare },
  limit: { icon: Gauge, tone: 'warning', actionIcon: ChartLine },
};

const NOTICES: Readonly<Record<NoticeSeverity, { readonly icon: Component; readonly tone: Tone }>> = {
  info: { icon: Info, tone: 'info' },
  warning: { icon: TriangleAlert, tone: 'warning' },
  error: { icon: CircleX, tone: 'danger' },
};

export interface NotificationView {
  readonly kind: NotificationKind | 'notice';
  readonly icon: Component;
  readonly tone: Tone;
  // undefined: no project, the app's own avatar shows
  readonly project: NotificationProject | undefined;
  // "Damocles · {where}"
  readonly where: string;
  // empty for a core notice, whose message is the whole text
  readonly title: string;
  readonly lead: string;
  readonly message: string;
  // the primary action of a kind; a notice's actions are its own labels
  readonly action: { readonly label: string; readonly icon: Component } | undefined;
  readonly actions: readonly string[];
  // announced assertively: a prompt that blocks the agent, or a core error
  readonly urgent: boolean;
}

type Translate = (key: string, values?: Record<string, unknown>) => string;

function formatElapsed(ms: number, t: Translate): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return t('notifications.hours', { hours, minutes });
  if (minutes > 0) return t('notifications.minutes', { minutes, seconds });
  return t('notifications.seconds', { seconds });
}

/** "now", "5m ago", "2h ago", as the reference's center rows read. */
export function relativeTime(at: number, now: number, t: Translate): string {
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 60) return t('notifications.now');
  if (seconds < 3600) return t('notifications.minutesAgo', { count: Math.floor(seconds / 60) });
  return t('notifications.hoursAgo', { count: Math.floor(seconds / 3600) });
}

function kindAction(kind: NotificationKind, t: Translate): NotificationView['action'] {
  return { label: t(`notifications.kinds.${kind}.action`), icon: KINDS[kind].actionIcon };
}

/** What a toast or a center row shows for an entry, localized here; the entry itself is data main built. */
export function notificationView(body: NotificationBody, t: Translate, locale: string, now: number): NotificationView {
  if (body.kind === 'notice') {
    const { icon, tone } = NOTICES[body.severity];
    return {
      kind: 'notice',
      icon,
      tone,
      project: undefined,
      where: t(`toasts.${body.severity}`),
      title: '',
      lead: '',
      message: body.message,
      action: undefined,
      actions: body.actions,
      urgent: body.severity === 'error',
    };
  }
  const { icon, tone } = KINDS[body.kind];
  const base = { kind: body.kind, icon, tone, action: kindAction(body.kind, t), actions: [], urgent: body.kind === 'approval' || body.kind === 'question' } as const;
  const resets = (kind: 'limit' | 'error', at: number): string => {
    const reset = formatResetTime(at, now, locale);
    return reset.day === undefined
      ? t(`notifications.kinds.${kind}.resetsAt`, { time: reset.time })
      : t(`notifications.kinds.${kind}.resetsOn`, { day: reset.day, time: reset.time });
  };
  if (body.kind === 'limit' && body.reason === 'usage') {
    const used = t('notifications.kinds.limit.used', { percent: body.utilization });
    return {
      ...base,
      project: undefined,
      where: t('notifications.usage'),
      title: body.planName ? `${body.planName} · ${body.windowLabel}` : body.windowLabel || t('notifications.usage'),
      lead: t('notifications.kinds.limit.lead'),
      message: body.resetsAt === undefined ? used : `${used} ${resets('limit', body.resetsAt)}`,
    };
  }
  const chat = { project: body.chat.project, where: body.chat.project.name, title: body.chat.title || t('notifications.newChat') };
  const text = (lead: string, message: string): Pick<NotificationView, 'lead' | 'message'> => ({ lead, message });
  const parts = ((): Pick<NotificationView, 'lead' | 'message'> => {
    switch (body.kind) {
      case 'approval':
        return body.summary
          ? text(t('notifications.kinds.approval.lead'), body.summary)
          : text(t('notifications.kinds.approval.leadAlone'), t('notifications.kinds.approval.fallback'));
      case 'plan':
        return text(t('notifications.kinds.plan.lead'), body.summary ?? t('notifications.kinds.plan.fallback'));
      case 'question':
        return body.summary
          ? text(t('notifications.kinds.question.lead'), body.summary)
          : text(t('notifications.kinds.question.leadAlone'), t('notifications.kinds.question.fallback'));
      case 'team':
        return text(
          body.agentName ? t('notifications.kinds.team.leadAgent', { name: body.agentName }) : t('notifications.kinds.team.lead'),
          body.summary ?? t('notifications.kinds.team.fallback'),
        );
      case 'done':
        return text(
          t('notifications.kinds.done.lead'),
          body.durationMs === undefined
            ? t('notifications.kinds.done.fallback')
            : t('notifications.kinds.done.duration', { duration: formatElapsed(body.durationMs, t) }),
        );
      case 'error': {
        const lead = t('notifications.kinds.error.lead');
        if (body.reason === 'error') return text(lead, body.message ?? t('notifications.kinds.error.fallback'));
        // D55: only a full usage window says which limit paused the chat and when it resets.
        if (!body.windowLabel) return text(lead, t('notifications.kinds.error.rateLimit'));
        const reached = t('notifications.kinds.error.windowReached', { window: body.windowLabel });
        return text(lead, body.resetsAt === undefined ? reached : `${reached} ${resets('error', body.resetsAt)}`);
      }
      case 'limit':
        return text(t('notifications.kinds.limit.lead'), t('notifications.kinds.limit.budget'));
    }
  })();
  return { ...base, project: chat.project, where: chat.where, title: chat.title, ...parts };
}
