import {
  mergeCourses,
  resolveMergedCourse,
  activityFingerprint,
  refreshVersionStaleness,
  isReportStale,
  type Activity,
  type Course
} from '../src/lib/collaboration.ts';

let failures = 0;
function assert(condition: boolean, message: string): void {
  if (!condition) {
    failures += 1;
    console.error(`✗ ${message}`);
  } else {
    console.log(`✓ ${message}`);
  }
}

function makeActivity(id: string, overrides: Partial<Activity> = {}) {
  return {
    id,
    type: '音素' as const,
    title: `活动 ${id}`,
    content: '/m/',
    phonemes: ['/m/'],
    dependencies: [] as string[],
    difficulty: 1,
    prompt: 'p',
    accessibility: 'a',
    duration: 6,
    feedback: '',
    ...overrides
  };
}

function makeCourse(activities: ReturnType<typeof makeActivity>[], revision = 1): Course {
  return {
    id: 'c1',
    title: '课程',
    level: 'L1',
    ageRange: '5-6',
    objective: '目标',
    activities,
    versions: [],
    updatedAt: new Date().toISOString(),
    revision
  };
}

// 1. 互不重叠字段：本页改标题，对方改时长 → 自动合并
{
  const base = makeCourse([makeActivity('a1')]);
  const ours = makeCourse([makeActivity('a1', { title: '本页标题' })]);
  const theirs = makeCourse([makeActivity('a1', { duration: 20 })]);
  const result = mergeCourses(base, ours, theirs, {});
  assert(result.merged !== null, '非重叠字段自动合并不产生冲突');
  assert(result.merged?.activities[0].title === '本页标题', '保留本页标题修改');
  assert(result.merged?.activities[0].duration === 20, '保留对方时长修改');
}

// 2. 音素双方都改成不同集合 → 冲突，双方草稿保留
{
  const base = makeCourse([makeActivity('a1', { phonemes: ['/m/'] })]);
  const ours = makeCourse([makeActivity('a1', { phonemes: ['/m/', '/s/'] })]);
  const theirs = makeCourse([makeActivity('a1', { phonemes: ['/m/', '/t/'] })]);
  const result = mergeCourses(base, ours, theirs, {});
  assert(result.merged === null && result.conflicts.length === 1, '音素同时修改产生一个冲突');
  assert(result.conflicts[0].kind === 'phonemes', '冲突类型为 phonemes');
  assert(result.conflicts[0].oursValue.includes('/s/') && result.conflicts[0].theirsValue.includes('/t/'), '冲突说明保留双方草稿');
  const resolved = resolveMergedCourse(base, ours, theirs, {
    [result.conflicts[0].key]: { choice: 'union' }
  });
  assert(resolved.merged?.activities[0].phonemes.sort().join(',') === '/m/,/s/,/t/', '确认 union 后合并双方音素');
}

// 3. 依赖双方不同修改 → 冲突；确认 theirs 后生效
{
  const base = makeCourse([makeActivity('a1'), makeActivity('a2')]);
  const ours = makeCourse([makeActivity('a1'), makeActivity('a2', { dependencies: ['a1'] })]);
  const theirs = makeCourse([makeActivity('a1'), makeActivity('a2')]);
  theirs.activities[0].dependencies = [];
  // 让 a2 在两边都存在，仅 a2 的依赖不同：本页勾选 a1，对方不勾选但改了别的字段以区分
  ours.activities[0].title = '本页改了 a1 标题';
  theirs.activities[1].dependencies = [];
  // 构造真正的依赖冲突：base a2 deps=[]；ours [a1]；theirs 给一个新增活动的依赖
  theirs.activities.push(makeActivity('a3'));
  const base2 = makeCourse([makeActivity('a1'), makeActivity('a2')]);
  const result = mergeCourses(base2, ours, theirs, {});
  // ours 改了 a1.title（对方没改 a1），theirs 新增 a3，a2 的依赖仅本页改 → 应自动合并
  const depConflict = result.conflicts.find((c) => c.kind === 'dependencies');
  assert(!depConflict, '单边修改依赖不产生冲突');
  assert(result.merged !== null, '单边依赖修改可自动合并');
  assert(result.merged.activities.find((a) => a.id === 'a2')?.dependencies.includes('a1'), '自动合并保留本页的依赖勾选');
  assert(result.merged.activities.some((a) => a.id === 'a3'), '自动合并保留对方新增的活动');
}

