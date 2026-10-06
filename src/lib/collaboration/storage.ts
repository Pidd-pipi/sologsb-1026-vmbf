import type { ConflictSession, Course, QaReport } from './types';

/**
 * 本地协作存储布局：
 * - 课程数据：保存时带课程修订号，跨标签页通过 storage 事件交换。
 * - 冲突会话箱：待处理、已确认、失败的会话都保留，失败后也能找回草稿重试。
 */
const COURSE_KEY = 'sologsb-1026-phonics-course-v2';
const LEGACY_COURSE_KEY = 'sologsb-1026-phonics-course-v1';
const SESSIONS_KEY = 'sologsb-1026-conflict-sessions-v1';
const SESSIONS_FALLBACK_KEY = 'sologsb-1026-conflict-sessions-fallback';
const QA_KEY = 'sologsb-1026-qa-report-v1';
const MAX_SESSIONS = 30;

export const STORAGE_KEYS = { COURSE_KEY, SESSIONS_KEY, QA_KEY };

function safeParse<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function readCourse(): Course | null {
  return safeParse<Course>(localStorage.getItem(COURSE_KEY));
}

export function readLegacyCourse(): unknown {
  return safeParse<unknown>(localStorage.getItem(LEGACY_COURSE_KEY));
}

export function writeCourse(course: Course): void {
  localStorage.setItem(COURSE_KEY, JSON.stringify(course));
}

export function readQaReport(): QaReport | null {
  return safeParse<QaReport>(localStorage.getItem(QA_KEY));
}

export function writeQaReport(report: QaReport): void {
  localStorage.setItem(QA_KEY, JSON.stringify(report));
}

export function readSessions(): ConflictSession[] {
  const primary = safeParse<ConflictSession[]>(localStorage.getItem(SESSIONS_KEY));
  if (primary && primary.length) return primary;
  // localStorage 写满等情况下的兜底：冲突草稿在 sessionStorage 仍可找回。
  return safeParse<ConflictSession[]>(sessionStorage.getItem(SESSIONS_FALLBACK_KEY)) ?? [];
}

export function writeSessions(sessions: ConflictSession[]): void {
  const trimmed = [...sessions]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, MAX_SESSIONS);
  const raw = JSON.stringify(trimmed);
  try {
    localStorage.setItem(SESSIONS_KEY, raw);
    sessionStorage.removeItem(SESSIONS_FALLBACK_KEY);
  } catch {
    sessionStorage.setItem(SESSIONS_FALLBACK_KEY, raw);
  }
}

export function upsertSession(session: ConflictSession): ConflictSession[] {
  const sessions = readSessions().filter((item) => item.id !== session.id);
  sessions.push(session);
  writeSessions(sessions);
  return sessions;
}

export function pendingSession(): ConflictSession | null {
  return readSessions().find((session) => session.status === 'pending') ?? null;
}

export function getTabId(): string {
  const existing = sessionStorage.getItem('sologsb-1026-tab-id');
  if (existing) return existing;
  const id = `tab-${Math.random().toString(36).slice(2, 9)}`;
  sessionStorage.setItem('sologsb-1026-tab-id', id);
  return id;
}

/** 冲突处理失败后找回草稿：导出成可重新导入的 JSON 文件。 */
export function downloadDraft(course: Course, label: string): void {
  const blob = new Blob([JSON.stringify(course, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${label || 'course-draft'}-rev${course.revision}.json`;
  link.click();
  URL.revokeObjectURL(url);
}
