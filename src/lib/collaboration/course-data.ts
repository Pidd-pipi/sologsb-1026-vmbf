import type { Course, CourseVersion } from './types';

/** 补齐协作保护引入的修订号、封存标记；旧版本一律视为老师明确存档（封存）。 */
export function migrateCourse(value: Course): Course {
  if (!value || !value.id || !Array.isArray(value.activities)) return initialCourse();
  value.versions ??= [];
  if (typeof value.revision !== 'number') value.revision = 1;
  value.versions = value.versions.map((version) => normalizeVersion(version, value.revision));
  return value;
}

function normalizeVersion(version: CourseVersion, revision: number): CourseVersion {
  return {
    ...version,
    // 旧数据中的版本都是老师点“存档版本”产生的，视为封存版本，不标过期。
    sealed: version.sealed ?? true,
    revision: typeof version.revision === 'number' ? version.revision : revision
  };
}

export function initialCourse(): Course {
  const base: Course = {
    id: 'course-phonics-1',
    title: 'Starter Phonics · 声音侦探',
    level: '启蒙一级',
    ageRange: '5–6 岁',
    objective: '建立音素意识，能听辨、拼读并书写短元音单词。',
    updatedAt: '2026-09-24T16:20:00+08:00',
    revision: 3,
    activities: [
      {
        id: 'a-1', type: '音素', title: '听音游戏：认识 /m/', content: '/m/',
        phonemes: ['/m/'], dependencies: [], difficulty: 1,
        prompt: '闭上嘴唇，轻轻发出 /m/，感受鼻子的震动。',
        accessibility: '提供口型示范图和可重复播放的低频音频。', duration: 6, feedback: ''
      },
      {
        id: 'a-2', type: '音素', title: '首音识别：/s/ 与 /m/', content: '/s/ /m/',
        phonemes: ['/s/', '/m/'], dependencies: ['a-1'], difficulty: 1,
        prompt: '听到单词时拍手，听到 /m/ 时把手放在鼻子上。',
        accessibility: '视觉提示使用不同形状，不只依赖颜色。', duration: 8, feedback: ''
      },
      {
        id: 'a-3', type: '单词', title: '拼读短词：sat', content: 's – a – t → sat',
        phonemes: ['/s/', '/æ/', '/t/'], dependencies: ['a-2'], difficulty: 2,
        prompt: '用手指依次点每个字母，再连起来读。',
        accessibility: '字母块支持键盘逐字聚焦和屏幕阅读器朗读。', duration: 10, feedback: '三条电缆拼在一起形成完整电路。'
      },
      {
        id: 'a-4', type: '练习', title: '听音选图：m / s 开头', content: 'moon, sun, mat, sock',
        phonemes: ['/m/', '/s/'], dependencies: ['a-2'], difficulty: 2,
        prompt: '先听单词，再从两张图片中选出正确首音。',
        accessibility: '所有图片均配替代文本，可只用键盘选择。', duration: 8, feedback: ''
      },
      {
        id: 'a-5', type: '音素', title: '短元音 /æ/ 的口型', content: '/æ/',
        phonemes: ['/æ/'], dependencies: ['a-1'], difficulty: 2,
        prompt: '嘴巴张大，舌尖放低，声音短而有力。',
        accessibility: '提供正面口型、侧面舌位和慢速音频。', duration: 6, feedback: ''
      },
      {
        id: 'a-6', type: '句子', title: '拼读句子：Mat sat.', content: 'Mat sat on the mat.',
        phonemes: ['/m/', '/æ/', '/s/', '/t/'], dependencies: ['a-3'], difficulty: 3,
        prompt: '先读每个单词，再按意群连读句子。',
        accessibility: '句子可按词高亮，并提供更大字号选项。', duration: 10, feedback: '读对了，再试试让声音更连贯。'
      },
      {
        id: 'a-7', type: '练习', title: '把单词和图片配对', content: 'mat · map · sun · sock',
        phonemes: ['/m/', '/æ/', '/s/'], dependencies: ['a-3', 'a-4'], difficulty: 3,
        prompt: '读出单词，然后把单词卡拖到对应图片。',
        accessibility: '支持键盘选择起点和终点，不使用拖拽也能完成。', duration: 12, feedback: '答对后播放该单词的分解音。'
      },
      {
        id: 'a-8', type: '句子', title: '迁移朗读：A man sat.', content: 'A man sat and had a nap.',
        phonemes: ['/m/', '/æ/', '/n/'], dependencies: ['a-6'], difficulty: 4,
        prompt: '观察 a 和 man 之间的联系，再完整朗读。',
        accessibility: '提供分句导航、朗读速度控制和高对比模式。', duration: 12, feedback: ''
      }
    ],
    versions: []
  };

  const v1Activities: CourseVersion['activities'] = [];
  const v1: CourseVersion = {
    id: 'v-1', label: '初稿', savedAt: '2026-09-21T10:00:00+08:00', note: '完成音素和基础拼读活动。',
    activities: v1Activities, sealed: true, revision: 1
  };
  const v2: CourseVersion = {
    id: 'v-2', label: '增加句子迁移', savedAt: '2026-09-24T15:30:00+08:00', note: '补充 A man sat and had a nap.',
    sealed: true, revision: 2,
    activities: [
      {
        id: 'a-1', type: '音素', title: '听音游戏：认识 /m/', content: '/m/', phonemes: ['/m/'], dependencies: [], difficulty: 1,
        prompt: '闭上嘴唇，轻轻发出 /m/。', accessibility: '口型示范和重复音频。', duration: 6, feedback: ''
      },
      {
        id: 'a-2', type: '音素', title: '首音识别：/s/ 与 /m/', content: '/s/ /m/', phonemes: ['/s/', '/m/'], dependencies: ['a-1'], difficulty: 1,
        prompt: '听到单词时拍手。', accessibility: '不同形状的视觉提示。', duration: 8, feedback: ''
      },
      {
        id: 'a-3', type: '单词', title: '拼读短词：sat', content: 's – a – t → sat', phonemes: ['/s/', '/æ/', '/t/'], dependencies: ['a-2'], difficulty: 2,
        prompt: '用手指依次点每个字母。', accessibility: '键盘逐字聚焦。', duration: 10, feedback: '形成完整电路。'
      },
      {
        id: 'a-6', type: '句子', title: '拼读句子：Mat sat.', content: 'Mat sat on the mat.', phonemes: ['/m/', '/æ/', '/s/', '/t/'], dependencies: ['a-3'], difficulty: 3,
        prompt: '先读每个单词，再按意群连读。', accessibility: '按词高亮。', duration: 10, feedback: '再试试更连贯。'
      }
    ]
  };
  base.versions = [v1, v2];
  return base;
}