// 4. 顺序双方都重排且冲突 → 顺序冲突；确认 ours 生效
{
  const base = makeCourse([makeActivity('a1'), makeActivity('a2'), makeActivity('a3')]);
  const ours = makeCourse([makeActivity('a3'), makeActivity('a2'), makeActivity('a1')], 2);
  const theirs = makeCourse([makeActivity('a1', { title: 'X' }), makeActivity('a2'), makeActivity('a3')], 3);
  // theirs 也重排：把 a1 移到最后
  theirs.activities = [makeActivity('a2'), makeActivity('a3'), makeActivity('a1', { title: 'X' })];
  const result = mergeCourses(base, ours, theirs, {});
  const orderConflict = result.conflicts.find((c) => c.kind === 'order');
  assert(Boolean(orderConflict), '双方同时反向调整顺序产生顺序冲突');
  const resolved = resolveMergedCourse(base, ours, theirs, {
    [orderConflict!.key]: { choice: 'ours' },
    ...Object.fromEntries(result.conflicts.filter((c) => c.kind !== 'order').map((c) => [c.key, { choice: 'ours' }]))
  });
  assert(resolved.merged?.activities.map((a) => a.id).join(',') === 'a3,a2,a1', '确认本页顺序后生效');
}

// 5. 顺序双方调整但可兼容（拓扑并集）→ 自动合并
{
  const base = makeCourse([makeActivity('a1'), makeActivity('a2')]);
  const ours = makeCourse([makeActivity('a1', { title: 'O1' }), makeActivity('a2')]);
  ours.activities.push(makeActivity('a3')); // a1,a2,a3
  const theirs = makeCourse([makeActivity('a1'), makeActivity('a2', { title: 'T2' })]);
  theirs.activities = [makeActivity('a1'), makeActivity('a2', { title: 'T2' })];
  // 两边都调整了公共顺序：ours a1->a2 不变， theirs a2->a1（反向）
  theirs.activities = [makeActivity('a2', { title: 'T2' }), makeActivity('a1')];
  const result = mergeCourses(base, ours, theirs, {});
  // ours 未重排公共对（a1,a2），theirs 重排了 → 自动采用 theirs 顺序
  assert(!result.conflicts.some((c) => c.kind === 'order'), '仅一方调整公共顺序时不产生顺序冲突');
}

// 6. 删除 vs 编辑 → 冲突，双方保留
{
  const base = makeCourse([makeActivity('a1'), makeActivity('a2')]);
  const ours = makeCourse([makeActivity('a1'), makeActivity('a2', { title: '本页编辑' })], 2);
  const theirs = makeCourse([makeActivity('a1')], 3); // 对方删除 a2
  const result = mergeCourses(base, ours, theirs, {});
  const delConflict = result.conflicts.find((c) => c.kind === 'activity-deleted');
  assert(Boolean(delConflict), '删除与编辑同时发生产生冲突');
  const resolved = resolveMergedCourse(base, ours, theirs, {
    [delConflict!.key]: { choice: 'keep' }
  });
  assert(resolved.merged?.activities.some((a) => a.id === 'a2'), '确认保留后活动仍在');
  const deleted = resolveMergedCourse(base, ours, theirs, {
    [delConflict!.key]: { choice: 'delete' }
  });
  assert(!deleted.merged?.activities.some((a) => a.id === 'a2'), '确认删除后活动移除');
}

// 7. 版本过期：未封存版本指纹不匹配 → stale；封存版本永不过期
{
  const activities = [makeActivity('a1')];
  const fp = activityFingerprint(activities);
  const course = makeCourse([makeActivity('a1', { title: '改了' })]);
  course.versions = [
    { id: 'v1', label: '未封存', savedAt: '2026-01-01', note: '', activities, sealed: false, fingerprint: fp },
    { id: 'v2', label: '已封存', savedAt: '2026-01-02', note: '', activities, sealed: true, fingerprint: fp }
  ];
  const refreshed = refreshVersionStaleness(course.versions, course);
  assert(refreshed[0].stale === true, '未封存版本在活动变化后过期');
  assert(refreshed[1].stale === false, '已封存版本永不过期');
}

// 8. 检查报告：指纹不匹配即过期
{
  const base = makeCourse([makeActivity('a1')]);
  const changed = makeCourse([makeActivity('a1', { title: '新' })]);
  changed.revision = 5;
  const report = {
    id: 'r1', label: 'r', revision: 1,
    fingerprint: activityFingerprint(base.activities),
    checkedAt: new Date().toISOString(), diagnostics: []
  };
  assert(isReportStale(report, changed) === true, '活动变化后旧检查报告过期');
  assert(isReportStale(report, base) === false, '活动未变则报告仍有效');
}

