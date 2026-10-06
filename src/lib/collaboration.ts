/**
 * 本地多标签页协作保护。
 *
 * 每个标签页持有一个课程修订号（Course.revision）。保存时以“共同基线 /
 * 本标签页草稿 / 其他标签页草稿”做三向合并：
 *
 * - 互不重叠的字段自动合并；
 * - 活动顺序、依赖、音素等关键字段被双方同时修改时不直接覆盖，
 *   而是生成冲突说明，保留双方草稿，老师逐项确认后才生效；
 * - 活动指纹变化后，旧检查结果与未封存版本立即标记过期，
 *   过期版本不能再用于版本比较或复制。
 */

export type ActivityType = '音素' | '单词' | '句子' | '练习';
export type IssueLevel = 'error' | 'warning' | 'info';

export interface Activity {
  id: string;
  type: ActivityType;
  title: string;
  content: string;
  phonemes: string[];
  dependencies: string[];
  difficulty: number;
  prompt: string;
  accessibility: string;
  duration: number;
  feedback: string;
}

export interface CourseVersion {
  id: string;
  label: string;
  savedAt: string;
  note: string;
  activities: Activity[];
  /** 封存后的版本长期有效；未封存版本在课程活动变化后会过期。 */
  sealed: boolean;
  /** 封存/保存时的活动指纹，用于判断是否过期。 */
  fingerprint: string;
  stale?: boolean;
  staleReason?: string;
}

export interface Course {
  id: string;
  title: string;
  level: string;
  ageRange: string;
  objective: string;
  activities: Activity[];
  versions: CourseVersion[];
  updatedAt: string;
  /** 课程修订号：每次成功写入 +1，标签页据此发现并发修改。 */
  revision: number;
}

export interface Diagnostic {
  id: string;
  activityId: string;
  level: IssueLevel;
  category: string;
  title: string;
  detail: string;
}

export interface CheckReport {
  id: string;
  label: string;
  /** 生成报告时对应的修订号与活动指纹。 */
  revision: number;
  fingerprint: string;
  checkedAt: string;
  diagnostics: Diagnostic[];
  stale?: boolean;
  staleReason?: string;
}

export type ConflictKind =
  | 'scalar'
  | 'phonemes'
  | 'dependencies'
  | 'activity-deleted'
  | 'order'
  | 'course';

export interface ConflictOption {
  value: string;
  label: string;
}

export interface ConflictItem {
  key: string;
  scope: 'meta' | 'activity' | 'course' | 'order';
  kind: ConflictKind;
  title: string;
  description: string;
  activityId?: string;
  activityTitle?: string;
  field?: string;
  oursLabel: string;
  theirsLabel: string;
  oursValue: string;
  theirsValue: string;
  /** 结构化的双方草稿（音素数组、依赖数组等）。 */
  ours?: unknown;
  theirs?: unknown;
  options: ConflictOption[];
}

export interface Resolution {
  choice: string;
  customValue?: string;
}

export type ResolutionMap = Record<string, Resolution>;

export interface MergeResult {
  merged: Course | null;
  conflicts: ConflictItem[];
}

export const OURS_LABEL = '本标签页草稿';
export const THEIRS_LABEL = '其他标签页草稿';
export const ACTIVITY_FIELDS: Array<keyof Activity> = [
  'title',
  'content',
  'type',
  'difficulty',
  'duration',
  'prompt',
  'accessibility',
  'feedback'
];
export const META_FIELDS: Array<keyof Course> = ['title', 'level', 'ageRange', 'objective'];
const FIELD_LABELS: Record<string, string> = {
  title: '标题',
  level: '课程等级',
  ageRange: '适用年龄',
  objective: '学习目标',
  content: '内容',
  type: '活动类型',
  difficulty: '难度',
  duration: '预计时长',
  prompt: '教师提示语',
  accessibility: '无障碍说明',
  feedback: '练习反馈'
};

export function cloneCourse(value: Course): Course {
  return structuredClone(value);
}

export function fieldLabel(field: string): string {
  return FIELD_LABELS[field] ?? field;
}

