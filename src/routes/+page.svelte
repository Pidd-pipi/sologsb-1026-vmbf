<script lang="ts">
  import { onMount } from 'svelte';
  import {
    Button,
    Checkbox,
    InlineNotification,
    Modal,
    Select,
    SelectItem,
    Tag,
    TextArea,
    TextInput,
    Tile
  } from 'carbon-components-svelte';
  import type {
    Activity,
    ActivityType,
    ConflictSession,
    Course,
    CourseConflict,
    CourseVersion,
    Diagnostic,
    QaReport,
    VersionDiff
  } from '$lib/collaboration/types';
  import { initialCourse, migrateCourse } from '$lib/collaboration/course-data';
  import { analyzeCourse } from '$lib/collaboration/analyze';
  import { mergeCourses } from '$lib/collaboration/merge';
  import { carryUnresolvedConflicts } from '$lib/collaboration/conflict-utils';
  import {
    activitySignature,
    buildResolvedCourse,
    createSession,
    isResolutionComplete,
    isVersionStale,
    markStaleVersions,
    rebaseWorkingDraft,
    uid
  } from '$lib/collaboration/session';
  import {
    STORAGE_KEYS,
    downloadDraft,
    getTabId,
    pendingSession,
    readCourse,
    readLegacyCourse,
    readQaReport,
    readSessions,
    upsertSession,
    writeCourse,
    writeQaReport
  } from '$lib/collaboration/storage';

  type ViewMode = 'compose' | 'path' | 'issues' | 'versions';
  type PreviewWidth = 'phone' | 'tablet' | 'desktop';

  const AUTO_CHECKPOINT_LIMIT = 5;
  let tabId = '';

  let course: Course = initialCourse();
  /** 最近一次与存储一致（已保存）的课程快照，是三路合并的共同祖先。 */
  let baseSnapshot: Course = structuredClone(course);
  let syncedRevision = course.revision;
  let activeSession: ConflictSession | null = null;
  let sessionHistory: ConflictSession[] = [];
  let conflictCenterOpen = false;
  let conflictCenterTab: 'pending' | 'recovery' = 'pending';
  let remoteAhead: { revision: number; title: string } | null = null;
  let remoteAdvancedRevision = 0;
  let mergeNotice = '';
  let qaFlash = false;
  let qaReport: QaReport | null = null;
  let saveError = '';

  let selectedActivityId = course.activities[0]?.id ?? '';
  let activeView: ViewMode = 'compose';
  let previewWidth: PreviewWidth = 'desktop';
  let compareBaseId = '';
  let compareTargetId = course.versions.at(-1)?.id ?? '';
  let hydrated = false;
  let online = true;
  let savedLabel = '等待载入';
  let showOfflineNotice = false;
  let history: Course[] = [];
  let future: Course[] = [];
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let diagnostics: Diagnostic[] = [];
  let versionDiff: VersionDiff[] = [];
  let compareBlocked = '';
  let diffResult: { versionDiff: VersionDiff[]; compareBlocked: string } = { versionDiff: [], compareBlocked: '' };

  let selectedActivity: Activity | null = null;
  $: selectedActivity = course.activities.find((activity) => activity.id === selectedActivityId) ?? course.activities[0] ?? null;
  $: diagnostics = analyzeCourse(course);
  $: diffResult = resolveVersionDiff(course, compareBaseId, compareTargetId);
  $: versionDiff = diffResult.versionDiff;
  $: compareBlocked = diffResult.compareBlocked;
  $: errorCount = diagnostics.filter((issue) => issue.level === 'error').length;
  $: warningCount = diagnostics.filter((issue) => issue.level === 'warning').length;
  $: totalMinutes = course.activities.reduce((sum, activity) => sum + activity.duration, 0);
  $: unresolvedCount = activeSession
    ? activeSession.conflicts.filter((conflict) => !activeSession?.resolutions[conflict.id]).length
    : 0;
  $: structuralConflicts = activeSession?.conflicts.filter((conflict) => conflict.structural) ?? [];
  $: fieldConflicts = activeSession?.conflicts.filter((conflict) => !conflict.structural) ?? [];

  function resolveVersionDiff(current: Course, baseId: string, targetId: string): { versionDiff: VersionDiff[]; compareBlocked: string } {
    const base = current.versions.find((version) => version.id === baseId);
    const target = current.versions.find((version) => version.id === targetId);
    if (!base || !target) return { versionDiff: [], compareBlocked: '' };
    if (isVersionStale(base, current)) return { versionDiff: [], compareBlocked: `「${base.label}」是已过期的未封存快照，不能再用于版本比较。` };
    if (isVersionStale(target, current)) return { versionDiff: [], compareBlocked: `「${target.label}」是已过期的未封存快照，不能再用于版本比较。` };
    return { versionDiff: compareCourseVersions(current, baseId, targetId), compareBlocked: '' };
  }

  onMount(() => {
    tabId = getTabId();
    hydrate();
    hydrated = true;
    const updateNetwork = () => {
      online = navigator.onLine;
      showOfflineNotice = !online;
    };
    updateNetwork();
    window.addEventListener('online', updateNetwork);
    window.addEventListener('offline', updateNetwork);
    window.addEventListener('storage', handleStorage);
    return () => {
      window.removeEventListener('online', updateNetwork);
      window.removeEventListener('offline', updateNetwork);
      window.removeEventListener('storage', handleStorage);
      if (saveTimer) clearTimeout(saveTimer);
    };
  });

  function hydrate(): void {
    let stored = readCourse();
    if (!stored) {
      // 首次升级：沿用 v1 旧数据。
      const legacy = readLegacyCourse() as Course | null;
      if (legacy && legacy.id && Array.isArray(legacy.activities)) stored = migrateCourse(legacy);
    } else {
      stored = migrateCourse(stored);
    }
    if (stored) {
      markStaleVersions(stored);
      course = stored;
      baseSnapshot = structuredClone(stored);
      syncedRevision = stored.revision;
      selectedActivityId = course.activities[0]?.id ?? '';
      compareBaseId = firstUsableVersion(course)?.id ?? '';
      compareTargetId = course.versions.at(-1)?.id ?? '';
      savedLabel = `已恢复 · 修订号 ${stored.revision} · ${formatTime(course.updatedAt)}`;
    } else {
      writeCourse(course);
      baseSnapshot = structuredClone(course);
    }

    qaReport = readQaReport();
    if (qaReport && qaReport.signature !== activitySignature(course)) {
      // 活动已经变过：旧检查结果立即过期，用当前课程重算。
      qaFlash = true;
      persistFreshQa(course);
    }

    const restored = pendingSession();
    sessionHistory = readSessions();
    if (restored) {
      activeSession = restored;
      course = structuredClone(restored.workingCourse ?? restored.provisional);
      conflictCenterTab = 'pending';
      savedLabel = `冲突草稿待确认 · 修订号 ${course.revision}`;
    }
  }

  function firstUsableVersion(current: Course): CourseVersion | undefined {
    return current.versions.find((version) => !isVersionStale(version, current)) ?? current.versions[0];
  }


  function handleStorage(event: StorageEvent): void {
    if (event.key === STORAGE_KEYS.COURSE_KEY && event.newValue) {
      let remote: Course;
      try {
        remote = migrateCourse(JSON.parse(event.newValue) as Course);
      } catch {
        return;
      }
      if (activeSession) {
        if (remote.revision > activeSession.remoteRevision) remoteAdvancedRevision = remote.revision;
        return;
      }
      const localDirty = JSON.stringify(course) !== JSON.stringify(baseSnapshot);
      const replaced = remote.id !== course.id;
      if (remote.revision > syncedRevision || replaced) {
        if (!localDirty) {
          adoptRemoteCourse(remote);
        } else {
          remoteAhead = { revision: remote.revision, title: remote.title };
        }
      }
    } else if (event.key === STORAGE_KEYS.SESSIONS_KEY) {
      sessionHistory = readSessions();
    } else if (event.key === STORAGE_KEYS.QA_KEY && event.newValue && !activeSession) {
      try {
        qaReport = JSON.parse(event.newValue) as QaReport;
      } catch {
        qaReport = null;
      }
    }
  }

  function adoptRemoteCourse(remote: Course): void {
    markStaleVersions(remote);
    course = remote;
    baseSnapshot = structuredClone(remote);
    syncedRevision = remote.revision;
    selectedActivityId = course.activities.find((activity) => activity.id === selectedActivityId)?.id ?? course.activities[0]?.id ?? '';
    remoteAhead = null;
    qaFlash = qaReport ? qaReport.signature !== activitySignature(course) : qaFlash;
    persistFreshQa(course);
    savedLabel = `已同步另一个标签页 · 修订号 ${remote.revision} · ${formatTime(course.updatedAt)}`;
  }

  function commit(recipe: (draft: Course) => void): void {
    history = [...history.slice(-49), structuredClone(course)];
    const next = structuredClone(course);
    recipe(next);
    next.updatedAt = new Date().toISOString();
    // 活动一变：未封存课程版本与旧检查结果立即过期。
    const activitiesChanged = activitySignature(next) !== activitySignature(course);
    markStaleVersions(next);
    course = next;
    future = [];
    if (activitiesChanged) qaFlash = true;
    if (activeSession) {
      saveWorkingDraft();
    } else {
      scheduleSave();
    }
  }

  function scheduleSave(): void {
    if (!hydrated) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => attemptSave(), 600);
  }

  function saveNow(): void {
    if (saveTimer) clearTimeout(saveTimer);
    attemptSave();
  }

  /** 带修订号的协作保存：无对端改动直接快进，否则先合并不重叠字段，冲突则挂起。 */
  function attemptSave(): void {
    if (!hydrated) return;
    saveError = '';
    if (activeSession) {
      saveWorkingDraft();
      savedLabel = '冲突未确认：双方草稿已暂存，确认后再生效';
      conflictCenterOpen = true;
      return;
    }
    try {
      const remote = readCourse();
      const courseReplacedHere = course.id !== baseSnapshot.id;

      if (courseReplacedHere || !remote) {
        // 复制课程产生的是一门全新课程，直接以修订号 1 落盘，不与旧课程做字段合并。
        const next = structuredClone(course);
        next.revision = remote && courseReplacedHere ? 1 : (remote?.revision ?? syncedRevision) + 1;
        successfulWrite(next);
        savedLabel = courseReplacedHere ? `新课程已保存 · 修订号 1` : `已保存 · 修订号 ${next.revision}`;
        return;
      }

      if (remote.revision === syncedRevision) {
        const next = structuredClone(course);
        next.revision = syncedRevision + 1;
        successfulWrite(next);
        savedLabel = `已保存 · 修订号 ${next.revision} · ${formatTime(next.updatedAt)}`;
        return;
      }

      if (remote.revision < syncedRevision) {
        // 存储被回退（例如被清空过），以本页为准重新建立修订号。
        const next = structuredClone(course);
        next.revision = syncedRevision + 1;
        successfulWrite(next);
        savedLabel = `存储版本较旧，已按本页重建 · 修订号 ${next.revision}`;
        return;
      }

      // 对端已写入更新修订号：三路合并。
      const outcome = mergeCourses(baseSnapshot, structuredClone(course), remote);
      if (!outcome.conflicts.length) {
        outcome.merged.revision = remote.revision + 1;
        successfulWrite(outcome.merged);
        mergeNotice = `已自动合并另一个标签页互不重叠的修改，修订号推进到 ${outcome.merged.revision}`;
        savedLabel = `合并保存 · 修订号 ${outcome.merged.revision}`;
      } else {
        openConflictSession(remote, outcome.merged, outcome.conflicts);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '本地存储不可用';
      saveError = `保存失败：${message}。草稿已存入“协作 → 草稿找回”，可下载或重试。`;
      if (activeSession) {
        markSessionFailed(error);
      } else {
        recordFailedSave(message);
      }
    }
  }

  /** 普通保存失败（如 localStorage 写满/不可用）：把本页草稿存成可找回的失败记录。 */
  function recordFailedSave(message: string): void {
    const now = new Date().toISOString();
    const failed: ConflictSession = {
      id: uid('conflict'),
      status: 'failed',
      createdAt: now,
      updatedAt: now,
      baseRevision: baseSnapshot.revision,
      localRevision: syncedRevision,
      remoteRevision: syncedRevision,
      localTabId: tabId,
      conflicts: [],
      resolutions: {},
      baseCourse: structuredClone(baseSnapshot),
      localCourse: structuredClone(course),
      remoteCourse: structuredClone(baseSnapshot),
      workingCourse: structuredClone(course),
      provisional: structuredClone(course),
      note: `保存失败：${message}`
    };
    upsertSession(failed);
    sessionHistory = readSessions();
  }

  function successfulWrite(next: Course): void {
    markStaleVersions(next);
    autoCheckpoint(next);
    next.lastTabId = tabId;
    writeCourse(next);
    const snapshot = structuredClone(next);
    baseSnapshot = snapshot;
    syncedRevision = next.revision;
    course = next;
    remoteAhead = null;
    persistFreshQa(next);
  }

  function openConflictSession(remote: Course, provisional: Course, conflicts: CourseConflict[]): void {
    const session = createSession({
      base: baseSnapshot,
      local: structuredClone(course),
      remote,
      provisional,
      conflicts,
      localTabId: tabId,
      remoteTabId: remote.lastTabId
    });
    activeSession = upsertSession(session).find((item) => item.id === session.id) ?? session;
    course = structuredClone(provisional);
    conflictCenterOpen = true;
    conflictCenterTab = 'pending';
    qaFlash = true;
    savedLabel = `检测到 ${conflicts.length} 处冲突 · 草稿已双方保留，待确认`;
  }

  function saveWorkingDraft(): void {
    if (!activeSession) return;
    activeSession = {
      ...activeSession,
      status: 'pending',
      updatedAt: new Date().toISOString(),
      workingCourse: structuredClone(course),
      remoteRevision: Math.max(activeSession.remoteRevision, remoteAdvancedRevision || activeSession.remoteRevision)
    };
    upsertSession(activeSession);
    sessionHistory = readSessions();
  }

  function chooseResolution(conflictId: string, choice: 'local' | 'remote'): void {
    if (!activeSession) return;
    activeSession = {
      ...activeSession,
      resolutions: { ...activeSession.resolutions, [conflictId]: choice }
    };
    upsertSession(activeSession);
  }

  /** 对端在冲突期间又保存了新修订：用最新双方草稿重新合并，已确认的选择继续沿用。 */
  function retryMerge(quiet = false): boolean {
    if (!activeSession) return false;
    const session = activeSession;
    const remote = readCourse();
    if (!remote) return false;
    if (session.replaced) {
      activeSession = { ...session, remoteCourse: structuredClone(remote), remoteRevision: remote.revision, updatedAt: new Date().toISOString() };
      upsertSession(activeSession);
      remoteAdvancedRevision = 0;
      return true;
    }
    if (!session.baseCourse) return false;
    // 对端又保存了：先把本页挂起期间的草稿变基到最新对端，再以“对端旧版”为祖先做三路合并。
    const rebasedLocal = rebaseWorkingDraft({
      base: structuredClone(session.baseCourse ?? session.remoteCourse),
      remotePrev: structuredClone(session.remoteCourse),
      working: structuredClone(session.workingCourse),
      remoteNext: remote,
      priorConflicts: session.conflicts.map((conflict) => ({
        kind: conflict.kind,
        activityId: conflict.activityId,
        field: conflict.field,
        choice: session.resolutions[conflict.id]
      }))
    });
    const outcome = mergeCourses(structuredClone(session.remoteCourse), rebasedLocal, remote);
    const { conflicts, resolutions: reused } = carryUnresolvedConflicts({
      priorConflicts: session.conflicts,
      priorResolutions: session.resolutions,
      newConflicts: outcome.conflicts,
      localCourse: rebasedLocal,
      remoteCourse: remote
    });
    const mergedSession: ConflictSession = {
      ...session,
      conflicts,
      resolutions: reused,
      remoteCourse: structuredClone(remote),
      remoteRevision: remote.revision,
      baseCourse: structuredClone(session.remoteCourse),
      localCourse: structuredClone(rebasedLocal),
      provisional: structuredClone(outcome.merged),
      workingCourse: structuredClone(outcome.merged),
      updatedAt: new Date().toISOString(),
      status: 'pending'
    };
    activeSession = upsertSession(mergedSession).find((item) => item.id === session.id) ?? mergedSession;
    course = structuredClone(outcome.merged);
    remoteAdvancedRevision = 0;

    if (conflicts.length > 0 && conflicts.every((conflict) => reused[conflict.id])) {
      return confirmResolutions(true);
    }
    if (!quiet && conflicts.length === 0) {
      mergeNotice = '重新合并后已无冲突，所有修改已合并。';
    }
    return conflicts.length === 0 ? confirmResolutions(true) : true;
  }

  function confirmResolutions(auto = false): boolean {
    const session = activeSession;
    if (!session) return false;
    if (!isResolutionComplete(session)) return false;
    try {
      const remote = readCourse();
      if (!session.replaced && remote && remote.revision > session.remoteRevision) {
        retryMerge(true);
        return true;
      }

      let resolved: Course;
      if (session.replaced) {
        const choice = session.resolutions[session.conflicts[0].id];
        if (choice === 'remote' && remote) {
          adoptRemoteCourse(remote);
          finishSession('resolved', '已改用对端课程。');
          conflictCenterOpen = false;
          return true;
        }
        resolved = structuredClone(session.workingCourse);
        resolved.revision = (remote?.revision ?? session.remoteRevision) + 1;
      } else {
        resolved = buildResolvedCourse(session, session.resolutions);
        resolved.revision = (remote?.revision ?? session.remoteRevision) + 1;
      }

      successfulWrite(resolved);
      finishSession('resolved', '冲突已按确认结果合并生效。');
      conflictCenterOpen = false;
      mergeNotice = auto ? '对端的新修订已与你的确认选择自动合并。' : `冲突已解决，修订号推进到 ${resolved.revision}`;
      savedLabel = `冲突已解决 · 修订号 ${resolved.revision}`;
      return true;
    } catch (error) {
      markSessionFailed(error);
      saveError = '冲突确认写入失败，双方草稿已保留，可在“草稿找回”中重试或下载。';
      return false;
    }
  }

  function abandonLocalDraft(): void {
    const session = activeSession;
    if (!session) return;
    const remote = readCourse();
    if (remote) adoptRemoteCourse(remote);
    finishSession('abandoned', '已放弃本页草稿，采用对端课程。');
    conflictCenterOpen = false;
    mergeNotice = '已采用对端课程，本页冲突草稿保留在草稿找回中。';
  }

  function deferConflict(): void {
    if (activeSession) saveWorkingDraft();
    conflictCenterOpen = false;
    if (activeSession) savedLabel = '冲突已挂起：双方草稿保留，可随时从右上角“协作”继续';
  }

  function finishSession(status: 'resolved' | 'abandoned', note: string): void {
    if (!activeSession) return;
    const done = { ...activeSession, status, note, updatedAt: new Date().toISOString() };
    upsertSession(done);
    sessionHistory = readSessions();
    activeSession = null;
    remoteAdvancedRevision = 0;
  }

  function markSessionFailed(error: unknown): void {
    if (!activeSession) return;
    const failed = {
      ...activeSession,
      status: 'failed' as const,
      note: error instanceof Error ? error.message : '写入失败',
      updatedAt: new Date().toISOString()
    };
    activeSession = upsertSession(failed).find((item) => item.id === failed.id) ?? failed;
    sessionHistory = readSessions();
  }

  function resumeSession(session: ConflictSession): void {
    const recovered = structuredClone(session.workingCourse ?? session.localCourse);
    markStaleVersions(recovered);
    if (session.conflicts.length === 0) {
      // 纯保存失败的记录：找回草稿回到编辑态，直接重试保存。
      course = recovered;
      baseSnapshot = session.baseCourse ? structuredClone(session.baseCourse) : baseSnapshot;
      syncedRevision = session.baseRevision;
      conflictCenterOpen = false;
      savedLabel = '已找回保存失败的草稿，正在重试…';
      attemptSave();
      return;
    }
    const resumed: ConflictSession = { ...session, status: 'pending', updatedAt: new Date().toISOString() };
    activeSession = upsertSession(resumed).find((item) => item.id === session.id) ?? resumed;
    course = recovered;
    conflictCenterTab = 'pending';
    conflictCenterOpen = true;
    savedLabel = '已找回冲突草稿，可重新处理';
  }

  function persistFreshQa(current: Course): void {
    qaReport = {
      revision: current.revision,
      signature: activitySignature(current),
      diagnostics: analyzeCourse(current),
      checkedAt: new Date().toISOString()
    };
    try {
      writeQaReport(qaReport);
    } catch {
      // 存储不可用时检查结果仍在内存中实时重算。
    }
  }

  function autoCheckpoint(current: Course): void {
    const signature = activitySignature(current);
    const unsealed = current.versions.filter((version) => !version.sealed);
    const latest = unsealed.at(-1);
    if (latest && !latest.stale) {
      const snapshotCourse = { ...current, activities: latest.activities };
      if (activitySignature(snapshotCourse) === signature) {
        latest.revision = current.revision;
        return;
      }
    }
    current.versions.push({
      id: uid('v'),
      label: `自动草稿 ${current.revision}`,
      savedAt: new Date().toISOString(),
      note: '保存时自动生成的未封存快照，活动再变化即过期。',
      activities: structuredClone(current.activities),
      sealed: false,
      revision: current.revision,
      stale: false
    });
    // 未封存快照只保留最近的若干份，封存版本永不清退。
    const allUnsealed = current.versions.filter((version) => !version.sealed);
    if (allUnsealed.length > AUTO_CHECKPOINT_LIMIT) {
      const drop = new Set(allUnsealed.slice(0, allUnsealed.length - AUTO_CHECKPOINT_LIMIT).map((version) => version.id));
      current.versions = current.versions.filter((version) => !drop.has(version.id));
    }
  }

  function undo(): void {
    const previous = history.at(-1);
    if (!previous) return;
    future = [structuredClone(course), ...future].slice(0, 50);
    history = history.slice(0, -1);
    course = previous;
    markStaleVersions(course);
    selectedActivityId = course.activities[0]?.id ?? '';
    if (activeSession) saveWorkingDraft(); else scheduleSave();
  }

  function redo(): void {
    const next = future[0];
    if (!next) return;
    history = [...history, structuredClone(course)].slice(-50);
    future = future.slice(1);
    course = next;
    markStaleVersions(course);
    selectedActivityId = course.activities[0]?.id ?? '';
    if (activeSession) saveWorkingDraft(); else scheduleSave();
  }

  function updateCourse(field: 'title' | 'level' | 'ageRange' | 'objective', value: string): void {
    commit((draft) => { draft[field] = value; });
  }

  function updateActivity(field: keyof Activity, value: unknown): void {
    if (!selectedActivity) return;
    const id = selectedActivity.id;
    commit((draft) => {
      const target = draft.activities.find((activity) => activity.id === id);
      if (target) (target as unknown as Record<string, unknown>)[field] = value;
    });
  }

  function readText(event: Event): string {
    const custom = event as CustomEvent<{ value?: string; text?: string } | string>;
    if (typeof custom.detail === 'string') return custom.detail;
    if (typeof custom.detail === 'number') return String(custom.detail);
    if (custom.detail?.value) return custom.detail.value;
    if (custom.detail?.text) return custom.detail.text;
    const target = (event.currentTarget ?? event.target) as HTMLInputElement | HTMLTextAreaElement | null;
    return target?.value ?? '';
  }

  function readNumber(event: Event): number {
    return Number(readText(event));
  }

  function readChecked(event: Event): boolean {
    const custom = event as CustomEvent<{ checked?: boolean } | boolean>;
    if (typeof custom.detail === 'boolean') return custom.detail;
    if (typeof custom.detail?.checked === 'boolean') return custom.detail.checked;
    const target = (event.currentTarget ?? event.target) as HTMLInputElement | null;
    return Boolean(target?.checked);
  }

  function addActivity(type: ActivityType = '练习'): void {
    const id = `a-${Date.now().toString(36)}-${tabId.slice(-4)}`;
    commit((draft) => {
      draft.activities.push({
        id, type, title: `新的${type}活动`, content: '', phonemes: [], dependencies: [],
        difficulty: 1, prompt: '请输入教师提示语。', accessibility: '请描述视觉、听觉或键盘无障碍支持。',
        duration: type === '练习' ? 10 : 8, feedback: ''
      });
    });
    selectedActivityId = id;
    activeView = 'compose';
  }

  function deleteActivity(): void {
    if (!selectedActivity || course.activities.length <= 1) return;
    const id = selectedActivity.id;
    commit((draft) => {
      draft.activities = draft.activities.filter((activity) => activity.id !== id);
      draft.activities.forEach((activity) => {
        activity.dependencies = activity.dependencies.filter((dependency) => dependency !== id);
      });
    });
    selectedActivityId = course.activities[0]?.id ?? '';
  }

  function duplicateActivity(): void {
    if (!selectedActivity) return;
    const source = structuredClone(selectedActivity);
    source.id = `a-${Date.now().toString(36)}-${tabId.slice(-4)}`;
    source.title = `${source.title}（副本）`;
    source.dependencies = [...source.dependencies];
    commit((draft) => {
      const index = draft.activities.findIndex((activity) => activity.id === selectedActivity?.id);
      draft.activities.splice(index + 1, 0, source);
    });
    selectedActivityId = source.id;
  }

  function moveActivity(direction: -1 | 1): void {
    if (!selectedActivity) return;
    const id = selectedActivity.id;
    commit((draft) => {
      const index = draft.activities.findIndex((activity) => activity.id === id);
      const nextIndex = index + direction;
      if (nextIndex < 0 || nextIndex >= draft.activities.length) return;
      const [item] = draft.activities.splice(index, 1);
      draft.activities.splice(nextIndex, 0, item);
    });
  }

  function toggleDependency(dependencyId: string, checked: boolean): void {
    if (!selectedActivity || dependencyId === selectedActivity.id) return;
    const next = checked
      ? [...new Set([...selectedActivity.dependencies, dependencyId])]
      : selectedActivity.dependencies.filter((id) => id !== dependencyId);
    updateActivity('dependencies', next);
  }

  function updatePhonemes(value: string): void {
    updateActivity('phonemes', value.split(/[\s,，、]+/).map((item) => item.trim()).filter(Boolean));
  }

  function saveVersion(): void {
    const versionNumber = course.versions.filter((version) => version.sealed).length + 1;
    commit((draft) => {
      draft.versions.push({
        id: uid('v'), label: `封存版本 ${versionNumber}`, savedAt: new Date().toISOString(),
        note: `封存 ${draft.activities.length} 个活动，总计 ${draft.activities.reduce((sum, item) => sum + item.duration, 0)} 分钟。封存后不会过期。`,
        activities: structuredClone(draft.activities),
        sealed: true,
        revision: draft.revision,
        stale: false
      });
    });
    const latest = course.versions.at(-1);
    compareTargetId = latest?.id ?? '';
    if (!compareBaseId) compareBaseId = firstUsableVersion(course)?.id ?? '';
    savedLabel = '版本已封存';
    saveNow();
  }

  function copyCourse(): void {
    commit((draft) => {
      const copy = structuredClone(draft);
      copy.id = `course-${Date.now().toString(36)}-${tabId.slice(-4)}`;
      copy.title = `${copy.title} · 副本`;
      copy.versions = [];
      copy.revision = 1;
      copy.activities.forEach((activity) => {
        activity.title = activity.title.replace('（副本）', '').replace('（复制）', '') + '（复制）';
      });
      draft.id = copy.id;
      draft.title = copy.title;
      draft.versions = copy.versions;
      draft.activities = copy.activities;
      draft.revision = 1;
    });
    savedLabel = '课程已复制为新草稿';
    saveNow();
  }

  function reuseVersion(version: CourseVersion): void {
    if (isVersionStale(version, course)) return;
    commit((draft) => {
      draft.activities = structuredClone(version.activities);
    });
    selectedActivityId = course.activities[0]?.id ?? '';
    activeView = 'compose';
    savedLabel = `已把「${version.label}」的活动复制回草稿`;
  }

  function focusIssue(issue: Diagnostic): void {
    selectedActivityId = issue.activityId;
    activeView = 'compose';
  }

  function compareCourseVersions(current: Course, baseId: string, targetId: string): VersionDiff[] {
    const base = current.versions.find((version) => version.id === baseId);
    const target = current.versions.find((version) => version.id === targetId);
    if (!base || !target) return [];
    const rows: VersionDiff[] = [];
    const baseMap = new Map(base.activities.map((activity) => [activity.id, activity]));
    const targetMap = new Map(target.activities.map((activity) => [activity.id, activity]));
    for (const activity of base.activities) {
      if (!targetMap.has(activity.id)) rows.push({ id: activity.id, title: activity.title, kind: 'removed', detail: '目标版本已删除该活动' });
    }
    for (const activity of target.activities) {
      const before = baseMap.get(activity.id);
      if (!before) {
        rows.push({ id: activity.id, title: activity.title, kind: 'added', detail: `${activity.type} · ${activity.duration} 分钟` });
        continue;
      }
      const fields: string[] = [];
      if (before.title !== activity.title) fields.push('标题');
      if (before.content !== activity.content) fields.push('内容');
      const beforePhonemes = [...before.phonemes].sort();
      const afterPhonemes = [...activity.phonemes].sort();
      if (JSON.stringify(beforePhonemes) !== JSON.stringify(afterPhonemes)) fields.push('音素');
      if (before.difficulty !== activity.difficulty) fields.push('难度');
      if (before.duration !== activity.duration) fields.push('时长');
      if (JSON.stringify([...before.dependencies].sort()) !== JSON.stringify([...activity.dependencies].sort())) fields.push('依赖');
      if (before.prompt !== activity.prompt || before.accessibility !== activity.accessibility) fields.push('提示或无障碍');
      if (before.feedback !== activity.feedback) fields.push('练习反馈');
      if (fields.length) rows.push({ id: activity.id, title: activity.title, kind: 'changed', detail: `变化字段：${fields.join('、')}` });
    }
    return rows;
  }

  function formatTime(value: string): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
  }

  function sessionStatusLabel(session: ConflictSession): string {
    return session.status === 'pending' ? '待确认' : session.status === 'resolved' ? '已生效' : session.status === 'abandoned' ? '已放弃' : '处理失败';
  }

  function handleKeyboard(event: KeyboardEvent): void {
    const modifier = event.ctrlKey || event.metaKey;
    const tag = (event.target as HTMLElement)?.tagName;
    const editing = tag === 'INPUT' || tag === 'TEXTAREA' || (event.target as HTMLElement)?.isContentEditable;
    if (modifier && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      event.shiftKey ? redo() : undo();
      return;
    }
    if (modifier && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      redo();
      return;
    }
    if (modifier && event.key.toLowerCase() === 's') {
      event.preventDefault();
      saveNow();
      return;
    }
    if (event.altKey && event.key.toLowerCase() === 'n') {
      event.preventDefault();
      addActivity('练习');
      return;
    }
    if (!editing && event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault();
      moveActivity(event.key === 'ArrowUp' ? -1 : 1);
    }
  }
