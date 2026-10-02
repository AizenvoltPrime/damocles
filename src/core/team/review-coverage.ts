import { isSpecialistFinal } from './review-gate';
import type { StaleSectionInfo } from './scratchpad';
import type {
  AgentRole,
  ReviewCoverageState,
  ReviewDismissal,
  ReviewSignoff,
  ReviewStamp,
  ReviewVerdictInput,
  SpecialistKind,
  TeamAgent,
} from './types';

export type StatusOf = (name: string) => TeamAgent['status'];

/** What the coverage rules read about the team as it stands. */
export interface CoverageView {
  statusOf: StatusOf;
  /** The sections `implementor` authored that `reviewer` has not read at their current version. */
  staleReads: (reviewer: string, implementor: string) => readonly StaleSectionInfo[];
}

export interface RosterMember {
  name: string;
  role: AgentRole;
  /** Null for a specialist that was never spawned. */
  kind: SpecialistKind | null;
}

/**
 * Where one required review stands against the implementor's landed stamp. `covers` is the stamp the
 * reviewer's sign-off holds: undefined with no sign-off, null when it reported before the implementor landed.
 * `unread` is non-empty only for a current approve over sections the implementor changed after it.
 */
export type ReviewState =
  | { kind: 'satisfied'; via: 'approve' | 'dismissal'; stamp: ReviewStamp }
  | { kind: 'changes-requested'; stamp: ReviewStamp }
  | { kind: 'reviewer-final'; status: TeamAgent['status']; stamp: ReviewStamp; covers: ReviewStamp | null | undefined; unread: readonly StaleSectionInfo[] }
  | { kind: 'stale'; stamp: ReviewStamp; covers: ReviewStamp | null | undefined; unread: readonly StaleSectionInfo[] };

export interface UnsatisfiedReview {
  reviewer: string;
  implementor: string;
  state: Exclude<ReviewState, { kind: 'satisfied' }>;
}

/** One required review as the approval gate and the [REVIEW ROUND READY] notice both read it, so the two cannot disagree. */
export interface PairDecision {
  /** Why approving the subject is refused, naming moves that succeed in this state; null when this pair does not block it. */
  error: string | null;
  /** The notice line, which says "approval blocked" exactly when `error` is set. */
  line: string;
}

const sameStamp = (a: ReviewStamp, b: ReviewStamp): boolean => a.attempt === b.attempt && a.round === b.round;

/** Rounds restart on a redispatch, so a later attempt names itself or two different revisions read alike. */
export function formatRevision(stamp: ReviewStamp): string {
  return stamp.attempt === 0 ? `revision ${stamp.round}` : `revision ${stamp.round} of attempt ${stamp.attempt}`;
}

const formatCovers = (covers: ReviewStamp | null | undefined): string => (covers ? formatRevision(covers) : 'no revision');

// Section names are agent-written, so they are quoted as JSON and cannot break a line.
const formatUnread = (unread: readonly StaleSectionInfo[]): string =>
  unread.map((s) => `${JSON.stringify(s.section)} v${s.currentVersion}`).join(', ');

/**
 * Why a checkpoint's coverage cannot be restored onto a team with this roster, or null. The dismissal block
 * prints its names and each `why` unquoted, so every name must be on the roster and every `why` one line.
 */
export function coverageStateError(state: ReviewCoverageState, roster: ReadonlySet<string>): string | null {
  const names = [
    ...state.landed.map(([implementor]) => implementor),
    ...[...state.signoffs, ...state.dismissals].flatMap(([reviewer, entries]) => [reviewer, ...entries.map(([implementor]) => implementor)]),
    ...state.reReviewOwed,
  ];
  const stranger = names.find((name) => !roster.has(name));
  if (stranger !== undefined) return `It names ${JSON.stringify(stranger)}, who is not on the team's roster.`;
  const why = state.dismissals.flatMap(([, entries]) => entries.map(([, d]) => d.why)).find((text) => /[\p{Cc}\u2028\u2029]/u.test(text));
  if (why !== undefined) return `A recorded dismissal is not one line: ${JSON.stringify(why)}.`;
  return null;
}

/** What a stale sign-off covers, for the parenthesis after the landed revision. */
function describeCovers(reviewer: string, state: { covers: ReviewStamp | null | undefined; unread: readonly StaleSectionInfo[] }): string {
  return state.unread.length > 0
    ? `${reviewer} signed off on it but has not read ${formatUnread(state.unread)}`
    : `${reviewer} covers ${formatCovers(state.covers)}`;
}