/** 单个活动参与比较的完整字段（含顺序敏感的依赖与音素）。 */
export function comparableActivity(activity: Activity): Omit<Activity, 'id'> & { id: string } {
  return {
    id: activity.id,
    type: activity.type,
    title: activity.title,
    content: activity.content,
    phonemes: normalizePhonemes(activity.phonemes),
    dependencies: [...activity.dependencies].sort(),
    difficulty: activity.difficulty,
    prompt: activity.prompt,
    accessibility: activity.accessibility,
    duration: activity.duration,
    feedback: activity.feedback
  };
}

/** 课程活动指纹：活动内容或顺序任意变化都会改变。 */
export function activityFingerprint(activities: Activity[]): string {
  const comparable = activities.map(comparableActivity);
  let hash = 5381;
  const serialized = JSON.stringify(comparable);
  for (let index = 0; index < serialized.length; index += 1) {
    hash = ((hash << 5) + hash + serialized.charCodeAt(index)) >>> 0;
  }
  return `af-${hash.toString(36)}-${activities.length}`;
}

export function versionFingerprint(version: CourseVersion): string {
  return version.fingerprint || activityFingerprint(version.activities);
}

/** 给版本列表刷新过期状态；封存版本永不过期。 */
export function refreshVersionStaleness(versions: CourseVersion[], current: Course): CourseVersion[] {
  const currentFingerprint = activityFingerprint(current.activities);
  return versions.map((version) => {
    if (version.sealed) {
      return { ...version, fingerprint: version.fingerprint || activityFingerprint(version.activities), stale: false, staleReason: undefined };
    }
    const stale = version.fingerprint !== currentFingerprint;
    return {
      ...version,
      stale,
      staleReason: stale ? '活动已变化，此未封存版本已过期' : undefined
    };
  });
}

export function isReportStale(report: CheckReport, current: Course): boolean {
  // 活动一变（内容或顺序）旧检查结果立即过期；仅课程信息变化不影响检查。
  return report.fingerprint !== activityFingerprint(current.activities);
}

export function refreshReportStaleness(report: CheckReport, current: Course): CheckReport {
  const stale = isReportStale(report, current);
  return {
    ...report,
    stale,
    staleReason: stale ? `检查基于修订 ${report.revision}，活动已变化，旧结果已过期并自动重算` : undefined
  };
}

export function normalizePhonemes(phonemes: string[]): string[] {
  return [...new Set(phonemes.map((item) => item.trim()).filter(Boolean))].sort();
}

