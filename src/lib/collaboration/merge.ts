import type {
  Activity,
  Course,
  CourseConflict,
  CourseVersion,
  MergeOutcome
} from './types';

export const META_FIELDS = ['title', 'level', 'ageRange', 'objective'] as const;
export type MetaField = (typeof META_FIELDS)[number];

const SCALAR_FIELDS = ['type', 'title', 'content', 'difficulty', 'duration', 'prompt', 'accessibility', 'feedback'] as const;
type ScalarField = (typeof SCALAR_FIELDS)[number];

const META_LABELS: Record<MetaField, string> = {
  title: '课程名称',
  level: '课程等级',
  ageRange: '适用年龄',
  objective: '学习目标'
};

const FIELD_LABELS: Record<string, string> = {
  type: '活动类型',
  title: '活动标题',
  content: '教学内容',
  difficulty: '难度',
  duration: '预计时长',
  prompt: '教师提示语',
  accessibility: '无障碍说明',
  feedback: '练习反馈'
};

export function deepEqual<T>(left: T, right: T): boolean {
  return left === right || JSON.stringify(left) === JSON.stringify(right);
}

function sortedList(value: string[]): string[] {
  return [...value].sort((a, stringB) => a.localeCompare(stringB));
}

function sameSet(left: string[], right: string[]): boolean {
  return deepEqual(sortedList(left), sortedList(right));
}

function findActivity(course: Course, id: string): Activity | undefined {
  return course.activities.find((activity) => activity.id === id);
}

function short(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 42 ? `${text.slice(0, 42)}…` : text;
}

function conflictId(...parts: string[]): string {
  return parts.join('::');
}

/**
 * 三路合并：base 是两个标签页的共同祖先，local 是本页草稿，remote 是已写入的另一份。
 * 互不重叠的修改直接合并；活动顺序、依赖、音素或同一字段被双方同时修改时产生冲突。
 * 返回的 merged 是“本页优先”的暂态结果，老师逐条确认对端选择后再用 applyResolution 改写。
 */