/**
 * Which reviewer signs off which implementor, and on which landed revision. The one owner of the pairs,
 * the landed stamps, the sign-offs, the dismissals and the owed re-reviews, which must change together.
 * See "A reviewer's sign-off covers one landed revision" in `docs/invariants.md`.
 */
export class ReviewCoverage {
  private reviews = new Map<string, string[]>();
  private landed = new Map<string, ReviewStamp>();
  private signoffs = new Map<string, Map<string, ReviewSignoff>>();
  private dismissals = new Map<string, Map<string, ReviewDismissal>>();
  private reReviewOwed = new Set<string>();

  /**
   * The pairs a spawn of `name` declares, or null for an implementor. Throws on an invalid declaration.
   * An absent `reviews` on a reviewer keeps its previous pairs, which only a redispatch can have. A
   * redispatch may not drop a pair whose review of landed work is unsatisfied: that bypass is a dismissal.
   */
  validateDeclaration(
    name: string,
    kind: SpecialistKind,
    reviews: readonly string[] | undefined,
    roster: readonly RosterMember[],
    view: CoverageView,
  ): string[] | null {
    const next = kind === 'implementor' ? this.validateImplementor(name, reviews) : this.validateReviewer(name, reviews, roster);
    for (const implementor of this.reviewsOf(name)) {
      if (next?.includes(implementor)) continue;
      const blocking = this.unsatisfiedReview(name, implementor, view);
      if (!blocking) continue;
      throw new Error(
        `Cannot drop "${implementor}" from the reviews of "${name}": ${implementor}'s ${formatRevision(blocking.state.stamp)} has landed and ${name}'s review of it is unsatisfied. ` +
        `Keep "${implementor}" in "reviews", or first dismiss that review with team_dismiss_review and a written reason.`,
      );
    }
    return next;
  }

  private validateImplementor(name: string, reviews: readonly string[] | undefined): null {
    if (reviews !== undefined) {
      throw new Error(`"reviews" is only for a reviewer: "${name}" is an implementor, and implementor to implementor cross-review stays advisory. Drop "reviews", or spawn "${name}" with kind 'reviewer'.`);
    }
    return null;
  }

  private validateReviewer(name: string, reviews: readonly string[] | undefined, roster: readonly RosterMember[]): string[] {
    const declared = reviews ?? this.reviews.get(name);
    if (declared === undefined) {
      throw new Error(`"reviews" is required with kind 'reviewer': list the implementors whose work "${name}" reviews, or pass [] if it reviews no implementor's code.`);
    }
    const reviewedBy = this.reviewersOf(name).filter((r) => r !== name);
    if (reviewedBy.length > 0) {
      throw new Error(`"${name}" cannot be a reviewer: "${reviewedBy[0]}" already reviews it, so it is an implementor.`);
    }
    declared.forEach((target, index) => {
      const member = roster.find((m) => m.name === target);
      if (!member) {
        throw new Error(`"reviews" names "${target}", which is not on the roster. Team members: ${roster.map((m) => m.name).join(', ')}.`);
      }
      if (target === name) throw new Error(`"${name}" cannot review itself.`);
      if (member.role === 'lead') throw new Error(`"reviews" names "${target}", the lead. A reviewer reviews implementors only.`);
      if (member.kind === 'reviewer') throw new Error(`"reviews" names "${target}", a reviewer. A reviewer reviews implementors only.`);
      if (declared.indexOf(target) !== index) throw new Error(`"reviews" names "${target}" twice.`);
    });
    return [...declared];
  }

  /** Records a spawn's validated pairs; null drops any pairs the name held as a reviewer. */
  declare(name: string, reviews: string[] | null): void {
    if (reviews === null) this.reviews.delete(name);
    else this.reviews.set(name, reviews);
  }

  /** The declared pairs, or undefined for a name never spawned as a reviewer. */
  declared(reviewer: string): readonly string[] | undefined {
    return this.reviews.get(reviewer);
  }

  reviewsOf(reviewer: string): readonly string[] {
    return this.reviews.get(reviewer) ?? [];
  }

  reviewersOf(implementor: string): string[] {
    return [...this.reviews].filter(([, list]) => list.includes(implementor)).map(([reviewer]) => reviewer);
  }

  hasPairs(): boolean {
    return [...this.reviews.values()].some((list) => list.length > 0);
  }