// 9. 失效依赖在合并后被清理
{
  const base = makeCourse([makeActivity('a1'), makeActivity('a2', { dependencies: ['a1'] })]);
  const ours = makeCourse([makeActivity('a1'), makeActivity('a2', { dependencies: ['a1'], title: 'O' })]);
  const theirs = makeCourse([makeActivity('a2', { dependencies: ['a1'] })]); // 对方删除 a1（本页未编辑 a1）
  const result = mergeCourses(base, ours, theirs, {});
  assert(result.merged !== null, '对方删除本页未编辑的活动时自动合并');
  const a2 = result.merged.activities.find((a) => a.id === 'a2');
  assert(a2 && !a2.dependencies.includes('a1'), '被删活动的依赖自动清理');
}

// 10. 课程信息双方修改不同字段自动合并
{
  const base = makeCourse([]);
  const ours = makeCourse([]); ours.title = '新名称';
  const theirs = makeCourse([]); theirs.level = 'L9';
  const result = mergeCourses(base, ours, theirs, {});
  assert(result.merged?.title === '新名称' && result.merged.level === 'L9', '课程元信息非重叠字段自动合并');
}

// 11. 修订号取三方最大值 +1
{
  const base = makeCourse([], 3);
  const ours = makeCourse([], 5);
  const theirs = makeCourse([], 8);
  const result = mergeCourses(base, ours, theirs, {});
  assert(result.merged?.revision === 9, '合并结果修订号为 max(base, ours, theirs)+1');
}

// 12. 同一标量字段双方改成相同值 → 无冲突
{
  const base = makeCourse([makeActivity('a1', { title: '原标题' })]);
  const ours = makeCourse([makeActivity('a1', { title: '相同新标题' })]);
  const theirs = makeCourse([makeActivity('a1', { title: '相同新标题' })]);
  const result = mergeCourses(base, ours, theirs, {});
  assert(result.merged !== null && result.merged.activities[0].title === '相同新标题', '双方改成相同值不产生冲突');
}

// 13. 双方各自新增不同活动 → 合并后都保留
{
  const base = makeCourse([makeActivity('a1')]);
  const ours = makeCourse([makeActivity('a1'), makeActivity('a2', { title: '本页新增' })]);
  const theirs = makeCourse([makeActivity('a1'), makeActivity('a3', { title: '对方新增' })]);
  const result = mergeCourses(base, ours, theirs, {});
  assert(result.merged !== null, '双方各增不同活动自动合并');
  assert(result.merged.activities.some((a) => a.id === 'a2') && result.merged.activities.some((a) => a.id === 'a3'), '两个新增活动都保留');
}

// 14. 部分确认无法生效：只确认一个冲突时另一个仍返回
{
  const base = makeCourse([makeActivity('a1', { phonemes: ['/m/'], prompt: '基线' })]);
  const ours = makeCourse([makeActivity('a1', { phonemes: ['/s/'], prompt: '本页提示' })]);
  const theirs = makeCourse([makeActivity('a1', { phonemes: ['/t/'], prompt: '对方提示' })]);
  const initial = mergeCourses(base, ours, theirs, {});
  assert(initial.conflicts.length >= 2, '音素与提示语同时冲突产生多条记录');
  const oneResolved = resolveMergedCourse(base, ours, theirs, {
    [initial.conflicts[0].key]: { choice: 'ours' }
  });
  assert(oneResolved.merged === null && oneResolved.conflicts.length >= 1, '只确认部分条目时草稿暂不生效');
  const allResolved = resolveMergedCourse(base, ours, theirs, Object.fromEntries(
    initial.conflicts.map((conflict) => [conflict.key, { choice: 'ours' }])
  ));
  assert(allResolved.merged !== null, '全部确认后草稿生效');
}

// 15. 课程主体被复制（id 变化）→ 课程级冲突
{
  const base = makeCourse([makeActivity('a1')]);
  const ours = makeCourse([makeActivity('a1')]); ours.id = 'course-copy-1'; ours.title = '副本 A';
  const theirs = makeCourse([makeActivity('a1')]); theirs.title = '原课程改名';
  const result = mergeCourses(base, ours, theirs, {});
  const courseConflict = result.conflicts.find((c) => c.kind === 'course');
  assert(Boolean(courseConflict), '课程被复制成不同主体时产生课程级冲突');
  const resolved = resolveMergedCourse(base, ours, theirs, { [courseConflict!.key]: { choice: 'theirs' } });
  assert(resolved.merged?.id === 'c1' && resolved.merged.title === '原课程改名', '确认对方草稿后保留对方课程主体');
}

console.log(failures ? `\n${failures} 个断言失败` : '\n全部断言通过');
process.exit(failures ? 1 : 0);