export function mergeCourses(base: Course, local: Course, remote: Course): MergeOutcome {
  const conflicts: CourseConflict[] = [];

  // 对端把整门课程复制/替换成了另一门，无法字段级合并，升级为课程替换冲突。
  if (base.id !== remote.id && remote.id !== local.id) {
    conflicts.push({
      id: conflictId('course-replaced', remote.id),
      kind: 'course-replaced',
      title: `对端把课程替换成了「${remote.title}」`,
      detail: `另一个标签页复制课程并切换为新草稿（${remote.title}）。请选择继续当前草稿还是改用对端课程；确认前双方草稿都会保留。`,
      structural: false,
      local: { label: '保留当前草稿', detail: `${local.title} · ${local.activities.length} 个活动` },
      remote: { label: `改用「${remote.title}」`, detail: `${remote.activities.length} 个活动 · 修订号 ${remote.revision}` }
    });
    return { merged: structuredClone(local), conflicts };
  }

  const merged: Course = structuredClone(local);
  merged.id = local.id === base.id ? remote.id : local.id;
  merged.revision = remote.revision;

  // 课程元信息：仅一方修改直接采用，双方同改产生冲突。
  for (const field of META_FIELDS) {
    const baseValue = base[field];
    const localValue = local[field];
    const remoteValue = remote[field];
    const localChanged = !deepEqual(baseValue, localValue);
    const remoteChanged = !deepEqual(baseValue, remoteValue);
    if (localChanged && remoteChanged && !deepEqual(localValue, remoteValue)) {
      conflicts.push({
        id: conflictId('meta', field),
        kind: 'meta',
        field,
        title: `课程信息「${META_LABELS[field]}」被两个标签页同时修改`,
        detail: '两处草稿都改了这项内容，需要确认保留哪一份。',
        structural: false,
        local: { label: '保留本页', detail: short(localValue) },
        remote: { label: '保留对端', detail: short(remoteValue) }
      });
    } else if (remoteChanged && !localChanged) {
      (merged as unknown as Record<string, unknown>)[field] = remoteValue;
    }
  }

  const localMap = new Map(local.activities.map((activity) => [activity.id, activity]));
  const remoteMap = new Map(remote.activities.map((activity) => [activity.id, activity]));
  const allIds = new Set([...localMap.keys(), ...remoteMap.keys()]);

  const resolvedActivities = new Map<string, Activity | null>();
  const addedBy = new Map<string, 'local' | 'remote'>();

  for (const id of allIds) {
    const localActivity = localMap.get(id);
    const remoteActivity = remoteMap.get(id);
    const baseActivity = findActivity(base, id);

    if (!baseActivity) {
      if (localActivity && remoteActivity) {
        if (deepEqual(localActivity, remoteActivity)) {
          resolvedActivities.set(id, structuredClone(localActivity));
        } else {
          conflicts.push({
            id: conflictId('existence', id, 'add-collision'),
            kind: 'existence',
            activityId: id,
            title: `两个标签页都新建了编号相同的活动「${localActivity.title}」`,
            detail: '两份草稿内容不同。确认保留哪一份草稿后生效，也可以稍后把另一份另存为新活动。',
            structural: true,
            local: { label: '保留本页新建', detail: `${localActivity.type} · ${short(localActivity.content)}` },
            remote: { label: '保留对端新建', detail: `${remoteActivity.type} · ${short(remoteActivity.content)}` }
          });
          resolvedActivities.set(id, structuredClone(localActivity));
          addedBy.set(id, 'local');
        }
      } else if (localActivity) {
        resolvedActivities.set(id, structuredClone(localActivity));
        addedBy.set(id, 'local');
      } else if (remoteActivity) {
        resolvedActivities.set(id, structuredClone(remoteActivity));
        addedBy.set(id, 'remote');
      }
      continue;
    }

    const localDeleted = !localActivity;
    const remoteDeleted = !remoteActivity;
    if (localDeleted || remoteDeleted) {
      if (localDeleted && remoteDeleted) {
        resolvedActivities.set(id, null);
        continue;
      }
      const surviving = (localActivity ?? remoteActivity) as Activity;
      const survivorEdited = !deepEqual(baseActivity, surviving);
      if (survivorEdited) {
        conflicts.push({
          id: conflictId('existence', id, 'delete-edit'),
          kind: 'existence',
          activityId: id,
          title: `「${baseActivity.title}」在一个标签页被删除，另一个标签页仍在修改`,
          detail: localDeleted
            ? '本页删除了该活动，对端修改了它的内容。'
            : '对端删除了该活动，本页修改了它的内容。',
          structural: true,
          local: localDeleted
            ? { label: '确认删除', detail: '不保留该活动，并清理对它的依赖' }
            : { label: '保留本页修改', detail: `${surviving.type} · ${short(surviving.content)}` },
          remote: remoteDeleted
            ? { label: '确认删除', detail: '不保留该活动，并清理对它的依赖' }
            : { label: '保留对端修改', detail: `${surviving.type} · ${short(surviving.content)}` }
        });
        // 暂态取本页：本页删了即移除，本页编辑则保留。
        resolvedActivities.set(id, localActivity ? structuredClone(localActivity) : null);
      } else {
        resolvedActivities.set(id, null);
      }
      continue;
    }

    const mergedActivity = structuredClone(localActivity);
    mergeScalarFields(baseActivity, localActivity, remoteActivity, mergedActivity, id, conflicts);
    mergePhonemes(baseActivity, localActivity, remoteActivity, mergedActivity, id, conflicts);
    mergeDependencies(baseActivity, localActivity, remoteActivity, mergedActivity, id, conflicts);
    resolvedActivities.set(id, mergedActivity);
  }

  const orderConflict = detectOrderConflict(base, local, remote, addedBy);
  if (orderConflict) conflicts.push(orderConflict);

  merged.activities = composeOrder(base, local, remote, resolvedActivities, addedBy, orderConflict ? 'local' : null);
  merged.versions = mergeVersions(base.versions, local.versions, remote.versions);
  merged.updatedAt = new Date().toISOString();

  const survivingIds = new Set(merged.activities.map((activity) => activity.id));
  merged.activities.forEach((activity) => {
    activity.dependencies = activity.dependencies.filter((dependency) => survivingIds.has(dependency));
  });

  return { merged, conflicts };
}

function mergeScalarFields(
  base: Activity,
  local: Activity,
  remote: Activity,
  target: Activity,
  activityId: string,
  conflicts: CourseConflict[]
): void {
  for (const field of SCALAR_FIELDS) {
    const baseValue = base[field];
    const localValue = local[field];
    const remoteValue = remote[field];
    const localChanged = !deepEqual(baseValue, localValue);
    const remoteChanged = !deepEqual(baseValue, remoteValue);
    if (localChanged && remoteChanged && !deepEqual(localValue, remoteValue)) {
      conflicts.push({
        id: conflictId('activity', activityId, field),
        kind: 'activity',
        field,
        activityId,
        title: `「${local.title}」的${FIELD_LABELS[field]}被两个标签页同时修改`,
        detail: '同一项内容存在两份草稿，确认后采用其中一份。',
        structural: false,
        local: { label: '本页草稿', detail: short(localValue) },
        remote: { label: '对端草稿', detail: short(remoteValue) }
      });
    } else if (remoteChanged && !localChanged) {
      (target as unknown as Record<string, unknown>)[field] = remoteValue;
    }
  }
}