  /**
   * Lands the implementor's work at `stamp` and returns the reviewers whose sign-off it invalidates, a
   * reviewer that reported with no verdict for it included. A re-land of the same stamp invalidates
   * nothing, so answering a peer never asks for a second re-review.
   */
  land(implementor: string, stamp: ReviewStamp): string[] {
    const previous = this.landed.get(implementor);
    this.landed.set(implementor, stamp);
    if (previous && sameStamp(previous, stamp)) return [];
    return this.reviewersOf(implementor).filter((reviewer) => {
      const reported = this.signoffs.get(reviewer);
      if (!reported) return false;
      const signoff = reported.get(implementor);
      return signoff === undefined || signoff.stamp === null || !sameStamp(signoff.stamp, stamp);
    });
  }

  landedOf(implementor: string): ReviewStamp | undefined {
    return this.landed.get(implementor);
  }

  /**
   * The error for a report whose verdicts do not match the reviewer's pairs, or null. An implementor that
   * has landed nothing has no work to judge, so its verdict may be left out.
   */
  checkVerdicts(reviewer: string, verdicts: readonly ReviewVerdictInput[] | undefined): string | null {
    const reviews = this.reviewsOf(reviewer);
    if (reviews.length === 0) {
      return verdicts === undefined || verdicts.length === 0 ? null : 'Cannot report complete: you review no implementor, so pass no verdicts.';
    }
    const given = (verdicts ?? []).map((v) => v.implementor);
    const missing = reviews.filter((i) => !given.includes(i) && this.landed.has(i));
    const extra = [...new Set(given.filter((i) => !reviews.includes(i)))];
    const repeated = [...new Set(given.filter((i, n) => given.indexOf(i) !== n))];
    if (missing.length === 0 && extra.length === 0 && repeated.length === 0) return null;
    return `Cannot report complete: pass one verdict for each implementor you review (${reviews.join(', ')}), except one that has landed no work yet.` +
      (missing.length > 0 ? ` Missing: ${missing.join(', ')}.` : '') +
      (extra.length > 0 ? ` Not yours to review: ${extra.join(', ')}.` : '') +
      (repeated.length > 0 ? ` Repeated: ${repeated.join(', ')}.` : '');
  }

  /** Records each verdict against the implementor's current stamp and discharges an owed re-review. */
  recordSignoffs(reviewer: string, verdicts: readonly ReviewVerdictInput[]): void {
    const signoffs = new Map<string, ReviewSignoff>();
    for (const { implementor, verdict } of verdicts) {
      signoffs.set(implementor, { stamp: this.landed.get(implementor) ?? null, verdict });
    }
    this.signoffs.set(reviewer, signoffs);
    this.reReviewOwed.delete(reviewer);
  }

  signoffOf(reviewer: string, implementor: string): ReviewSignoff | undefined {
    return this.signoffs.get(reviewer)?.get(implementor);
  }

  isCurrent(reviewer: string, implementor: string): boolean {
    const landed = this.landed.get(implementor);
    const stamp = this.signoffOf(reviewer, implementor)?.stamp;
    return landed !== undefined && stamp !== undefined && stamp !== null && sameStamp(stamp, landed);
  }

  isSatisfied(reviewer: string, implementor: string, view: CoverageView): boolean {
    return this.reviewState(reviewer, implementor, view)?.kind === 'satisfied';
  }

  /**
   * Null while the implementor has no landed work to review. A current approve satisfies the review only
   * while the reviewer has read every section the implementor authored at its current version, since an
   * implementor woken by a peer can change them without landing a new revision.
   */
  reviewState(reviewer: string, implementor: string, view: CoverageView): ReviewState | null {
    const stamp = this.landed.get(implementor);
    if (!stamp) return null;
    const current = this.isCurrent(reviewer, implementor);
    const verdict = this.signoffOf(reviewer, implementor)?.verdict;
    const unread = current && verdict === 'approve' ? view.staleReads(reviewer, implementor) : [];
    if (current && verdict === 'approve' && unread.length === 0) return { kind: 'satisfied', via: 'approve', stamp };
    const dismissal = this.dismissals.get(reviewer)?.get(implementor);
    if (dismissal && sameStamp(dismissal.stamp, stamp)) return { kind: 'satisfied', via: 'dismissal', stamp };
    if (current && verdict === 'changes_requested') return { kind: 'changes-requested', stamp };
    const covers = this.signoffOf(reviewer, implementor)?.stamp;
    const status = view.statusOf(reviewer);
    if (isSpecialistFinal(status)) return { kind: 'reviewer-final', status, stamp, covers, unread };
    return { kind: 'stale', stamp, covers, unread };
  }

