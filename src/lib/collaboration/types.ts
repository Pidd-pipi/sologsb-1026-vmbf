export type ActivityType = '音素' | '单词' | '句子' | '练习';

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
  /** 封存版本由老师明确存档，永不过期；未封存版本只是自动草稿快照。 */
  sealed: boolean;
  /** 快照生成时对应的课程修订号；与当前修订不一致即为过期。 */
  revision: number;
  /** 活动变化后，未封存版本立即标记过期，不能再用于比较或复制。 */
  stale?: boolean;
}

export interface QaReport {
  revision: number;
  /** 与当前活动数据签名不一致即为过期，需要重算。 */
  signature: string;
  diagnostics: Diagnostic[];
  checkedAt: string;
}

export interface Diagnostic {
  id: string;
  activityId: string;
  level: 'error' | 'warning' | 'info';
  category: string;
  title: string;
  detail: string;
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
  /** 课程修订号，每次有标签页成功写入 +1，多标签页合并的依据。 */
  revision: number;
  /** 最近一次写入该课程的标签页，仅用于冲突提示。 */
  lastTabId?: string;
}

export type VersionDiff = {
  id: string;
  title: string;
  kind: 'added' | 'removed' | 'changed';
  detail: string;
};

export type ConflictField =
  | 'meta'
  | 'activity'
  | 'phonemes'
  | 'dependencies'
  | 'order'
  | 'existence'
  | 'course-replaced';

export interface ConflictChoice {
  label: string;
  detail: string;
}

export interface CourseConflict {
  id: string;
  kind: ConflictField;
  /** 结构化字段，用于最终生效时取值。 */
  field?: keyof Course | keyof Activity;
  activityId?: string;
  title: string;
  detail: string;
  /** 同时修改的重点结构（顺序/依赖/音素）标记。 */
  structural: boolean;
  local: ConflictChoice;
  remote: ConflictChoice;
}

export type ConflictSessionStatus = 'pending' | 'resolved' | 'abandoned' | 'failed';

export interface ConflictSession {
  id: string;
  status: ConflictSessionStatus;
  createdAt: string;
  updatedAt: string;
  /** 合并的共同祖先。 */
  baseRevision: number;
  /** 本标签页草稿基于的修订号。 */
  localRevision: number;
  /** 对端标签页写入的修订号。 */
  remoteRevision: number;
  localTabId: string;
  remoteTabId?: string;
  conflicts: CourseConflict[];
  /** 已确认的选择：conflictId -> 'local' | 'remote'。 */
  resolutions: Record<string, 'local' | 'remote'>;
  /** 双方完整草稿，冲突处理失败也能找回。 */
  baseCourse: Course | null;
  localCourse: Course;
  remoteCourse: Course;
  /** 冲突期间本标签页的工作草稿，持续保存，防丢失。 */
  workingCourse: Course;
  provisional: Course;
  /** course-replaced 型冲突：对端把整门课程换成了别的。 */
  replaced?: { remoteTitle: string; remoteId: string };
  note?: string;
}

export interface MergeOutcome {
  merged: Course;
  conflicts: CourseConflict[];
  session?: ConflictSession;
}