function mergePhonemes(
  base: Activity,
  local: Activity,
  remote: Activity,
  target: Activity,
  activityId: string,
  conflicts: CourseConflict[]
): void {
  const localChanged = !sameSet(base.phonemes, local.phonemes);
  const remoteChanged = !sameSet(base.phonemes, remote.phonemes);
  if (!localChanged && remoteChanged) {
    target.phonemes = [...remote.phonemes];
    return;
  }
  if (!localChanged || !remoteChanged || sameSet(local.phonemes, remote.phonemes)) return;
  conflicts.push({
    id: conflictId('phonemes', activityId),
    kind: 'phonemes',
    field: 'phonemes',
    activityId,
    title: `「${local.title}」涉及的音素被两个标签页同时修改`,
    detail: `本页：${local.phonemes.join(' ') || '（空）'}；对端：${remote.phonemes.join(' ') || '（空）'}。`,
    structural: true,
    local: { label: '本页音素', detail: local.phonemes.join(' ') || '（无）' },
    remote: { label: '对端音素', detail: remote.phonemes.join(' ') || '（无）' }
  });
}

function mergeDependencies(
  base: Activity,
  local: Activity,
  remote: Activity,
  target: Activity,
  activityId: string,
  conflicts: CourseConflict[]
): void {
  const localChanged = !sameSet(base.dependencies, local.dependencies);
  const remoteChanged = !sameSet(base.dependencies, remote.dependencies);
  if (!localChanged && remoteChanged) {
    target.dependencies = [...remote.dependencies];
    return;
  }
  if (!localChanged || !remoteChanged || sameSet(local.dependencies, remote.dependencies)) return;
  conflicts.push({
    id: conflictId('dependencies', activityId),
    kind: 'dependencies',
    field: 'dependencies',
    activityId,
    title: `「${local.title}」的前置依赖被两个标签页同时修改`,
    detail: `本页勾选 ${local.dependencies.length} 项，对端勾选 ${remote.dependencies.length} 项。`,
    structural: true,
    local: { label: `本页依赖（${local.dependencies.length}）`, detail: dependencySummary(local.dependencies) },
    remote: { label: `对端依赖（${remote.dependencies.length}）`, detail: dependencySummary(remote.dependencies) }
  });
}

export function dependencySummary(ids: string[]): string {
  return ids.length ? ids.join('、') : '（不依赖任何活动）';
}

function detectOrderConflict(
  base: Course,
  local: Course,
  remote: Course,
  addedBy: Map<string, 'local' | 'remote'>
): CourseConflict | null {
  const common = base.activities
    .map((activity) => activity.id)
    .filter((id) => local.activities.some((item) => item.id === id) && remote.activities.some((item) => item.id === id));
  const localOrder = local.activities.map((activity) => activity.id).filter((id) => common.includes(id));
  const remoteOrder = remote.activities.map((activity) => activity.id).filter((id) => common.includes(id));
  const baseOrder = base.activities.map((activity) => activity.id).filter((id) => common.includes(id));
  const localReordered = !deepEqual(localOrder, baseOrder);
  const remoteReordered = !deepEqual(remoteOrder, baseOrder);

  const bothReorderedDifferently = localReordered && remoteReordered && !deepEqual(localOrder, remoteOrder);

  if (!bothReorderedDifferently) return null;
  return {
    id: conflictId('order'),
    kind: 'order',
    title: '活动顺序被两个标签页同时调整',
    detail: '双方都改动了学习路径的先后顺序。冲突确认前，双方草稿和本说明都会保留；确认后才生效。',
    structural: true,
    local: {
      label: '采用本页顺序',
      detail: local.activities.map((activity, index) => `${index + 1}. ${activity.title}`).slice(0, 6).join('；')
    },
    remote: {
      label: '采用对端顺序',
      detail: remote.activities.map((activity, index) => `${index + 1}. ${activity.title}`).slice(0, 6).join('；')
    }
  };
}