  /** Rules B and C: one decision per pair the subject is in, as an implementor (B) or as a reviewer (C). A name is never both. */
  decisions(subject: string, view: CoverageView): PairDecision[] {
    return [
      ...this.reviewersOf(subject).map((reviewer) => this.implementorDecision(reviewer, subject, view)),
      ...this.reviewsOf(subject).map((implementor) => this.reviewerDecision(subject, implementor, view)),
    ];
  }

  /** The error for approving `subject` now, or null when no pair it is in blocks it. */
  checkApproval(subject: string, view: CoverageView): string | null {
    return this.decisions(subject, view).find((d) => d.error !== null)?.error ?? null;
  }

  /** The [REVIEW ROUND READY] coverage lines for a listed specialist: one per pair it is in. */
  noticeLines(subject: string, view: CoverageView): string[] {
    return this.decisions(subject, view).map((d) => d.line);
  }

  /** Rule B: approving `implementor` needs `reviewer`'s review satisfied. */
  private implementorDecision(reviewer: string, implementor: string, view: CoverageView): PairDecision {
    const head = `Cannot approve "${implementor}":`;
    const state = this.reviewState(reviewer, implementor, view);
    if (!state) {
      return {
        error: `${head} it has no landed revision for its reviewer "${reviewer}" to review. Send ${implementor} a revision with team_request_revision so its work lands for review.`,
        line: `reviewed by ${reviewer}: no landed revision [approval blocked: revise ${implementor} with team_request_revision]`,
      };
    }
    const rev = formatRevision(state.stamp);
    switch (state.kind) {
      case 'satisfied':
        return {
          error: null,
          line: state.via === 'approve'
            ? `reviewed by ${reviewer}: APPROVED ${rev} [current]`
            : `reviewed by ${reviewer}: review of ${rev} DISMISSED by you [current]`,
        };
      case 'changes-requested':
        return {
          error: `${head} its reviewer "${reviewer}" requested changes on ${implementor}'s ${rev}. ` +
            `Send ${implementor} a revision with team_request_revision that addresses ${reviewer}'s findings, or dismiss ${reviewer}'s review with team_dismiss_review and a written reason.`,
          line: `reviewed by ${reviewer}: CHANGES REQUESTED on ${rev} [approval blocked: revise or dismiss]`,
        };
      case 'reviewer-final': {
        const completed = state.status === 'completed';
        // A completed member's session has ended and team_redispatch_specialist refuses it, so dismissal is its only move.
        const moves = completed
          ? `Its session has ended and no tool reopens it, so dismiss this review with team_dismiss_review and a written reason.`
          : `Redispatch ${reviewer} with team_redispatch_specialist, or dismiss this review with team_dismiss_review and a written reason.`;
        const missed = state.unread.length > 0
          ? `has not read ${implementor}'s current sections of ${rev} (${formatUnread(state.unread)})`
          : `never reviewed ${implementor}'s ${rev}`;
        return {
          error: `${head} its reviewer "${reviewer}" is ${state.status} and ${missed}. ${moves}`,
          line: `${reviewer} ${state.status}, ${rev} unreviewed [approval blocked: ${completed ? '' : `redispatch ${reviewer} or `}dismiss with team_dismiss_review]`,
        };
      }
      case 'stale': {
        const status = view.statusOf(reviewer);
        const move = status === 'awaiting-review'
          ? `Send ${reviewer} back with team_request_revision asking it to review ${implementor}'s current sections, then approve ${implementor} before ${reviewer}.`
          : `${reviewer} is ${status} and still owes that review, so wait for its report, then approve ${implementor} before ${reviewer}.`;
        const signed = state.unread.length > 0
          ? `APPROVED ${rev} but has not read ${formatUnread(state.unread)}`
          : state.covers ? `signed off on ${formatRevision(state.covers)}` : `no sign-off on ${rev}`;
        return {
          error: `${head} its reviewer "${reviewer}" has not signed off on ${implementor}'s latest revision (${rev}; ${describeCovers(reviewer, state)}). ${move}`,
          line: `reviewed by ${reviewer}: ${signed} [NOT CURRENT, approval blocked]`,
        };
      }
    }
  }

