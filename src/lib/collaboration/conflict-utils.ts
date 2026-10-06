import type { Course, CourseConflict } from './types';

/** 变基后祖先变化会让冲突 id 漂移，用“类型+活动+字段”签名识别同一条冲突。 */
export function conflictSignature(conflict: CourseConflict): string {
  return [conflict.kind, conflict.activityId ?? '', String(conflict.field ?? '')].join('|');
}

/** 判断未确认的旧争议在最新双方草稿之间是否仍然“双方取值不一致”，需要继续挂起。 */
export function isDisputeStillLive(conflict: CourseConflict, localCourse: Course, remoteCourse: Course): boolean {
  const jsonEqual = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
  if (conflict.kind === 'meta' && conflict.field) {
    return !jsonEqual(
      (localCourse as unknown as Record<string, unknown>)[conflict.field],
      (remoteCourse as unknown as Record<string, unknown>)[conflict.field]
    );
  }
  if (conflict.kind === 'course-replaced') return localCourse.id !== remoteCourse.id;
  if (conflict.kind === 'order') {
    return !jsonEqual(
      localCourse.activities.map((activity) => activity.id),
      remoteCourse.activities.map((activity) => activity.id)
    );
  }
  const id = conflict.activityId;
  if (!id) return false;
  const localActivity = localCourse.activities.find((activity) => activity.id === id);
  const remoteActivity = remoteCourse.activities.find((activity) => activity.id === id);
  if (conflict.kind === 'existence') {
    return Boolean(localActivity) !== Boolean(remoteActivity)
      || (Boolean(localActivity) && Boolean(remoteActivity) && !jsonEqual(localActivity, remoteActivity));
  }
  if (!localActivity || !remoteActivity) return false;
  if (conflict.kind === 'phonemes') {
    return !jsonEqual([...localActivity.phonemes].sort(), [...remoteActivity.phonemes].sort());
  }
  if (conflict.kind === 'dependencies') {
    return !jsonEqual([...localActivity.dependencies].sort(), [...remoteActivity.dependencies].sort());
  }
  if (conflict.kind === 'activity' && conflict.field) {
    return !jsonEqual(
      (localActivity as unknown as Record<string, unknown>)[conflict.field],
      (remoteActivity as unknown as Record<string, unknown>)[conflict.field]
    );
  }
  return false;
}

/** 用最新双方草稿刷新延续争议的文案与取值展示。 */
export function refreshConflict(conflict: CourseConflict, localCourse: Course, remoteCourse: Course): CourseConflict {
  const next: CourseConflict = { ...conflict };
  const localActivity = conflict.activityId
    ? localCourse.activities.find((activity) => activity.id === conflict.activityId)
    : undefined;
  const remoteActivity = conflict.activityId
    ? remoteCourse.activities.find((activity) => activity.id === conflict.activityId)
    : undefined;
  if (conflict.kind === 'meta' && conflict.field) {
    next.local = { label: '保留本页', detail: String((localCourse as unknown as Record<string, unknown>)[conflict.field] ?? '') };
    next.remote = { label: '保留对端', detail: String((remoteCourse as unknown as Record<string, unknown>)[conflict.field] ?? '') };
  } else if (localActivity && remoteActivity) {
    if (conflict.kind === 'phonemes') {
      next.local = { label: '本页音素', detail: localActivity.phonemes.join(' ') || '（无）' };
      next.remote = { label: '对端音素', detail: remoteActivity.phonemes.join(' ') || '（无）' };
    } else if (conflict.kind === 'dependencies') {
      next.local = { label: `本页依赖（${localActivity.dependencies.length}）`, detail: localActivity.dependencies.join('、') || '（无）' };
      next.remote = { label: `对端依赖（${remoteActivity.dependencies.length}）`, detail: remoteActivity.dependencies.join('、') || '（无）' };
    } else if (conflict.kind === 'activity' && conflict.field) {
      next.local = { label: '本页草稿', detail: String((localActivity as unknown as Record<string, unknown>)[conflict.field] ?? '') };
      next.remote = { label: '对端草稿', detail: String((remoteActivity as unknown as Record<string, unknown>)[conflict.field] ?? '') };
    }
  }
  return next;
}

/**
 * 页面“对端又保存了新修订”时的冲突承接：
 * 三路合并新报的冲突之外，把仍未确认且双方取值仍不一致的旧争议一并延续，
 * 保证“确认后才生效”。已确认的旧选择按签名沿用。
 */
export function carryUnresolvedConflicts(params: {
  priorConflicts: CourseConflict[];
  priorResolutions: Record<string, 'local' | 'remote'>;
  newConflicts: CourseConflict[];
  localCourse: Course;
  remoteCourse: Course;
}): { conflicts: CourseConflict[]; resolutions: Record<string, 'local' | 'remote'> } {
  const { priorConflicts, priorResolutions, newConflicts, localCourse, remoteCourse } = params;
  const previousBySignature = new Map<string, 'local' | 'remote'>();
  priorConflicts.forEach((conflict) => {
    const choice = priorResolutions[conflict.id];
    if (choice) previousBySignature.set(conflictSignature(conflict), choice);
  });

  const resolutions: Record<string, 'local' | 'remote'> = {};
  newConflicts.forEach((conflict) => {
    const previous = previousBySignature.get(conflictSignature(conflict));
    if (previous) resolutions[conflict.id] = previous;
  });

  const carried: CourseConflict[] = [];
  for (const prior of priorConflicts) {
    if (priorResolutions[prior.id]) continue;
    if (newConflicts.some((conflict) => conflictSignature(conflict) === conflictSignature(prior))) continue;
    if (isDisputeStillLive(prior, localCourse, remoteCourse)) {
      carried.push(refreshConflict(prior, localCourse, remoteCourse));
    }
  }
  return { conflicts: [...newConflicts, ...carried], resolutions };
}