/**
 * 组装最终活动顺序。orderWinner 为 null 表示没有顺序冲突，按共识自动合并；
 * 否则以获胜方顺序为骨架，再把另一方独立新增的活动按相邻锚点插入。
 */
export function composeOrder(
  base: Course,
  local: Course,
  remote: Course,
  contents: Map<string, Activity | null>,
  addedBy: Map<string, 'local' | 'remote'>,
  orderWinner: 'local' | 'remote' | null
): Activity[] {
  const aliveIds = new Set<string>();
  contents.forEach((activity, id) => {
    if (activity) aliveIds.add(id);
  });

  let orderedIds: string[];
  if (orderWinner) {
    const winnerCourse = orderWinner === 'local' ? local : remote;
    const loserCourse = orderWinner === 'local' ? remote : local;
    const loserSide = orderWinner === 'local' ? 'remote' : 'local';
    const skeleton = winnerCourse.activities.map((activity) => activity.id).filter((id) => aliveIds.has(id));
    orderedIds = insertOpponentAdds(skeleton, loserCourse, loserSide, addedBy);
  } else {
    // 共识顺序：共同活动采用“有移动的那一方”的顺序，双方各自新增的活动按相邻锚点插入。
    const common = base.activities
      .map((activity) => activity.id)
      .filter((id) => local.activities.some((item) => item.id === id) && remote.activities.some((item) => item.id === id))
      .filter((id) => aliveIds.has(id));
    const baseCommon = base.activities.map((activity) => activity.id).filter((id) => common.includes(id));
    const localCommon = local.activities.map((activity) => activity.id).filter((id) => common.includes(id));
    const remoteCommon = remote.activities.map((activity) => activity.id).filter((id) => common.includes(id));
    const skeletonSource = !deepEqual(localCommon, baseCommon)
      ? localCommon
      : !deepEqual(remoteCommon, baseCommon)
        ? remoteCommon
        : baseCommon;
    orderedIds = interleave(skeletonSource, local, remote, addedBy);
  }

  contents.forEach((activity, id) => {
    if (activity && !orderedIds.includes(id)) orderedIds.push(id);
  });

  return orderedIds
    .map((id) => contents.get(id))
    .filter((activity): activity is Activity => Boolean(activity))
    .map((activity) => structuredClone(activity));
}

function interleave(
  baseIds: string[],
  local: Course,
  remote: Course,
  addedBy: Map<string, 'local' | 'remote'>
): string[] {
  const localIds = local.activities.map((activity) => activity.id);
  const remoteIds = remote.activities.map((activity) => activity.id);
  const result = [...baseIds];

  const insertSideAdds = (ids: string[], side: 'local' | 'remote'): void => {
    for (const id of ids) {
      if (result.includes(id) || addedBy.get(id) !== side) continue;
      const index = ids.indexOf(id);
      let anchor: string | undefined;
      for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
        if (result.includes(ids[cursor])) {
          anchor = ids[cursor];
          break;
        }
      }
      if (anchor) result.splice(result.indexOf(anchor) + 1, 0, id);
      else result.unshift(id);
    }
  };

  insertSideAdds(localIds, 'local');
  insertSideAdds(remoteIds, 'remote');
  [...localIds, ...remoteIds].forEach((id) => {
    if (!result.includes(id)) result.push(id);
  });
  return result;
}

function insertOpponentAdds(
  skeleton: string[],
  loserCourse: Course,
  loserSide: 'local' | 'remote',
  addedBy: Map<string, 'local' | 'remote'>
): string[] {
  const result = [...skeleton];
  const loserIds = loserCourse.activities.map((activity) => activity.id);
  for (const id of loserIds) {
    if (result.includes(id) || addedBy.get(id) !== loserSide) continue;
    const index = loserIds.indexOf(id);
    let anchor: string | undefined;
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      if (result.includes(loserIds[cursor])) {
        anchor = loserIds[cursor];
        break;
      }
    }
    if (anchor) result.splice(result.indexOf(anchor) + 1, 0, id);
    else result.push(id);
  }
  return result;
}

function mergeVersions(base: CourseVersion[], local: CourseVersion[], remote: CourseVersion[]): CourseVersion[] {
  const map = new Map<string, CourseVersion>();
  const order: string[] = [];
  const remember = (version: CourseVersion): void => {
    if (!map.has(version.id)) {
      map.set(version.id, structuredClone(version));
      order.push(version.id);
    }
  };
  base.forEach(remember);
  local.forEach(remember);
  remote.forEach(remember);
  return order.map((id) => map.get(id) as CourseVersion);
}