function sameSet(left: string[], right: string[]): boolean {
  const a = new Set(left);
  const b = new Set(right);
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

function samePhonemes(left: string[], right: string[]): boolean {
  return sameSet(normalizePhonemes(left), normalizePhonemes(right));
}

function displayValue(value: unknown): string {
  if (Array.isArray(value)) return value.length ? value.join('、') : '（空）';
  if (value === undefined || value === null || value === '') return '（空）';
  return String(value);
}

function resolutionOf(resolutions: ResolutionMap, key: string): Resolution | undefined {
  return resolutions[key];
}

/**
 * 三向合并课程。resolutions 非空时按老师的选择消解冲突；
 * 仍无法消解的冲突继续返回，直到全部确认。
 */
export function mergeCourses(base: Course, ours: Course, theirs: Course, resolutions: ResolutionMap = {}): MergeResult {
  const conflicts: ConflictItem[] = [];

  // 整门课程被“复制课程”替换：不做字段级混拼，交给老师选择保留哪门课。
  if (base.id !== ours.id || base.id !== theirs.id) {
    const key = 'course:id';
    const resolved = resolutionOf(resolutions, key);
    if (!resolved) {
      conflicts.push({
        key,
        scope: 'course',
        kind: 'course',
        title: '两个标签页保存了不同的课程',
        description: `本标签页是“${ours.title}”，其他标签页是“${theirs.title}”。课程主体不同，无法自动混合，请选择保留哪一份（版本时间线仍会合并）。`,
        oursValue: ours.title,
        theirsValue: theirs.title,
        oursLabel: OURS_LABEL,
        theirsLabel: THEIRS_LABEL,
        ours: cloneCourse(ours),
        theirs: cloneCourse(theirs),
        options: [
          { value: 'ours', label: `保留：${ours.title}` },
          { value: 'theirs', label: `保留：${theirs.title}` }
        ]
      });
      return { merged: null, conflicts };
    }
    const chosen = resolved.choice === 'theirs' ? cloneCourse(theirs) : cloneCourse(ours);
    chosen.activities = chosen.activities.map((activity) => ({
      ...activity,
      dependencies: activity.dependencies.filter(
        (dep) => chosen.activities.some((item) => item.id === dep) && dep !== activity.id
      )
    }));
    chosen.versions = mergeVersions(base, ours, theirs, chosen);
    chosen.updatedAt = new Date().toISOString();
    chosen.revision = Math.max(base.revision, ours.revision, theirs.revision) + 1;
    return { merged: chosen, conflicts: [] };
  }

  const merged: Course = {
    ...cloneCourse(base),
    versions: [],
    updatedAt: new Date().toISOString(),
    revision: Math.max(base.revision, ours.revision, theirs.revision) + 1
  };

  for (const field of META_FIELDS) {
    (merged as unknown as Record<string, unknown>)[field] = pickMetaField(base, ours, theirs, field, resolutions, conflicts);
  }

  const mergedActivities = mergeActivities(base, ours, theirs, resolutions, conflicts);
  merged.activities = mergeOrder(base, ours, theirs, mergedActivities, resolutions, conflicts)
    .map((activity) => ({
      ...activity,
      dependencies: [...new Set(activity.dependencies)].filter((dep) =>
        mergedActivities.has(dep) && dep !== activity.id
      )
    }));
  merged.versions = refreshVersionStaleness(mergeVersions(base, ours, theirs, merged), merged);

  if (conflicts.length) return { merged: null, conflicts };
  return { merged, conflicts: [] };
}

function pickMetaField(
  base: Course,
  ours: Course,
  theirs: Course,
  field: keyof Course,
  resolutions: ResolutionMap,
  conflicts: ConflictItem[]
): unknown {
  const b = base[field] as unknown;
  const o = ours[field] as unknown;
  const t = theirs[field] as unknown;
  return threeWayValue(
    b,
    o,
    t,
    (description) => ({
      key: `meta:${field}`,
      scope: 'meta' as const,
      kind: 'scalar' as const,
      title: `课程信息“${fieldLabel(field)}”被双方同时修改`,
      description,
      field,
      oursValue: displayValue(o),
      theirsValue: displayValue(t),
      oursLabel: OURS_LABEL,
      theirsLabel: THEIRS_LABEL,
      ours: o,
      theirs: t,
      options: [
        { value: 'ours', label: `采用本标签页：${displayValue(o)}` },
        { value: 'theirs', label: `采用其他标签页：${displayValue(t)}` }
      ]
    }),
    `共同基线为“${displayValue(b)}”，两份草稿都改动了该字段且内容不同。`,
    resolutions,
    conflicts
  );
}

function threeWayValue(
  baseValue: unknown,
  oursValue: unknown,
  theirsValue: unknown,
  makeConflict: (description: string) => ConflictItem,
  description: string,
  resolutions: ResolutionMap,
  conflicts: ConflictItem[]
): unknown {
  if (JSON.stringify(oursValue) === JSON.stringify(baseValue)) return theirsValue;
  if (JSON.stringify(theirsValue) === JSON.stringify(baseValue)) return oursValue;
  if (JSON.stringify(oursValue) === JSON.stringify(theirsValue)) return oursValue;
  const conflict = makeConflict(description);
  const resolved = resolutionOf(resolutions, conflict.key);
  if (!resolved) {
    conflicts.push(conflict);
    return baseValue;
  }
  if (resolved.choice === 'theirs') return theirsValue;
  if (resolved.choice === 'custom' && resolved.customValue !== undefined) return resolved.customValue;
  return oursValue;
}

interface MergedActivityState {
  activity: Activity;
  /** 该活动在三方快照中的存在情况，供排序使用。 */
  inBase: boolean;
}

function mergeActivities(
  base: Course,
  ours: Course,
  theirs: Course,
  resolutions: ResolutionMap,
  conflicts: ConflictItem[]
): Map<string, MergedActivityState> {
  const result = new Map<string, MergedActivityState>();
  const baseMap = new Map(base.activities.map((activity) => [activity.id, activity]));
  const oursMap = new Map(ours.activities.map((activity) => [activity.id, activity]));
  const theirsMap = new Map(theirs.activities.map((activity) => [activity.id, activity]));
  const allIds = new Set([...baseMap.keys(), ...oursMap.keys(), ...theirsMap.keys()]);

  for (const id of allIds) {
    const b = baseMap.get(id);
    const o = oursMap.get(id);
    const t = theirsMap.get(id);

    if (b && o && t) {
      const mergedActivity = mergeActivityFields(b, o, t, resolutions, conflicts);
      if (mergedActivity) result.set(id, { activity: mergedActivity, inBase: true });
      continue;
    }
    if (b && o && !t) {
      // 对方删除：本页未改则跟随删除；删除与本页编辑同时发生时需要裁决。
      if (activityEquals(b, o)) continue;
      const resolution = resolutions[`activity:${id}:deleted-theirs`];
      if (resolution?.choice === 'delete') continue;
      if (resolution?.choice === 'keep') {
        result.set(id, { activity: cloneActivity(o), inBase: true });
        continue;
      }
      conflicts.push(deletedEditConflict(id, b, o, 'theirs'));
      continue;
    }
    if (b && !o && t) {
      if (activityEquals(b, t)) continue;
      const resolution = resolutions[`activity:${id}:deleted-ours`];
      if (resolution?.choice === 'delete') continue;
      if (resolution?.choice === 'keep') {
        result.set(id, { activity: cloneActivity(t), inBase: true });
        continue;
      }
      conflicts.push(deletedEditConflict(id, b, t, 'ours'));
      continue;
    }
    if (b && !o && !t) continue; // 双方都删除
    if (!b && o && t) {
      // 双方各自新增了同 id 活动（通常来自复制），字段仍走三向合并，基线为空活动。
      const empty = emptyActivity(o);
      const mergedActivity = mergeActivityFields(empty, o, t, resolutions, conflicts);
      if (mergedActivity) result.set(id, { activity: mergedActivity, inBase: false });
      continue;
    }
    if (o) result.set(id, { activity: cloneActivity(o), inBase: false });
    else if (t) result.set(id, { activity: cloneActivity(t), inBase: false });
  }

  return result;
}

function emptyActivity(template: Activity): Activity {
  return {
    id: template.id,
    type: '练习',
    title: '',
    content: '',
    phonemes: [],
    dependencies: [],
    difficulty: 1,
    prompt: '',
    accessibility: '',
    duration: 8,
    feedback: ''
  };
}

function cloneActivity(activity: Activity): Activity {
  return structuredClone(activity);
}

export function activityEquals(left: Activity, right: Activity): boolean {
  return JSON.stringify(comparableActivity(left)) === JSON.stringify(comparableActivity(right));
}

function deletedEditConflict(id: string, baseActivity: Activity, editedActivity: Activity, deletedBy: 'ours' | 'theirs'): ConflictItem {
  const oursDeleted = deletedBy === 'ours';
  return {
    key: `activity:${id}:deleted-${deletedBy}`,
    scope: 'activity',
    kind: 'activity-deleted',
    activityId: id,
    activityTitle: editedActivity.title,
    title: oursDeleted
      ? `“${editedActivity.title}”在本标签页被删除，在其他标签页被修改`
      : `“${editedActivity.title}”在其他标签页被删除，在本标签页被修改`,
    description: `删除与编辑同时发生。请确认保留合并后的修改，还是确认删除。（修改后的标题为“${editedActivity.title}”）`,
    oursValue: oursDeleted ? '已删除' : '已修改并保留',
    theirsValue: oursDeleted ? '已修改并保留' : '已删除',
    oursLabel: OURS_LABEL,
    theirsLabel: THEIRS_LABEL,
    ours: oursDeleted ? null : cloneActivity(editedActivity),
    theirs: oursDeleted ? cloneActivity(editedActivity) : null,
    options: [
      { value: 'keep', label: '保留该活动（采用修改后的内容）' },
      { value: 'delete', label: '确认删除' }
    ]
  };
}

function mergeActivityFields(
  base: Activity,
  ours: Activity,
  theirs: Activity,
  resolutions: ResolutionMap,
  conflicts: ConflictItem[]
): Activity | null {
  // 先处理删除/编辑冲突（仅当该活动在某方缺失时由调用方处理），这里三方都存在。
  const merged: Activity = {
    id: base.id,
    type: '练习',
    title: '',
    content: '',
    phonemes: [],
    dependencies: [],
    difficulty: 1,
    prompt: '',
    accessibility: '',
    duration: 8,
    feedback: ''
  };

  for (const field of ACTIVITY_FIELDS) {
    const b = base[field] as unknown;
    const o = ours[field] as unknown;
    const t = theirs[field] as unknown;
    const numeric = field === 'difficulty' || field === 'duration';
    const value = threeWayValue(
      b,
      o,
      t,
      (description) => ({
        key: `activity:${base.id}:${field}`,
        scope: 'activity' as const,
        kind: 'scalar' as const,
        activityId: base.id,
        activityTitle: ours.title || base.title,
        field,
        title: `“${ours.title || base.title}”的${fieldLabel(field)}被双方同时修改`,
        description,
        oursValue: displayValue(o),
        theirsValue: displayValue(t),
        oursLabel: OURS_LABEL,
        theirsLabel: THEIRS_LABEL,
        ours: o,
        theirs: t,
        options: [
          { value: 'ours', label: `采用本标签页：${displayValue(o)}` },
          { value: 'theirs', label: `采用其他标签页：${displayValue(t)}` }
        ]
      }),
      `共同基线为“${displayValue(b)}”，两份草稿都改动且内容不同。`,
      resolutions,
      conflicts
    );
    (merged as unknown as Record<string, unknown>)[field] = numeric ? Number(value) : value;
  }

  merged.phonemes = mergePhonemes(base, ours, theirs, resolutions, conflicts);
  merged.dependencies = mergeDependencies(base, ours, theirs, resolutions, conflicts);
  return merged;
}

function mergePhonemes(
  base: Activity,
  ours: Activity,
  theirs: Activity,
  resolutions: ResolutionMap,
  conflicts: ConflictItem[]
): string[] {
  const b = normalizePhonemes(base.phonemes);
  const o = normalizePhonemes(ours.phonemes);
  const t = normalizePhonemes(theirs.phonemes);
  if (sameSet(o, b)) return t;
  if (sameSet(t, b)) return o;
  if (sameSet(o, t)) return o;
  const key = `activity:${base.id}:phonemes`;
  const resolved = resolutionOf(resolutions, key);
  if (resolved?.choice === 'theirs') return t;
  if (resolved?.choice === 'union') return [...new Set([...o, ...t])].sort();
  if (resolved?.choice === 'custom' && resolved.customValue !== undefined) {
    return normalizePhonemes(resolved.customValue.split(/[\s,，、]+/));
  }
  if (resolved?.choice === 'ours') return o;
  conflicts.push({
    key,
    scope: 'activity',
    kind: 'phonemes',
    activityId: base.id,
    activityTitle: ours.title || base.title,
    field: 'phonemes',
    title: `“${ours.title || base.title}”的音素被双方同时修改`,
    description: `共同基线为 ${displayValue(b)}，两份草稿改成了不同的音素集合。`,
    oursValue: displayValue(o),
    theirsValue: displayValue(t),
    oursLabel: OURS_LABEL,
    theirsLabel: THEIRS_LABEL,
    ours: o,
    theirs: t,
    options: [
      { value: 'ours', label: `采用本标签页：${displayValue(o)}` },
      { value: 'theirs', label: `采用其他标签页：${displayValue(t)}` },
      { value: 'union', label: `合并双方音素：${displayValue([...new Set([...o, ...t])].sort())}` },
      { value: 'custom', label: '手动指定音素' }
    ]
  });
  return b;
}

function mergeDependencies(
  base: Activity,
  ours: Activity,
  theirs: Activity,
  resolutions: ResolutionMap,
  conflicts: ConflictItem[]
): string[] {
  const b = [...base.dependencies].sort();
  const o = [...ours.dependencies].sort();
  const t = [...theirs.dependencies].sort();
  if (JSON.stringify(o) === JSON.stringify(b)) return t;
  if (JSON.stringify(t) === JSON.stringify(b)) return o;
  if (JSON.stringify(o) === JSON.stringify(t)) return o;
  const key = `activity:${base.id}:dependencies`;
  const resolved = resolutionOf(resolutions, key);
  if (resolved?.choice === 'theirs') return t.filter((dep) => dep !== base.id);
  if (resolved?.choice === 'union') return [...new Set([...o, ...t])].filter((dep) => dep !== base.id).sort();
  if (resolved?.choice === 'ours') return o.filter((dep) => dep !== base.id);
  conflicts.push({
    key,
    scope: 'activity',
    kind: 'dependencies',
    activityId: base.id,
    activityTitle: ours.title || base.title,
    field: 'dependencies',
    title: `“${ours.title || base.title}”的前置依赖被双方同时修改`,
    description: `共同基线有 ${b.length} 个依赖，两份草稿勾选了不同的前置活动。`,
    oursValue: displayValue(o),
    theirsValue: displayValue(t),
    oursLabel: OURS_LABEL,
    theirsLabel: THEIRS_LABEL,
    ours: o,
    theirs: t,
    options: [
      { value: 'ours', label: `采用本标签页（${o.length} 个依赖）` },
      { value: 'theirs', label: `采用其他标签页（${t.length} 个依赖）` },
      { value: 'union', label: `合并双方依赖（${new Set([...o, ...t]).size} 个）` }
    ]
  });
  return b;
}

function orderKey(ids: string[]): string {
  return ids.join('|');
}

function restrictedOrder(activities: Activity[], keep: Set<string>): string[] {
  return activities.map((activity) => activity.id).filter((id) => keep.has(id));
}

/**
 * 顺序合并：只有一方调整顺序时自动采用；双方都调整时取并集偏序做拓扑，
 * 若两边的顺序要求互相矛盾，则生成顺序冲突由老师确认。
 */
function mergeOrder(
  base: Course,
  ours: Course,
  theirs: Course,
  mergedActivities: Map<string, MergedActivityState>,
  resolutions: ResolutionMap,
  conflicts: ConflictItem[]
): Activity[] {
  const surviving = new Set(mergedActivities.keys());
  const baseOrder = restrictedOrder(base.activities, surviving);
  const baseCommon = new Set(
    baseOrder.filter((id) => ours.activities.some((a) => a.id === id) && theirs.activities.some((a) => a.id === id))
  );
  const oursOrder = restrictedOrder(ours.activities, new Set([...surviving].filter((id) => ours.activities.some((a) => a.id === id))));
  const theirsOrder = restrictedOrder(theirs.activities, new Set([...surviving].filter((id) => theirs.activities.some((a) => a.id === id))));
  const oursReordered = orderKey(restrictedOrder(ours.activities, baseCommon)) !== orderKey(restrictedOrder(base.activities, baseCommon));
  const theirsReordered = orderKey(restrictedOrder(theirs.activities, baseCommon)) !== orderKey(restrictedOrder(base.activities, baseCommon));

  let chosenOrder: string[];

  if (!oursReordered && !theirsReordered) {
    const adds = [...surviving].filter((id) => !baseCommon.has(id) && !baseOrder.includes(id));
    chosenOrder = [...baseOrder, ...adds];
  } else if (oursReordered && !theirsReordered) {
    chosenOrder = [...oursOrder, ...[...surviving].filter((id) => !oursOrder.includes(id))];
  } else if (!oursReordered && theirsReordered) {
    chosenOrder = [...theirsOrder, ...[...surviving].filter((id) => !theirsOrder.includes(id))];
  } else {
    const key = 'activities:order';
    const resolved = resolutionOf(resolutions, key);
    if (resolved?.choice === 'ours') {
      chosenOrder = [...oursOrder, ...[...surviving].filter((id) => !oursOrder.includes(id))];
    } else if (resolved?.choice === 'theirs') {
      chosenOrder = [...theirsOrder, ...[...surviving].filter((id) => !theirsOrder.includes(id))];
    } else if (resolved?.choice === 'base') {
      const adds = [...surviving].filter((id) => !baseOrder.includes(id));
      chosenOrder = [...baseOrder, ...adds];
    } else {
      const topological = topologicalOrder([oursOrder, theirsOrder], baseOrder, surviving);
      if (topological) {
        chosenOrder = topological;
      } else {
        conflicts.push({
          key,
          scope: 'order',
          kind: 'order',
          title: '活动顺序被两个标签页同时调整且要求冲突',
          description: '两边都重排了活动，但部分活动的先后关系正好相反，无法同时满足。请选择以哪份草稿的顺序为准（新增活动会追加到末尾）。',
          oursValue: ours.activities.map((activity, index) => `${index + 1}. ${activity.title}`).join('\n'),
          theirsValue: theirs.activities.map((activity, index) => `${index + 1}. ${activity.title}`).join('\n'),
          oursLabel: OURS_LABEL,
          theirsLabel: THEIRS_LABEL,
          ours: oursOrder,
          theirs: theirsOrder,
          options: [
            { value: 'ours', label: '采用本标签页的顺序' },
            { value: 'theirs', label: '采用其他标签页的顺序' },
            { value: 'base', label: '恢复共同基线顺序，新增活动追加到末尾' }
          ]
        });
        chosenOrder = baseOrder;
      }
    }
  }

  return chosenOrder
    .filter((id) => mergedActivities.has(id))
    .map((id) => mergedActivities.get(id)!.activity);
}

/** 多个顺序的并集偏序拓扑；出现环时返回 null。 */
function topologicalOrder(sequences: string[][], baseOrder: string[], surviving: Set<string>): string[] | null {
  const indegree = new Map<string, number>();
  const edges = new Map<string, Set<string>>();
  for (const id of surviving) {
    indegree.set(id, 0);
    edges.set(id, new Set());
  }
  for (const sequence of sequences) {
    for (let i = 0; i < sequence.length; i += 1) {
      for (let j = i + 1; j < sequence.length; j += 1) {
        const from = sequence[i];
        const to = sequence[j];
        if (!surviving.has(from) || !surviving.has(to)) continue;
        if (!edges.get(from)!.has(to)) {
          edges.get(from)!.add(to);
          indegree.set(to, (indegree.get(to) ?? 0) + 1);
        }
      }
    }
  }
  const baseIndex = new Map(baseOrder.map((id, index) => [id, index]));
  const sequenceIndex = sequences.map((sequence) => new Map(sequence.map((id, index) => [id, index])));
  const ordered: string[] = [];
  const remaining = new Set(surviving);
  while (remaining.size) {
    const ready = [...remaining].filter((id) => (indegree.get(id) ?? 0) === 0);
    if (!ready.length) return null;
    ready.sort((left, right) => {
      const li = baseIndex.has(left) ? baseIndex.get(left)! : Number.MAX_SAFE_INTEGER;
      const ri = baseIndex.has(right) ? baseIndex.get(right)! : Number.MAX_SAFE_INTEGER;
      if (li !== ri) return li - ri;
      for (const indexMap of sequenceIndex) {
        const l = indexMap.get(left);
        const r = indexMap.get(right);
        if (l !== undefined && r !== undefined && l !== r) return l - r;
      }
      return left.localeCompare(right);
    });
    const next = ready[0];
    ordered.push(next);
    remaining.delete(next);
    for (const to of edges.get(next) ?? []) {
      indegree.set(to, (indegree.get(to) ?? 1) - 1);
    }
  }
  return ordered;
}

function mergeVersions(base: Course, ours: Course, theirs: Course, chosen: Course): CourseVersion[] {
  const byId = new Map<string, CourseVersion>();
  const consider = (version: CourseVersion) => {
    const existing = byId.get(version.id);
    if (!existing || version.savedAt > existing.savedAt) byId.set(version.id, structuredClone(version));
  };
  base.versions.forEach(consider);
  ours.versions.forEach(consider);
  theirs.versions.forEach(consider);
  const merged = [...byId.values()].sort((left, right) => left.savedAt.localeCompare(right.savedAt));
  return refreshVersionStaleness(merged, chosen);
}

export function isConflictResolved(conflict: ConflictItem, resolution: Resolution | undefined): boolean {
  if (!resolution) return false;
  if (!conflict.options.some((option) => option.value === resolution.choice)) return false;
  if (resolution.choice === 'custom') return (resolution.customValue ?? '').trim().length > 0;
  return true;
}

export function unresolvedConflicts(conflicts: ConflictItem[], resolutions: ResolutionMap): ConflictItem[] {
  return conflicts.filter((conflict) => !isConflictResolved(conflict, resolutions[conflict.key]));
}

/** 老师确认全部冲突后的最终合并；返回未消解项（正常应为空）。 */
export function resolveMergedCourse(
  base: Course,
  ours: Course,
  theirs: Course,
  resolutions: ResolutionMap
): MergeResult {
  return mergeCourses(base, ours, theirs, resolutions);
}

export function describeConflictPair(conflict: ConflictItem): { label: string; value: string }[] {
  return [
    { label: conflict.oursLabel, value: conflict.oursValue },
    { label: conflict.theirsLabel, value: conflict.theirsValue }
  ];
}