  /** Rule C: approving `reviewer` needs `implementor` final and, if completed, its review satisfied. */
  private reviewerDecision(reviewer: string, implementor: string, view: CoverageView): PairDecision {
    const head = `Cannot approve reviewer "${reviewer}" yet:`;
    const then = `approve ${reviewer} once ${implementor} is final and its review is satisfied.`;
    const status = view.statusOf(implementor);
    if (status === 'pending') {
      return {
        error: `${head} it reviews "${implementor}", which was never spawned. Spawn ${implementor} with team_spawn_specialist or cancel it with team_cancel_specialist; ${then}`,
        line: `reviews ${implementor}: never spawned [approval blocked: spawn it with team_spawn_specialist or cancel it with team_cancel_specialist]`,
      };
    }
    if (status === 'awaiting-review') {
      return {
        error: `${head} it reviews "${implementor}", which is still awaiting-review. Approve or revise ${implementor} first; ${then}`,
        line: `reviews ${implementor}: awaiting review [approval blocked: approve or revise ${implementor} first]`,
      };
    }
    if (!isSpecialistFinal(status)) {
      return {
        error: `${head} it reviews "${implementor}", which is still ${status}. Wait for ${implementor} to report, then approve or revise it; ${then}`,
        line: `reviews ${implementor}: ${status} [approval blocked: wait for ${implementor} to report]`,
      };
    }
    if (status !== 'completed') return { error: null, line: `reviews ${implementor}: ${implementor} ${status}, no review needed` };
    const state = this.reviewState(reviewer, implementor, view);
    if (!state) return { error: null, line: `reviews ${implementor}: ${implementor} completed with no landed revision, no review needed` };
    const rev = formatRevision(state.stamp);
    if (state.kind === 'satisfied') return { error: null, line: `reviews ${implementor}: ${rev} satisfied` };
    if (state.kind === 'changes-requested') {
      return {
        error: `${head} it requested changes on "${implementor}"'s ${rev}, and ${implementor} is completed, so no revision can follow. ` +
          `Dismiss the review with team_dismiss_review and a written reason, then approve ${reviewer}.`,
        line: `reviews ${implementor}: CHANGES REQUESTED on ${rev} [approval blocked: dismiss with team_dismiss_review]`,
      };
    }
    // Approving needs the reviewer awaiting review, where team_request_revision reaches it.
    return {
      error: `${head} "${implementor}" is completed and ${reviewer} has not signed off on its ${rev} (${describeCovers(reviewer, state)}). ` +
        `Send ${reviewer} back with team_request_revision asking it to review ${implementor}'s current sections.`,
      line: `reviews ${implementor}: ${rev} not signed off [approval blocked: send ${reviewer} back with team_request_revision]`,
    };
  }

  /**
   * Dismisses the review bound to the implementor's current stamp. Allowed only when the reviewer is final
   * and not current, or its current verdict requests changes; throws before recording anything otherwise.
   */
  dismiss(reviewer: string, implementor: string, reason: string, view: CoverageView): ReviewDismissal {
    if (!this.reviewsOf(reviewer).includes(implementor)) throw new Error(`Cannot dismiss: "${reviewer}" does not review "${implementor}".`);
    const state = this.reviewState(reviewer, implementor, view);
    if (!state) throw new Error(`Cannot dismiss: "${implementor}" has not landed a revision for review yet.`);
    const rev = formatRevision(state.stamp);
    if (state.kind === 'satisfied') throw new Error(`Cannot dismiss: "${reviewer}"'s review of ${implementor}'s ${rev} is already satisfied.`);
    if (state.kind === 'stale') {
      throw new Error(`Cannot dismiss: "${reviewer}" can still review ${implementor}'s ${rev}. Send it back with team_request_revision instead.`);
    }
    const why = state.kind === 'changes-requested'
      ? `${reviewer} requested changes on it`
      : `${reviewer} is ${state.status} and ${state.unread.length > 0
        ? `has not read ${formatUnread(state.unread)}`
        : state.covers ? `its sign-off covers ${formatRevision(state.covers)}` : 'never reviewed it'}`;
    const dismissal = { stamp: state.stamp, reason, why };
    const byImplementor = this.dismissals.get(reviewer) ?? new Map<string, ReviewDismissal>();
    byImplementor.set(implementor, dismissal);
    this.dismissals.set(reviewer, byImplementor);
    return dismissal;
  }

  /** The unsatisfied review of landed work that is neither cancelled nor failed, or null. */
  private unsatisfiedReview(reviewer: string, implementor: string, view: CoverageView): UnsatisfiedReview | null {
    const status = view.statusOf(implementor);
    if (status === 'cancelled' || status === 'failed') return null;
    const state = this.reviewState(reviewer, implementor, view);
    return state && state.kind !== 'satisfied' ? { reviewer, implementor, state } : null;
  }

