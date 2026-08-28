import { PALETTE, type EntryKind, type SourceType } from './types.js';

/**
 * Session intelligence, as both clients see it.
 *
 * Wire types plus the presentation decisions that must not differ between the
 * web app and the native app: what a section is called, whether its content
 * came from the index or from a model, and how a match reason is phrased. The
 * server owns the ids and the semantics (`packages/core/src/sessionInsights.ts`);
 * this owns the words. A test pins the two id lists together, so a section
 * added on one side cannot silently go unlabelled on the other.
 */

export interface MatchReason {
  kind: 'id' | 'title' | 'file' | 'message' | 'project' | 'cwd' | 'semantic' | 'time';
  detail: string;
  weight: number;
}

export interface SessionExcerpt {
  entryId: number;
  kind: EntryKind;
  occurredAt?: string;
  text: string;
}

export interface SessionCard {
  sessionId: string;
  projectSlug: string;
  machine?: string;
  title: string;
  cwd?: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  promptCount: number;
  actionCount: number;
  entryCount: number;
  fileCount: number;
  filesTouched: string[];
  substance: number;
  score: number;
  why: MatchReason[];
  excerpts: SessionExcerpt[];
  thread?: { size: number; memberIds: string[] };
  ai?: { headline: string; gist: string };
}

export interface SessionSearchResponse {
  sessions: SessionCard[];
  mode: string;
  degraded: boolean;
  tookMs: number;
  interpreted?: { since?: string; until?: string };
  llm?: { status: 'off' | 'ok' | 'unavailable'; reason?: string };
}

export type RelatedLeg = 'file' | 'semantic' | 'temporal';
export type RelatedDirection = 'before' | 'after' | 'overlapping';

export interface RelatedSession extends SessionCard {
  direction: RelatedDirection;
  deltaMs: number;
  legs: { file: number; semantic: number; temporal: number };
  sharedFiles: string[];
}

export interface ContextEvent {
  entryId: number;
  sourceType: SourceType;
  title: string;
  occurredAt?: string;
  sourceRef?: string;
  projectSlug: string;
  sharedFiles: string[];
}

export interface RelatedResponse {
  anchor: SessionCard;
  related: RelatedSession[];
  basis: RelatedLeg[];
  contextEvents?: ContextEvent[];
  tookMs: number;
  note?: string;
}

export interface SessionInsightResponse {
  sessionId: string;
  sections: string[];
  facts: {
    overview: SessionCard & { kindCounts?: Record<string, number> };
    goals?: { entryId: number; occurredAt?: string; text: string }[];
    did?: {
      tools: { name: string; count: number }[];
      files: { path: string; count: number }[];
      commands: { name: string; count: number }[];
      agents: string[];
      totalActions: number;
    };
    highlights?: { entryId: number; kind: EntryKind; occurredAt?: string; text: string }[];
    followupMarkers?: { entryId: number; marker: string; sentence: string; occurredAt?: string }[];
    backlog?: { line: number; text: string; status: string; sourcePath: string; overlap: number }[];
    trail?: {
      entryId: number;
      sourceType: SourceType;
      title: string;
      occurredAt?: string;
      sourceRef?: string;
      sharedFiles?: string[];
    }[];
  };
  narrative?: {
    headline?: string;
    summary?: string[];
    decisions?: { text: string; why?: string }[];
    problems?: { text: string; resolution?: string }[];
    followups?: { text: string; confidence?: string }[];
  };
  llm: { status: 'off' | 'ok' | 'unavailable'; reason?: string; model?: string };
  generatedAt: string;
  cached: boolean;
}

/**
 * Section metadata.
 *
 * `source` is rendered, not just documented: a reader must be able to tell at a
 * glance which parts of a report are indexed fact and which are a model's
 * reading of them. That is the visible half of the trust contract — the other
 * half is that switching the model off leaves a complete report behind.
 */
export interface SessionSectionMeta {
  id: string;
  label: string;
  blurb: string;
  source: 'facts' | 'llm' | 'mixed';
}

