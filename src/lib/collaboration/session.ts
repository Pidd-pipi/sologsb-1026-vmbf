import type {
  Activity,
  Course,
  ConflictSession,
  CourseConflict,
  CourseVersion
} from './types';
import { META_FIELDS, composeOrder, deepEqual } from './merge';

let sequence = 0;

export function uid(prefix: string): string {
  sequence += 1;
  return `${prefix}-${Date.now().toString(36)}-${sequence.toString(36)}`;
}

export function createTabId(): string {
  return `tab-${Math.random().toString(36).slice(2, 9)}`;
}

export function createSession(input: {
  base: Course;
  local: Course;
  remote: Course;
  provisional: Course;
  conflicts: CourseConflict[];
  localTabId: string;
  remoteTabId?: string;
}): ConflictSession {
  const now = new Date().toISOString();
  const replaced = input.conflicts.some((conflict) => conflict.kind === 'course-replaced');
  return {
    id: uid('conflict'),
    status: 'pending',
    createdAt: now,
    updatedAt: now,
    baseRevision: input.base.revision,
    localRevision: input.local.revision,
    remoteRevision: input.remote.revision,
    localTabId: input.localTabId,
    remoteTabId: input.remoteTabId,
    conflicts: input.conflicts,
    resolutions: {},
    baseCourse: replaced ? null : structuredClone(input.base),
    localCourse: structuredClone(input.local),
    remoteCourse: structuredClone(input.remote),
    workingCourse: structuredClone(input.provisional),
    provisional: structuredClone(input.provisional),
    replaced: replaced
      ? { remoteTitle: input.remote.title, remoteId: input.remote.id }
      : undefined
  };
}

/** 冲突处理失败/页面关闭后，用最新本地草稿刷新会话，便于再次尝试。 */
export function refreshWorkingSession(session: ConflictSession, working: Course): ConflictSession {
  return {
    ...session,
    updatedAt: new Date().toISOString(),
    status: 'pending',
    workingCourse: structuredClone(working),
    provisional: structuredClone(working)
  };
}

export function isResolutionComplete(session: ConflictSession): boolean {
  return session.conflicts.every((conflict) => Boolean(session.resolutions[conflict.id]));
}

/**
 * 老师逐条确认后，按选择从会话的双方草稿重建最终课程。
 * 暂态结果里“本页优先”，这里把选择了“对端”的冲突改写过去。
 */
export function buildResolvedCourse(
  session: ConflictSession,
  resolutions: Record<string, 'local' | 'remote'>
): Course {
  if (session.conflicts.some((conflict) => conflict.kind === 'course-replaced')) {
    const choice = resolutions[session.conflicts[0].id];
    return structuredClone(choice === 'remote' ? session.remoteCourse : session.workingCourse);
  }

  const base = session.baseCourse as Course;
  const local = session.workingCourse;
  const remote = session.remoteCourse;
  const choiceOf = (conflict: CourseConflict): 'local' | 'remote' => resolutions[conflict.id] ?? 'local';

  const result: Course = structuredClone(local);
  result.id = remote.id;
  result.revision = remote.revision;

  for (const field of META_FIELDS) {
    const conflict = session.conflicts.find((item) => item.kind === 'meta' && item.field === field);
    if (conflict && choiceOf(conflict) === 'remote') {
      (result as unknown as Record<string, unknown>)[field] = remote[field];
    } else if (!conflict) {
      // 非冲突字段沿用暂态结果（合并时已写入仅对端的修改）。
    }
  }

  const localMap = new Map(local.activities.map((activity) => [activity.id, activity]));
  const remoteMap = new Map(remote.activities.map((activity) => [activity.id, activity]));
  const baseIds = new Set(base.activities.map((activity) => activity.id));
  const contents = new Map<string, Activity | null>();
  const addedBy = new Map<string, 'local' | 'remote'>();

  const allIds = new Set([...localMap.keys(), ...remoteMap.keys()]);
  for (const id of allIds) {
    const localActivity = localMap.get(id);
    const remoteActivity = remoteMap.get(id);
    const existed = baseIds.has(id);

    if (!existed) {
      if (localActivity && remoteActivity) {
        const conflict = session.conflicts.find((item) => item.kind === 'existence' && item.activityId === id);
        const winner = conflict ? choiceOf(conflict) : 'local';
        if (winner === 'remote' && remoteActivity) {
          contents.set(id, structuredClone(remoteActivity));
        } else if (localActivity) {
          contents.set(id, structuredClone(localActivity));
        }
        addedBy.set(id, winner === 'remote' ? 'remote' : 'local');
      } else if (localActivity) {
        contents.set(id, structuredClone(localActivity));
        addedBy.set(id, 'local');
      } else if (remoteActivity) {
        contents.set(id, structuredClone(remoteActivity));
        addedBy.set(id, 'remote');
      }
      continue;
    }

    const deleteConflict = session.conflicts.find(
      (item) => item.kind === 'existence' && item.activityId === id
    );
    if (deleteConflict) {
      const winner = choiceOf(deleteConflict);
      const winnerActivity = winner === 'remote' ? remoteActivity : localActivity;
      contents.set(id, winnerActivity ? structuredClone(winnerActivity) : null);
      continue;
    }

    if (localActivity && remoteActivity) {
      const next = structuredClone(localActivity);
      for (const conflict of session.conflicts) {
        if (conflict.activityId !== id) continue;
        if (choiceOf(conflict) !== 'remote') continue;
        if (conflict.kind === 'activity' && conflict.field) {
          (next as unknown as Record<string, unknown>)[conflict.field] =
            (remoteActivity as unknown as Record<string, unknown>)[conflict.field];
        } else if (conflict.kind === 'phonemes') {
          next.phonemes = [...remoteActivity.phonemes];
        } else if (conflict.kind === 'dependencies') {
          next.dependencies = [...remoteActivity.dependencies];
        }
      }
      // 非冲突的仅对端修改，暂态结果已经带上，这里以暂态(working)为准；working 可能又被本页编辑过。
      contents.set(id, next);
    } else if (localActivity) {
      contents.set(id, structuredClone(localActivity));
    }
  }

  const orderConflict = session.conflicts.find((conflict) => conflict.kind === 'order');
  const orderWinner = orderConflict ? choiceOf(orderConflict) : null;
  result.activities = composeOrder(base, local, remote, contents, addedBy, orderWinner);
  result.versions = unionVersions(local.versions, remote.versions, base.versions);
  result.updatedAt = new Date().toISOString();

  const survivingIds = new Set(result.activities.map((activity) => activity.id));
  result.activities.forEach((activity) => {
    activity.dependencies = activity.dependencies.filter((dependency) => survivingIds.has(dependency));
  });
  return result;
}