  /** Every unsatisfied review of landed work that is not cancelled or failed; synthesis releases standby members as completed. */
  unsatisfied(view: CoverageView): UnsatisfiedReview[] {
    return [...this.reviews].flatMap(([reviewer, implementors]) =>
      implementors.flatMap((implementor) => this.unsatisfiedReview(reviewer, implementor, view) ?? []));
  }

  /** One unsatisfied review: what is unsatisfied, and the lead's move that clears it while the team runs. */
  describeUnsatisfied({ reviewer, implementor, state }: UnsatisfiedReview, view: CoverageView): { fact: string; move: string } {
    const head = `${implementor}, ${formatRevision(state.stamp)}, reviewed by ${reviewer}`;
    if (state.kind === 'changes-requested') {
      const revise = view.statusOf(implementor) === 'awaiting-review' ? `revise ${implementor} with team_request_revision or ` : '';
      return { fact: `${head}: ${reviewer} requested changes`, move: `${revise}dismiss with team_dismiss_review and a written reason` };
    }
    const missed = state.unread.length > 0 ? `has not read ${formatUnread(state.unread)}` : undefined;
    if (state.kind === 'reviewer-final') {
      const redispatch = state.status === 'completed' ? '' : `redispatch ${reviewer} or `;
      return { fact: `${head}: ${reviewer} is ${state.status} and ${missed ?? 'never reviewed it'}`, move: `${redispatch}dismiss with team_dismiss_review and a written reason` };
    }
    const move = view.statusOf(reviewer) === 'awaiting-review' ? `send ${reviewer} back with team_request_revision` : `wait for ${reviewer}'s report`;
    return { fact: `${head}: ${reviewer} ${missed ?? 'has not signed off on it'}`, move };
  }

  /** The system-written block every dismissal puts at the top of the team result, or null with none. */
  dismissalBlock(): string | null {
    const lines = [...this.dismissals].flatMap(([reviewer, byImplementor]) => [...byImplementor].map(([implementor, d]) => {
      const landed = this.landed.get(implementor);
      const superseded = landed && !sameStamp(landed, d.stamp) ? ` (superseded: ${implementor} later landed ${formatRevision(landed)})` : '';
      // The reason is the lead's own text, quoted as JSON so it cannot add a line to this block.
      return `- ${reviewer}'s review of ${implementor}, ${formatRevision(d.stamp)}: ${d.why}. Lead's reason: ${JSON.stringify(d.reason)}${superseded}`;
    }));
    if (lines.length === 0) return null;
    return `REVIEW DISMISSALS (recorded by the system): the lead dismissed these required reviews:\n${lines.join('\n')}`;
  }

  oweReReview(reviewer: string): void {
    this.reReviewOwed.add(reviewer);
  }

  owesReReview(reviewer: string): boolean {
    return this.reReviewOwed.has(reviewer);
  }

  clearReReview(reviewer: string): void {
    this.reReviewOwed.delete(reviewer);
  }

  /** A redispatched reviewer's new attempt has reviewed nothing. Its dismissals stay, bound to their stamps. */
  resetReviewer(reviewer: string): void {
    this.signoffs.delete(reviewer);
    this.reReviewOwed.delete(reviewer);
  }

  /** A redispatched implementor has landed nothing; its reviewers' old sign-offs go stale when the new attempt lands. */
  resetImplementor(implementor: string): void {
    this.landed.delete(implementor);
  }

  serialize(): ReviewCoverageState {
    return {
      landed: [...this.landed].map(([implementor, stamp]) => [implementor, { ...stamp }]),
      signoffs: [...this.signoffs].map(([reviewer, byImplementor]) => [reviewer, [...byImplementor].map(([i, s]) => [i, { ...s }])]),
      dismissals: [...this.dismissals].map(([reviewer, byImplementor]) => [reviewer, [...byImplementor].map(([i, d]) => [i, { ...d }])]),
      reReviewOwed: [...this.reReviewOwed],
    };
  }

  restore(state: ReviewCoverageState): void {
    this.landed = new Map(state.landed);
    this.signoffs = new Map(state.signoffs.map(([reviewer, entries]) => [reviewer, new Map(entries)]));
    this.dismissals = new Map(state.dismissals.map(([reviewer, entries]) => [reviewer, new Map(entries)]));
    this.reReviewOwed = new Set(state.reReviewOwed);
  }
}