export const SESSION_SECTIONS: SessionSectionMeta[] = [
  { id: 'overview', label: 'Overview', blurb: 'When, how long, how much', source: 'facts' },
  { id: 'goals', label: 'What you asked', blurb: 'Your prompts, verbatim', source: 'facts' },
  { id: 'did', label: 'What was done', blurb: 'Files, commands and tools', source: 'facts' },
  { id: 'highlights', label: 'Insights & plans', blurb: 'The distilled prose, verbatim', source: 'facts' },
  { id: 'decisions', label: 'Decisions', blurb: 'What was decided, and why', source: 'llm' },
  { id: 'problems', label: 'Problems', blurb: 'What broke and how it ended', source: 'llm' },
  { id: 'followups', label: 'Left open', blurb: 'Loose ends and follow-ups', source: 'mixed' },
  { id: 'backlog', label: 'Backlog touched', blurb: 'Open items this session may have moved', source: 'facts' },
  { id: 'trail', label: 'Recorded trail', blurb: 'Commits and log entries from the same window', source: 'facts' },
];

export const SESSION_SECTION_IDS = SESSION_SECTIONS.map((s) => s.id);

export function sectionMeta(id: string): SessionSectionMeta {
  return (
    SESSION_SECTIONS.find((s) => s.id === id) ?? { id, label: id, blurb: '', source: 'facts' }
  );
}

/** Badge shown beside anything a model wrote, in both clients. */
export const AI_BADGE = { label: 'AI', color: PALETTE.claude } as const;

export const MATCH_REASON_COLOR: Record<MatchReason['kind'], string> = {
  id: PALETTE.report,
  title: PALETTE.kdb,
  file: PALETTE.git,
  message: PALETTE.claude,
  semantic: PALETTE.claude,
  project: PALETTE.muted,
  cwd: PALETTE.muted,
  time: PALETTE.faint,
};

export const DIRECTION_LABEL: Record<RelatedDirection, string> = {
  before: 'before',
  after: 'after',
  overlapping: 'alongside',
};

/**
 * How confident the relatedness claim is, in words rather than a number.
 *
 * A bare 0.41 invites a reader to treat a heuristic as a measurement. These
 * bands are deliberately coarse, and "loose" is a real, common verdict — most
 * of what shares a fortnight with a session is not related to it.
 */
export function relatedStrength(score: number): 'strong' | 'likely' | 'loose' {
  if (score >= 0.6) return 'strong';
  if (score >= 0.35) return 'likely';
  return 'loose';
}

/**
 * One line explaining what a related-session list is actually based on.
 *
 * Never omitted when the basis is weak: a list built from timestamps alone
 * looks exactly like a list built from shared files, and presenting the two the
 * same way is how a coincidence gets read as a finding.
 */
export function describeBasis(basis: RelatedLeg[]): string {
  const has = (l: RelatedLeg) => basis.includes(l);
  if (has('file') && has('semantic')) return 'Matched on shared files and subject.';
  if (has('file')) return 'Matched on shared files.';
  if (has('semantic')) return 'Matched on subject — these sessions record no shared files.';
  if (has('temporal')) return 'Matched on timing alone — treat as context, not as related work.';
  return 'No basis for comparison was available.';
}

/** Short human label for a session's weight, from the substance prior. */
export function substanceLabel(substance: number): string {
  if (substance >= 0.66) return 'deep session';
  if (substance >= 0.3) return 'working session';
  return 'brief session';
}

/**
 * Compact "3 files · 12 commands" style summary of what a session did.
 * Returns an empty string rather than "0 files" — an empty clause is noise.
 */
export function describeDid(did: SessionInsightResponse['facts']['did']): string {
  if (!did) return '';
  const parts: string[] = [];
  if (did.files.length) parts.push(`${did.files.length} file${did.files.length === 1 ? '' : 's'} edited`);
  if (did.commands.length) parts.push(`${did.commands.length} distinct command${did.commands.length === 1 ? '' : 's'}`);
  if (did.agents.length) parts.push(`${did.agents.length} agent/skill${did.agents.length === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

/** Signed time gap in words, matching the server's own phrasing. */
export function describeDelta(deltaMs: number): string {
  const abs = Math.abs(deltaMs);
  const when = deltaMs >= 0 ? 'later' : 'earlier';
  const mins = Math.round(abs / 60_000);
  if (mins < 1) return 'at the same time';
  if (mins < 60) return `${mins} min ${when}`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} h ${when}`;
  return `${Math.round(hours / 24)} d ${when}`;
}