function unionVersions(local: CourseVersion[], remote: CourseVersion[], base: CourseVersion[]): CourseVersion[] {
  const map = new Map<string, CourseVersion>();
  const order: string[] = [];
  [...base, ...local, ...remote].forEach((version) => {
    if (!map.has(version.id)) {
      map.set(version.id, structuredClone(version));
      order.push(version.id);
    }
  });
  return order.map((id) => map.get(id) as CourseVersion);
}

/** 活动数据签名：顺序、依赖与全部字段；签名变化即代表检查结果过期。 */
export function activitySignature(course: Course): string {
  return JSON.stringify(course.activities.map((activity) => [
    activity.id,
    activity.type,
    activity.title,
    activity.content,
    [...activity.phonemes].sort(),
    [...activity.dependencies].sort(),
    activity.difficulty,
    activity.prompt,
    activity.accessibility,
    activity.duration,
    activity.feedback
  ]));
}

/**
 * 活动一变，未封存版本立即标过期：快照内容与当前活动不一致，或修订号落后。
 * 封存版本由老师明确存档，永不过期，仍可用于版本比较与复用。
 */
export function markStaleVersions(course: Course): Course {
  const currentSignature = activitySignature(course);
  course.versions.forEach((version) => {
    if (version.sealed) return;
    const snapshot: Course = { ...course, activities: version.activities };
    if (version.revision !== course.revision || activitySignature(snapshot) !== currentSignature) {
      version.stale = true;
    }
  });
  return course;
}

/** 仅判断，不改数据。 */
export function isVersionStale(version: CourseVersion, course: Course): boolean {
  if (version.sealed) return false;
  if (version.stale) return true;
  if (version.revision !== course.revision) return true;
  const snapshot = { ...course, activities: version.activities };
  return activitySignature(snapshot) !== activitySignature(course);
}

export { deepEqual };

/**
 * 冲突挂起期间对端又保存了新修订时，把本页工作草稿变基到最新对端之上。
 * 只叠加“本页在挂起期间新做出的改动”（working 相对冲突开始时对端 remotePrev 的增量）；
 * 初次冲突中尚未解决的争议项保持 remotePrev 的值，随后用 remotePrev 做祖先三路合并，
 * 争议项若与最新对端仍不一致就会继续报冲突，让老师沿用或修改之前的确认。
 */