</script>

<svelte:window on:keydown={handleKeyboard} />

<div class="app-frame">
  <header class="app-header">
    <div class="brand">
      <div class="brand-symbol" aria-hidden="true"><span>a</span><i>+</i><span>m</span></div>
      <div>
        <h1>Phonics Studio</h1>
        <p>儿童自然拼读课程编排台</p>
      </div>
    </div>
    <div class="header-center">
      <span class:connected={online} class="network-dot"></span>
      <span>{online ? '本地离线编辑可用' : '当前离线，修改仍会保存'}</span>
      <strong>{savedLabel}</strong>
      <Tag type={activeSession ? 'red' : 'cool-gray'}>修订号 r{course.revision}{activeSession ? ' · 冲突挂起' : ''}</Tag>
    </div>
    <div class="header-actions">
      <Button size="small" kind="ghost" disabled={history.length === 0} on:click={undo}>撤销</Button>
      <Button size="small" kind="ghost" disabled={future.length === 0} on:click={redo}>重做</Button>
      <Button size="small" kind="tertiary" on:click={saveNow}>保存</Button>
      <Button size="small" kind={activeSession ? 'danger' : 'primary'} on:click={() => { conflictCenterOpen = true; conflictCenterTab = activeSession ? 'pending' : 'recovery'; }}>
        协作{activeSession ? `（${unresolvedCount}）` : ''}
      </Button>
      <Button size="small" kind="primary" on:click={saveVersion}>封存版本</Button>
    </div>
  </header>

  {#if showOfflineNotice}
    <div class="offline-notice">
      <InlineNotification lowContrast kind="info" title="已切换到离线模式" subtitle="所有修改会先保存在本机浏览器，恢复网络后仍可继续编辑。" />
    </div>
  {/if}

  {#if activeSession}
    <div class="collab-banner conflict-banner">
      <InlineNotification
        lowContrast
        kind="warning"
        title={`多标签页修改冲突：${activeSession.conflicts.length} 处待确认（其中结构冲突 ${structuralConflicts.length} 处）`}
        subtitle="双方草稿与冲突说明都已保留，互不重叠的修改已自动合并；活动顺序、依赖、音素等待确认项确认后才会生效。"
        on:click={() => { conflictCenterOpen = true; conflictCenterTab = 'pending'; }}
      >
        <svelte:fragment slot="actions">
          <Button size="small" kind="danger-tertiary" on:click={() => { conflictCenterOpen = true; conflictCenterTab = 'pending'; }}>处理冲突</Button>
        </svelte:fragment>
      </InlineNotification>
    </div>
  {/if}

  {#if remoteAhead && !activeSession}
    <div class="collab-banner">
      <InlineNotification
        lowContrast
        kind="info"
        title={`另一个标签页已保存「${remoteAhead.title}」修订号 r${remoteAhead.revision}`}
        subtitle="你这边也有未保存修改。点击保存后会先自动合并互不重叠的字段；若顺序、依赖或音素被同时修改，会请你逐项确认。"
      >
        <svelte:fragment slot="actions">
          <Button size="small" kind="tertiary" on:click={saveNow}>立即合并保存</Button>
        </svelte:fragment>
      </InlineNotification>
    </div>
  {/if}

  {#if mergeNotice}
    <div class="collab-banner">
      <InlineNotification lowContrast kind="success" title={mergeNotice} on:close={() => mergeNotice = ''} />
    </div>
  {/if}

  {#if saveError}
    <div class="collab-banner">
      <InlineNotification lowContrast kind="error" title={saveError} on:close={() => saveError = ''}>
        <svelte:fragment slot="actions">
          <Button size="small" kind="danger" on:click={() => downloadDraft(course, course.title)}>下载本页草稿</Button>
        </svelte:fragment>
      </InlineNotification>
    </div>
  {/if}

  {#if qaFlash}
    <div class="collab-banner">
      <InlineNotification
        lowContrast
        kind="info"
        title="活动已变化：旧检查结果与未封存版本已标记过期并按当前草稿重算"
        subtitle="过期的未封存快照不能再用于版本比较或复制；封存版本不受影响。"
        on:close={() => qaFlash = false}
      />
    </div>
  {/if}

  <section class="course-hero">
    <div class="hero-copy">
      <span class="kicker">COURSE BUILDER / {course.level}</span>
      <h2>{course.title}</h2>
      <p>{course.objective}</p>
    </div>
    <div class="hero-stats">
      <div><strong>{course.activities.length}</strong><span>活动</span></div>
      <div><strong>{totalMinutes}</strong><span>分钟</span></div>
      <div><strong class="critical">{errorCount}</strong><span>必修问题</span></div>
      <div><strong class="caution">{warningCount}</strong><span>建议调整</span></div>
    </div>
  </section>

  <nav class="workspace-tabs" aria-label="工作区">
    <button class:active={activeView === 'compose'} on:click={() => activeView = 'compose'}><span>01</span><b>课程编排</b><small>活动、依赖与教学说明</small></button>
    <button class:active={activeView === 'path'} on:click={() => activeView = 'path'}><span>02</span><b>学习路径</b><small>多屏幕顺序预览</small></button>
    <button class:active={activeView === 'issues'} on:click={() => activeView = 'issues'}><span>03</span><b>质量检查</b><small>音素、句子与反馈</small></button>
    <button class:active={activeView === 'versions'} on:click={() => activeView = 'versions'}><span>04</span><b>版本与复用</b><small>复制、封存与比较</small></button>
  </nav>

  {#if activeView === 'compose'}
    <main class="compose-layout">
      <aside class="activity-sidebar">
        <div class="sidebar-heading">
          <div><span class="kicker">LESSON MAP</span><h3>学习活动</h3></div>
          <Button size="small" kind="ghost" on:click={() => addActivity('练习')}>添加</Button>
        </div>
        <div class="type-legend">
          {#each ['音素', '单词', '句子', '练习'] as type}
            <span><i class:practice={type === '练习'} class:phoneme={type === '音素'}></i>{type}</span>
          {/each}
        </div>
        <div class="activity-list">
          {#each course.activities as activity, index (activity.id)}
            <button class:selected={activity.id === selectedActivityId} class="activity-row" on:click={() => selectedActivityId = activity.id}>
              <span class="sequence">{String(index + 1).padStart(2, '0')}</span>
              <span class="activity-type {activity.type}">{activity.type}</span>
              <span class="activity-copy"><b>{activity.title}</b><small>{activity.duration} 分钟 · 难度 {activity.difficulty}/5</small></span>
              {#if activity.dependencies.length}<i title="有前置依赖">↳</i>{/if}
            </button>
          {/each}
        </div>
        <div class="sidebar-help">快捷键：Alt + N 新建 · Alt + ↑/↓ 调整顺序</div>
      </aside>

      <section class="editor-column">
        {#if selectedActivity}
          <div class="editor-toolbar">
            <div>
              <span class="kicker">ACTIVITY EDITOR</span>
              <h3>{selectedActivity.type}活动</h3>
            </div>
            <div>
              <Button size="small" kind="ghost" disabled={course.activities[0]?.id === selectedActivity.id} on:click={() => moveActivity(-1)}>上移</Button>
              <Button size="small" kind="ghost" disabled={course.activities.at(-1)?.id === selectedActivity.id} on:click={() => moveActivity(1)}>下移</Button>
              <Button size="small" kind="ghost" on:click={duplicateActivity}>复制</Button>
              <Button size="small" kind="danger-ghost" on:click={deleteActivity}>删除</Button>
            </div>
          </div>

          <Tile class="editor-card">
            <div class="form-grid">
              <TextInput labelText="活动标题" value={selectedActivity.title} on:input={(event) => updateActivity('title', readText(event))} />
              <Select labelText="活动类型" selected={selectedActivity.type} on:change={(event) => updateActivity('type', readText(event))}>
                <SelectItem value="音素" text="音素" />
                <SelectItem value="单词" text="单词" />
                <SelectItem value="句子" text="句子" />
                <SelectItem value="练习" text="练习活动" />
              </Select>
              <TextInput labelText="预计时长（分钟）" type="number" min="1" max="60" value={String(selectedActivity.duration)} on:input={(event) => updateActivity('duration', readNumber(event))} />
              <div class="difficulty-field">
                <label for="difficulty">难度：{selectedActivity.difficulty}/5</label>
                <input id="difficulty" type="range" min="1" max="5" value={selectedActivity.difficulty} on:input={(event) => updateActivity('difficulty', readNumber(event))} />
              </div>
            </div>
            <TextArea labelText={selectedActivity.type === '音素' ? '音素内容' : selectedActivity.type === '句子' ? '目标句子' : '教学内容'} rows={3} value={selectedActivity.content} on:input={(event) => updateActivity('content', readText(event))} />
            <TextInput labelText="涉及音素（用逗号或空格分隔）" value={selectedActivity.phonemes.join(', ')} on:input={(event) => updatePhonemes(readText(event))} />
            <TextArea labelText="教师提示语" rows={2} value={selectedActivity.prompt} on:input={(event) => updateActivity('prompt', readText(event))} />
            <TextArea labelText="无障碍说明" rows={2} value={selectedActivity.accessibility} on:input={(event) => updateActivity('accessibility', readText(event))} />
            <TextArea labelText={selectedActivity.type === '练习' ? '练习反馈（必填）' : '学习反馈'} rows={2} value={selectedActivity.feedback} on:input={(event) => updateActivity('feedback', readText(event))} />
          </Tile>

          <Tile class="dependency-card">
            <div class="section-title">
              <div><span class="kicker">PREREQUISITES</span><h3>前置活动与依赖关系</h3><p>只有完成选中的活动后，系统才会按当前顺序推荐本活动。</p></div>
              <Tag type="cool-gray">{selectedActivity.dependencies.length} 个依赖</Tag>
            </div>
            <div class="dependency-grid">
              {#each course.activities.filter((activity) => activity.id !== selectedActivity?.id) as activity (activity.id)}
                <Checkbox
                  labelText={`${activity.title} · ${activity.type}`}
                  checked={selectedActivity.dependencies.includes(activity.id)}
                  on:change={(event) => toggleDependency(activity.id, readChecked(event))}
                />
              {/each}
            </div>
          </Tile>
        {/if}
      </section>

      <aside class="inspector">
        <Tile class="compact-card">
          <span class="kicker">COURSE META</span><h3>课程信息</h3>
          <TextInput labelText="课程名称" value={course.title} on:input={(event) => updateCourse('title', readText(event))} />
          <TextInput labelText="课程等级" value={course.level} on:input={(event) => updateCourse('level', readText(event))} />
          <TextInput labelText="适用年龄" value={course.ageRange} on:input={(event) => updateCourse('ageRange', readText(event))} />
          <TextArea labelText="学习目标" rows={3} value={course.objective} on:input={(event) => updateCourse('objective', readText(event))} />
        </Tile>
        <Tile class="compact-card issue-peek">
          <div class="section-title"><div><span class="kicker">LIVE CHECK</span><h3>实时提示</h3></div><Tag type={errorCount ? 'red' : 'green'}>{errorCount ? `${errorCount} 项` : '已重算'}</Tag></div>
          {#if qaFlash}<p class="stale-note">活动变化后检查结果已过期，以下为按最新草稿的重算结果。</p>{/if}
          {#each diagnostics.slice(0, 4) as issue}
            <button on:click={() => focusIssue(issue)} class="peek-row">
              <i class:error={issue.level === 'error'} class:warning={issue.level === 'warning'}></i>
              <span><b>{issue.title}</b><small>{issue.category}</small></span>
            </button>
          {/each}
          {#if diagnostics.length === 0}<p class="empty-state">课程结构完整，没有发现提示。</p>{/if}
          <Button size="small" kind="ghost" on:click={() => activeView = 'issues'}>查看全部检查</Button>
        </Tile>
      </aside>
    </main>
  {/if}

  {#if activeView === 'path'}
    <main class="path-view">
      <div class="path-toolbar">
        <div><span class="kicker">RESPONSIVE SEQUENCE</span><h2>学习顺序预览</h2><p>按活动依赖和课程顺序生成，可切换设备宽度检查信息密度。</p></div>
        <div class="width-switcher">
          <button class:active={previewWidth === 'phone'} on:click={() => previewWidth = 'phone'}>手机</button>
          <button class:active={previewWidth === 'tablet'} on:click={() => previewWidth = 'tablet'}>平板</button>
          <button class:active={previewWidth === 'desktop'} on:click={() => previewWidth = 'desktop'}>桌面</button>
        </div>
      </div>
      <div class="preview-stage">
        <div class="device-preview {previewWidth}">
          <div class="device-bar"><span></span><b>{previewWidth === 'phone' ? '390 px' : previewWidth === 'tablet' ? '768 px' : '1200 px'} · r{course.revision}</b></div>
          <div class="lesson-preview">
            <header><span>今日学习</span><h3>{course.title}</h3><p>{course.objective}</p></header>
            {#each course.activities as activity, index (activity.id)}
              <article>
                <div class="lesson-number">{index + 1}</div>
                <div class="lesson-type {activity.type}">{activity.type}</div>
                <div class="lesson-content">
                  <h4>{activity.title}</h4>
                  <p>{activity.content}</p>
                  {#if activity.prompt}<blockquote>{activity.prompt}</blockquote>{/if}
                  <div class="lesson-tags">
                    {#each activity.phonemes as phoneme}<span>{phoneme}</span>{/each}
                    <em>{activity.duration} 分钟</em>
                  </div>
                  {#if activity.dependencies.length}<small>前置：{activity.dependencies.map((id) => course.activities.find((item) => item.id === id)?.title).filter(Boolean).join('、')}</small>{/if}
                </div>
              </article>
            {/each}
            <footer>课程结束 · 预计 {totalMinutes} 分钟</footer>
          </div>
        </div>
      </div>
    </main>
  {/if}

  {#if activeView === 'issues'}
    <main class="issues-view">
      <div class="view-heading">
        <div><span class="kicker">CURRICULUM QA</span><h2>课程质量检查</h2><p>检查前置知识、相似音、例句长度、练习反馈、无障碍说明和依赖完整性。活动每次变化都会立即重算。</p></div>
        <div class="issue-summary">
          <span><b>{errorCount}</b> 必须处理</span>
          <span><b>{warningCount}</b> 建议调整</span>
          <span><b>{diagnostics.length}</b> 当前结果</span>
          <span><b>r{course.revision}</b> 修订号</span>
        </div>
      </div>
      {#if qaFlash}
        <InlineNotification class="qa-stale" lowContrast kind="info" title="旧检查结果已过期" subtitle="检测到活动顺序、依赖或音素等变化，以下结果已按最新草稿重算；封存前的未封存版本不可再用于比较或复制。" on:close={() => qaFlash = false} />
      {/if}
      <div class="issue-board">
        {#each diagnostics as issue, index}
          <article class:critical={issue.level === 'error'} class:caution={issue.level === 'warning'} class:info={issue.level === 'info'}>
            <span class="issue-index">{String(index + 1).padStart(2, '0')}</span>
            <div><div class="issue-meta"><Tag type={issue.level === 'error' ? 'red' : issue.level === 'warning' ? 'magenta' : 'blue'}>{issue.category}</Tag><small>{issue.level === 'error' ? '必须处理' : issue.level === 'warning' ? '建议调整' : '教学提示'}</small></div><h3>{issue.title}</h3><p>{issue.detail}</p></div>
            <Button size="small" kind="ghost" on:click={() => focusIssue(issue)}>定位活动</Button>
          </article>
        {:else}
          <Tile class="all-clear"><h3>课程检查通过</h3><p>教学顺序、反馈与无障碍说明均已完成。</p></Tile>
        {/each}
        {#if diagnostics.length}
          <div class="rule-grid">
            <Tile><span>前置知识</span><strong>先教后用</strong><p>非音素活动使用未单独教学的音素时阻断。</p></Tile>
            <Tile><span>相似音</span><strong>对比教学</strong><p>发现 /b/-/p/、/f/-/v/ 等音对时建议增加辨音。</p></Tile>
            <Tile><span>例句</span><strong>≤ 12 词</strong><p>超过建议长度时提示拆分意群。</p></Tile>
            <Tile><span>练习</span><strong>必须有反馈</strong><p>每个练习活动都要提供可行动反馈。</p></Tile>
          </div>
        {/if}
      </div>
    </main>
  {/if}

  {#if activeView === 'versions'}
    <main class="versions-view">
      <div class="view-heading">
        <div><span class="kicker">REUSE & HISTORY</span><h2>版本与课程复用</h2><p>封存版本永不过期，可随时比较与复用；未封存的自动草稿在活动变化后立即过期，不能再用于比较或复制。</p></div>
        <div class="version-actions"><Button kind="tertiary" on:click={copyCourse}>复制课程</Button><Button kind="primary" on:click={saveVersion}>封存新版本</Button></div>
      </div>
      <div class="version-layout-svelte">
        <Tile class="version-timeline">
          <div class="section-title"><div><span class="kicker">TIMELINE</span><h3>课程版本</h3></div><Tag type="cool-gray">{course.versions.length} 个快照</Tag></div>
          {#each [...course.versions].reverse() as version, index (version.id)}
            {@const stale = isVersionStale(version, course)}
            {@const isLatest = index === 0}
            <article class:latest={isLatest} class:stale-version={stale}>
              <span class="timeline-dot"></span>
              <div class="version-row">
                <div>
                  <b>{version.label}</b>
                  {#if version.sealed}<Tag type="green">已封存</Tag>{:else if stale}<Tag type="red">已过期</Tag>{:else}<Tag type="cool-gray">自动草稿</Tag>{/if}
                  {#if isLatest}<Tag type="blue">最新</Tag>{/if}
                  <h4>{version.note}</h4>
                  <p>{formatTime(version.savedAt)} · r{version.revision} · {version.activities.length} 个活动{stale ? ' · 活动已变化，不可比较或复用' : ''}</p>
                </div>
                {#if !stale}
                  <Button size="small" kind="ghost" on:click={() => reuseVersion(version)}>复用活动</Button>
                {/if}
              </div>
            </article>
          {/each}
        </Tile>
        <Tile class="diff-card">
          <div class="section-title"><div><span class="kicker">COMPARE</span><h3>比较两个版本</h3></div></div>
          <div class="compare-pickers">
            <Select labelText="基准版本" selected={compareBaseId} on:change={(event) => compareBaseId = readText(event)}>
              {#each course.versions as version}<SelectItem value={version.id} text={`${isVersionStale(version, course) ? '［已过期］' : ''}${version.label} · r${version.revision}`} />{/each}
            </Select>
            <Select labelText="目标版本" selected={compareTargetId} on:change={(event) => compareTargetId = readText(event)}>
              {#each course.versions as version}<SelectItem value={version.id} text={`${isVersionStale(version, course) ? '［已过期］' : ''}${version.label} · r${version.revision}`} />{/each}
            </Select>
          </div>
          {#if compareBlocked}
            <InlineNotification lowContrast kind="error" title="过期快照不能用于版本比较" subtitle={compareBlocked} />
          {/if}
          <div class="diff-list">
            {#each versionDiff as diff}
              <article class={diff.kind}><span>{diff.kind === 'added' ? '新增' : diff.kind === 'removed' ? '删除' : '修改'}</span><div><b>{diff.title}</b><p>{diff.detail}</p></div></article>
            {:else}
              {#if !compareBlocked}
                <p class="empty-state">两个版本之间没有活动差异，或尚未选择版本。</p>
              {/if}
            {/each}
          </div>
        </Tile>
      </div>
    </main>
  {/if}

  <footer class="app-footer">
    <span>所有数据保存在当前浏览器 localStorage · 每个标签页独立草稿，保存时按修订号合并</span>
    <span>Ctrl/Cmd + Z 撤销 · Ctrl/Cmd + Y 重做 · Alt + N 新建活动 · Ctrl/Cmd + S 保存</span>
  </footer>
</div>

<Modal
  bind:open={conflictCenterOpen}
  size="lg"
  modalLabel="协作保护"
  primaryButtonText={activeSession ? `确认生效（还剩 ${unresolvedCount} 处）` : '关闭'}
  secondaryButtonText={activeSession ? '稍后处理' : '取消'}
  primaryButtonDisabled={Boolean(activeSession) && unresolvedCount > 0}
  on:click:button--primary={() => activeSession ? confirmResolutions() : conflictCenterOpen = false}
  on:click:button--secondary={deferConflict}
>
  <div class="conflict-center">
    <div class="conflict-tabs">
      <button class:active={conflictCenterTab === 'pending'} on:click={() => conflictCenterTab = 'pending'}>
        待处理冲突{activeSession ? ` · ${activeSession.conflicts.length}` : ''}
      </button>
      <button class:active={conflictCenterTab === 'recovery'} on:click={() => { conflictCenterTab = 'recovery'; sessionHistory = readSessions(); }}>
        草稿找回（{sessionHistory.filter((session) => session.status !== 'pending').length}）
      </button>
    </div>

    {#if conflictCenterTab === 'pending'}
      {#if activeSession}
        <p class="conflict-intro">
          共同祖先 r{activeSession.baseRevision}，本页草稿 r{activeSession.localRevision}，对端已保存到 r{activeSession.remoteRevision}。
          互不重叠的修改已经自动合并；以下条目双方都改了，保留双方草稿与说明，请逐项确认后再生效。
        </p>
        <div class="conflict-intro-actions">
          <Button size="small" kind="ghost" on:click={() => downloadDraft(activeSession?.workingCourse ?? course, 'current-draft')}>下载当前草稿</Button>
          <Button size="small" kind="danger-ghost" on:click={abandonLocalDraft}>放弃本页，改用对端课程</Button>
        </div>
        {#if remoteAdvancedRevision > activeSession.remoteRevision}
          <InlineNotification
            class="conflict-inline"
            lowContrast
            kind="info"
            title={`对端在冲突期间又保存了 r${remoteAdvancedRevision}`}
            subtitle="可以重新合并：已确认的选择会继续沿用。"
          >
            <svelte:fragment slot="actions">
              <Button size="small" kind="tertiary" on:click={() => retryMerge()}>重新合并</Button>
            </svelte:fragment>
          </InlineNotification>
        {/if}

        {#if structuralConflicts.length}
          <h4 class="conflict-group-title">结构冲突 · 活动顺序、依赖或音素（{structuralConflicts.length}）</h4>
          {#each structuralConflicts as conflict (conflict.id)}
            {@const choice = activeSession?.resolutions[conflict.id]}
            <div class:chosen={Boolean(choice)} class="conflict-card">
              <div class="conflict-head">
                <b>{conflict.title}</b>
                <Tag type="magenta">结构修改</Tag>
              </div>
              <p>{conflict.detail}</p>
              <div class="conflict-choices">
                <button class:selected={choice === 'local'} on:click={() => chooseResolution(conflict.id, 'local')}>
                  <span>本页草稿</span><b>{conflict.local.label}</b><small>{conflict.local.detail}</small>
                </button>
                <button class:selected={choice === 'remote'} on:click={() => chooseResolution(conflict.id, 'remote')}>
                  <span>对端草稿</span><b>{conflict.remote.label}</b><small>{conflict.remote.detail}</small>
                </button>
              </div>
            </div>
          {/each}
        {/if}

        {#if fieldConflicts.length}
          <h4 class="conflict-group-title">同字段同时修改（{fieldConflicts.length}）</h4>
          {#each fieldConflicts as conflict (conflict.id)}
            {@const choice = activeSession?.resolutions[conflict.id]}
            <div class:chosen={Boolean(choice)} class="conflict-card">
              <div class="conflict-head"><b>{conflict.title}</b><Tag type="cool-gray">字段</Tag></div>
              <p>{conflict.detail}</p>
              <div class="conflict-choices">
                <button class:selected={choice === 'local'} on:click={() => chooseResolution(conflict.id, 'local')}>
                  <span>本页</span><b>{conflict.local.label}</b><small>{conflict.local.detail}</small>
                </button>
                <button class:selected={choice === 'remote'} on:click={() => chooseResolution(conflict.id, 'remote')}>
                  <span>对端</span><b>{conflict.remote.label}</b><small>{conflict.remote.detail}</small>
                </button>
              </div>
            </div>
          {/each}
        {/if}

        <div class="conflict-footer-note">
          <Tag type={unresolvedCount ? 'red' : 'green'}>{unresolvedCount ? `还剩 ${unresolvedCount} 处待确认` : '全部确认完毕'}</Tag>
          <span>确认前写入不会生效；选择“稍后处理”会挂起冲突并保留双方草稿，刷新或重开标签页后可从这里继续。</span>
        </div>
      {:else}
        <p class="empty-state">当前没有待处理的多标签页冲突。在两个标签页同时修改同一门课程并保存时，互不重叠的修改会自动合并，冲突会出现在这里。</p>
      {/if}
    {/if}

    {#if conflictCenterTab === 'recovery'}
      <div class="recovery-list">
        {#each sessionHistory.filter((session) => session.status !== 'pending' || activeSession?.id !== session.id) as session (session.id)}
          <div class="recovery-row">
            <div>
              <div class="conflict-head">
                <b>{session.replaced ? `课程替换：${session.replaced.remoteTitle}` : `r${session.baseRevision} → r${session.remoteRevision} 的合并草稿`}</b>
                <Tag type={session.status === 'resolved' ? 'green' : session.status === 'failed' ? 'red' : 'cool-gray'}>{sessionStatusLabel(session)}</Tag>
              </div>
              <p>{session.conflicts.length} 处冲突 · {formatTime(session.updatedAt)}{session.note ? ` · ${session.note}` : ''}</p>
            </div>
            <div class="recovery-actions">
              {#if session.status === 'failed' || session.status === 'abandoned'}
                <Button size="small" kind="tertiary" on:click={() => resumeSession(session)}>找回并重试</Button>
              {/if}
              <Button size="small" kind="ghost" on:click={() => downloadDraft(session.localCourse, 'local-draft')}>本页草稿</Button>
              <Button size="small" kind="ghost" on:click={() => downloadDraft(session.remoteCourse, 'remote-draft')}>对端草稿</Button>
            </div>
          </div>
        {:else}
          <p class="empty-state">还没有历史冲突记录。冲突处理失败或中途关闭后，双方草稿都会出现在这里，可下载或找回重试。</p>
        {/each}
      </div>
    {/if}
  </div>
</Modal>

<style lang="postcss">
  .collab-banner { padding: 10px clamp(20px, 4vw, 60px) 0; }
  .collab-banner :global(.bx--inline-notification) { margin: 0; max-width: none; }
  .conflict-banner { padding-top: 12px; }
  .stale-note { margin: 6px 0; color: #8a3ffc; font-size: 11px; }
  .qa-stale { margin-bottom: 14px; }
  .version-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
  .version-row b { margin-right: 6px; color: #0f62fe; font: 600 11px "IBM Plex Mono", monospace; }
  .stale-version { opacity: .62; }
  .stale-version .timeline-dot { border-color: #da1e28; }
  .conflict-center { margin-top: 8px; }
  .conflict-tabs { display: flex; gap: 8px; border-bottom: 1px solid #e0e0e0; margin-bottom: 14px; }
  .conflict-tabs button { padding: 8px 14px; border: 0; border-bottom: 2px solid transparent; background: none; color: #6f6f6f; cursor: pointer; font-size: 13px; }
  .conflict-tabs button.active { color: #0f62fe; border-bottom-color: #0f62fe; font-weight: 600; }
  .conflict-intro { margin: 0 0 8px; color: #525252; font-size: 12px; line-height: 1.7; }
  .conflict-intro-actions { display: flex; justify-content: flex-end; gap: 6px; margin-bottom: 10px; }
  .conflict-inline { margin-bottom: 12px; }
  .conflict-group-title { margin: 14px 0 8px; font-size: 13px; }
  .conflict-card { margin-bottom: 10px; padding: 12px 14px; border: 1px solid #e0e0e0; border-left: 3px solid #8a3ffc; background: #faf9ff; }
  .conflict-card.chosen { border-color: #42be65; border-left-color: #198038; background: #f6fff8; }
  .conflict-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .conflict-head b { font-size: 12px; }
  .conflict-card p { margin: 6px 0 10px; color: #6f6f6f; font-size: 11px; line-height: 1.6; }
  .conflict-choices { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .conflict-choices button { padding: 10px 12px; display: grid; grid-template-rows: auto auto auto; gap: 2px; text-align: left; border: 1px solid #d8d8d8; background: #fff; cursor: pointer; }
  .conflict-choices button span { color: #8d8d8d; font-size: 10px; }
  .conflict-choices button b { font-size: 12px; color: #161616; }
  .conflict-choices button small { color: #6f6f6f; font-size: 10px; line-height: 1.5; }
  .conflict-choices button.selected { border: 2px solid #0f62fe; background: #edf5ff; }
  .conflict-footer-note { display: flex; align-items: center; gap: 10px; margin-top: 12px; color: #6f6f6f; font-size: 11px; }
  .recovery-list { display: grid; gap: 10px; }
  .recovery-row { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 12px 14px; border: 1px solid #e0e0e0; }
  .recovery-row p { margin: 5px 0 0; color: #8d8d8d; font-size: 11px; }
  .recovery-actions { display: flex; gap: 6px; flex-shrink: 0; }
</style>