export function rebaseWorkingDraft(params: {
  base: Course;
  remotePrev: Course;
  working: Course;
  remoteNext: Course;
  /** 初次（或上一次）冲突的坐标与老师已确认的选择；选择“对端”的争议项不再坚持本页值。 */
  priorConflicts?: Array<{ kind: string; activityId?: string; field?: string; choice?: 'local' | 'remote' }>;
}): Course {
  const { remotePrev, working, remoteNext, priorConflicts = [] } = params;
  const rebased = structuredClone(remoteNext);

  for (const field of META_FIELDS) {
    const prior = priorConflicts.find((conflict) => conflict.kind === 'meta' && conflict.field === field);
    const disputed = Boolean(prior);
    const localTouched = !deepEqual(working[field], remotePrev[field]);
    const remoteTouched = !deepEqual(remoteNext[field], remotePrev[field]);
    if (prior?.choice === 'remote') continue; // 老师已选对端：保留最新对端值
    if (disputed || (localTouched && !remoteTouched)) {
      (rebased as unknown as Record<string, unknown>)[field] = working[field];
    }
  }

  const workingMap = new Map(working.activities.map((activity) => [activity.id, activity]));
  const prevMap = new Map(remotePrev.activities.map((activity) => [activity.id, activity]));
  const nextMap = new Map(remoteNext.activities.map((activity) => [activity.id, activity]));

  // 挂起期间本页新增的活动（对端旧版没有、最新版也没有同 id）；
  // 已选“对端”的同 id 新增冲突不再坚持本页版本。
  for (const [id, activity] of workingMap) {
    const collision = priorConflicts.find((conflict) => conflict.kind === 'existence' && conflict.activityId === id);
    if (!prevMap.has(id) && !nextMap.has(id) && collision?.choice !== 'remote') {
      rebased.activities.push(structuredClone(activity));
    }
  }
  // 挂起期间本页删除（含删除/编辑争议中本页坚持删除）：从变基结果中移除，
  // 与最新对端是否再改过无关——若对端改了，三路合并会重新报删除/编辑冲突；
  // 老师已确认“保留对端”的删除争议不移除。
  for (const previous of remotePrev.activities) {
    if (workingMap.has(previous.id)) continue;
    const deleteConflict = priorConflicts.find((conflict) => conflict.kind === 'existence' && conflict.activityId === previous.id);
    if (deleteConflict?.choice === 'remote') continue;
    rebased.activities = rebased.activities.filter((activity) => activity.id !== previous.id);
  }

  for (const [id, workingActivity] of workingMap) {
    const previous = prevMap.get(id);
    const nextActivity = nextMap.get(id);
    if (!previous || !nextActivity) continue;
    const target = rebased.activities.find((activity) => activity.id === id);
    if (!target) continue;
    for (const key of ACTIVITY_PATCH_FIELDS) {
      const isList = key === 'phonemes' || key === 'dependencies';
      const prior = isList
        ? priorConflicts.find((conflict) => conflict.activityId === id && conflict.kind === key)
        : priorConflicts.find((conflict) =>
          conflict.activityId === id && conflict.kind === 'activity' && conflict.field === key);
      const touchedDuringSuspension = isList
        ? !sameSet(workingActivity[key] as string[], previous[key] as string[])
        : !deepEqual(workingActivity[key], previous[key]);
      const remoteTouched = isList
        ? !sameSet(nextActivity[key] as string[], previous[key] as string[])
        : !deepEqual(nextActivity[key], previous[key]);
      if (prior?.choice === 'remote') continue; // 老师已选对端：保留最新对端值
      if (prior || (touchedDuringSuspension && !remoteTouched)) {
        (target as unknown as Record<string, unknown>)[key] = structuredClone(workingActivity[key] as unknown);
      }
    }
  }

  // 顺序：本页挂起期间调整过，或顺序本身就是争议项（坚持本页暂态顺序）；
  // 对端若也再调顺序，三路合并会重新报顺序冲突。老师已选“对端”的顺序争议不在此坚持。
  const orderPrior = priorConflicts.find((conflict) => conflict.kind === 'order');
  const localOrderTouched = !deepEqual(orderIds(working), orderIds(remotePrev));
  if (orderPrior?.choice !== 'remote' && (orderPrior || (localOrderTouched && deepEqual(orderIds(remoteNext), orderIds(remotePrev))))) {
    const byId = new Map(rebased.activities.map((activity) => [activity.id, activity]));
    rebased.activities = orderIds(working)
      .map((id) => byId.get(id))
      .filter((activity): activity is Activity => Boolean(activity));
  }

  rebased.versions = unionVersions(working.versions, remoteNext.versions, remotePrev.versions);
  rebased.revision = remoteNext.revision;
  return rebased;
}

const ACTIVITY_PATCH_FIELDS = [
  'type', 'title', 'content', 'phonemes', 'dependencies',
  'difficulty', 'prompt', 'accessibility', 'duration', 'feedback'
] as const;

function sameSet(left: string[], right: string[]): boolean {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function orderIds(course: Course): string[] {
  return course.activities.map((activity) => activity.id);
}
