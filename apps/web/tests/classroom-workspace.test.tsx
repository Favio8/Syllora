/**
 * 虚拟课堂 UI（主应用新增）。
 *
 * 只验证界面行为与请求形状（宿主侧生成链路由 packages/host/chat-service/tests/syllora-classroom.spec.ts
 * 用假云端覆盖）：未配置时的引导、输入卡片的校验与隐私提示、生成进度、以及三分支场景播放
 * （slide 画布 / quiz 作答 / interactive 沙箱 iframe，无 canvas 不白屏）。
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  api: {
    classroomCapabilities: vi.fn(),
    classroomList: vi.fn(),
    classroomGet: vi.fn(),
    classroomAudio: vi.fn(),
    classroomJob: vi.fn(),
    classroomProgress: vi.fn(),
    classroomAttachments: vi.fn(),
    classroomLive: vi.fn().mockResolvedValue({ classroomId: null, scenes: [], sceneTypes: {}, count: 0, generating: true }),
    classroomDelete: vi.fn(),
  },
  generate: vi.fn(),
  upload: vi.fn(),
  poll: vi.fn(),
}));

vi.mock('@/src/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('@/src/lib/api')>();
  return { ...actual, api: { ...actual.api, ...mocks.api } };
});
vi.mock('@/src/features/workbench/services', async importOriginal => {
  const actual = await importOriginal<typeof import('@/src/features/workbench/services')>();
  return { ...actual, classroomService: { generate: mocks.generate, uploadAttachment: mocks.upload, poll: mocks.poll } };
});
// 渲染器在 jsdom 里没有画布尺寸概念：这里只关心「slide 分支被调用」，用桩替换。
// 桩把 effects 透出到 data-effects，便于断言「聚光灯步只下发 spotlight」等口径。
vi.mock('@openmaic/renderer', () => ({
  SlideCanvas: ({ slide, effects }: { slide: unknown; effects?: unknown }) => (
    <div data-testid="slide-canvas" data-effects={effects === undefined ? undefined : JSON.stringify(effects)}>{JSON.stringify(slide)}</div>
  ),
}));

import ClassroomWorkspace from '../src/components/ClassroomWorkspace';

/** 打开列表里的第一份课堂：列表项现在还有「删除」按钮（aria-label 也含标题），必须按结构取打开键。 */
async function openFirstClassroom(): Promise<HTMLElement> {
  await waitFor(() => expect(document.querySelector('.cl-item-open')).not.toBeNull());
  return document.querySelector('.cl-item-open') as HTMLElement;
}

const CAPABILITIES = {
  configured: true,
  baseUrl: 'https://studyandchat.top',
  capabilities: { webSearch: false, imageGeneration: false, videoGeneration: false, tts: true },
  materials: { maxCount: 5, maxTotalBytes: 157286400, maxDocumentBytes: 52428800, formats: ['pdf', 'txt', 'markdown'] },
};

const COURSE = {
  id: '00000000-0000-4000-8000-000000000001',
  name: '合成课堂课程',
  materials: [{ id: '00000000-0000-4000-8000-0000000000aa', name: '讲义.txt', status: 'ready' }],
};

beforeEach(() => {
  for (const fn of Object.values(mocks.api)) fn.mockReset();
  mocks.generate.mockReset(); mocks.upload.mockReset(); mocks.poll.mockReset();
  mocks.api.classroomCapabilities.mockResolvedValue(CAPABILITIES);
  mocks.api.classroomList.mockResolvedValue({ classrooms: [] });
  mocks.api.classroomProgress.mockResolvedValue({ saved: true });
  mocks.upload.mockResolvedValue({ attachmentId: '00000000-0000-4000-8000-0000000000cc', name: '补充.md', bytes: 10, mime: 'text/markdown', count: 1 });
});
afterEach(() => { vi.clearAllMocks(); });

describe('虚拟课堂：未配置与无课程', () => {
  it('没有课程时只给引导，不发课堂请求', async () => {
    render(<ClassroomWorkspace course={null} />);
    expect(await screen.findByText('先打开一门课程')).toBeInTheDocument();
    expect(mocks.api.classroomCapabilities).toHaveBeenCalledTimes(1);
    expect(mocks.api.classroomList).not.toHaveBeenCalled();
  });

  it('未配置云端连接时禁用「进入课堂」并给出设置入口', async () => {
    mocks.api.classroomCapabilities.mockResolvedValue({ configured: false, baseUrl: null, capabilities: {}, materials: CAPABILITIES.materials });
    const onOpenSettings = vi.fn();
    render(<ClassroomWorkspace course={COURSE} onOpenSettings={onOpenSettings} />);
    expect(await screen.findByText('未配置云端连接')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('课堂需求'), { target: { value: '用勾股定理讲一节课' } });
    expect(screen.getByRole('button', { name: /进入课堂/ })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /去设置/ }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });
});

describe('虚拟课堂：输入卡片与生成', () => {
  it('需求太短不发请求；条件满足时带上角色、资料与隐私明示发起生成', async () => {
    mocks.generate.mockResolvedValue({ jobId: 'job-1', status: 'queued', step: 'queued' });
    mocks.poll.mockImplementation(async (_courseId: string, _jobId: string, options: { onProgress?: (job: unknown) => void }) => {
      // 真实轮询是 5 秒节奏：这里给一拍，让进度页有机会被断言。
      await new Promise(resolve => setTimeout(resolve, 30));
      options.onProgress?.({ jobId: 'job-1', courseId: COURSE.id, status: 'running', step: 'generating_scenes', progress: 40, scenesGenerated: 2, totalScenes: 8, done: false, updatedAt: Date.now() });
      await new Promise(resolve => setTimeout(resolve, 30));
      return { jobId: 'job-1', courseId: COURSE.id, status: 'succeeded', step: 'completed', progress: 100, classroomId: 'stage-ABC', totalScenes: 3, done: true, updatedAt: Date.now() };
    });
    mocks.api.classroomGet.mockResolvedValue({
      meta: { classroomId: 'stage-ABC', title: '勾股定理课堂', requirement: 'r', materialIds: [], sourceCount: 2, sceneCount: 1, sceneTypes: { slide: 1 }, generatedAt: 1, fetchedAt: 1, cloudBase: 'https://studyandchat.top' },
      stage: { name: '勾股定理课堂' },
      scenes: [{ id: 'scene_1', type: 'slide', order: 1, title: '导入', content: { type: 'slide', canvas: { viewportSize: 1000, elements: [] } }, actions: [{ type: 'speech', text: '大家好，今天讲勾股定理。' }] }],
      progress: { sceneId: null, answers: {}, updatedAt: 0 },
    });
    render(<ClassroomWorkspace course={COURSE} />);
    expect(await screen.findByText(/已连接 https:\/\/studyandchat\.top/)).toBeInTheDocument();
    // 角色一律默认：不再暴露选择（没有教师/学生按钮与音色下拉）。
    expect(screen.queryByLabelText('教师音色')).toBeNull();
    expect(screen.queryByRole('button', { name: /好奇宝宝/ })).toBeNull();

    const enter = screen.getByRole('button', { name: /进入课堂/ });
    expect(enter).toBeDisabled();
    fireEvent.change(screen.getByLabelText('课堂需求'), { target: { value: '用勾股定理讲一节课' } });
    expect(enter).toBeEnabled();
    // 选一份课程资料。
    fireEvent.click(screen.getByRole('button', { name: '讲义.txt' }));
    fireEvent.click(enter);

    await waitFor(() => expect(mocks.generate).toHaveBeenCalledTimes(1));
    const payload = mocks.generate.mock.calls[0]![0] as { requirement: string; materialIds: string[]; roles: Array<{ name: string; kind: string; voice?: string }> };
    expect(payload.requirement).toContain('用勾股定理讲一节课');
    expect(payload.requirement).toContain('我的昵称');
    expect(payload.materialIds).toEqual(['00000000-0000-4000-8000-0000000000aa']);
    // 角色全部默认：主讲教师 + 助教，且不带任何自定义音色。
    expect(payload.roles.map(role => role.name)).toEqual(['小艾老师', '助教']);
    expect(payload.roles.every(role => role.voice === undefined)).toBe(true);

    // 进度页：步骤轨迹 + 场景计数；成功后自动进入播放器。
    const progress = await screen.findByLabelText('生成进度');
    // 步骤轨迹推进到「生成场景」，并带上云端上报的场景计数（轮询是异步的，等它落地）。
    await waitFor(() => {
      expect(progress.textContent).toContain('生成场景');
      expect(progress.textContent).toContain('已生成场景 2/8');
    });
    await waitFor(() => expect(screen.getByLabelText('课堂播放器')).toBeInTheDocument());
    expect(mocks.api.classroomList).toHaveBeenCalledTimes(2);
  });

  it('附件走裸字节上传，成功后显示为可移除的胶囊', async () => {
    render(<ClassroomWorkspace course={COURSE} />);
    await screen.findByText(/已连接/);
    const file = new File(['# 补充'], '补充.md', { type: 'text/markdown' });
    fireEvent.change(screen.getByLabelText('添加附件'), { target: { files: [file] } });
    await waitFor(() => expect(mocks.upload).toHaveBeenCalledTimes(1));
    expect(mocks.upload.mock.calls[0]![1]).toBe(file);
    expect(await screen.findByRole('button', { name: /补充\.md/ })).toBeInTheDocument();
  });

  it('生成失败时给出云端错误并保留返回入口', async () => {
    mocks.generate.mockResolvedValue({ jobId: 'job-2', status: 'queued', step: 'queued' });
    mocks.poll.mockImplementation(async (_courseId: string, _jobId: string, options: { onProgress?: (job: unknown) => void }) => {
      await new Promise(resolve => setTimeout(resolve, 20));
      options.onProgress?.({ jobId: 'job-2', courseId: COURSE.id, status: 'running', step: 'generating_outlines', done: false, updatedAt: Date.now() });
      return { jobId: 'job-2', courseId: COURSE.id, status: 'failed', step: 'failed', error: '云端拒绝了访问口令，请在设置中检查虚拟课堂的连接配置。', done: true, updatedAt: Date.now() };
    });
    render(<ClassroomWorkspace course={COURSE} />);
    fireEvent.change(await screen.findByLabelText('课堂需求'), { target: { value: '生成本章课堂' } });
    fireEvent.click(screen.getByRole('button', { name: /进入课堂/ }));
    expect(await screen.findByText(/云端拒绝了访问口令/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '返回课堂列表' })).toBeInTheDocument();
  });
});

describe('虚拟课堂：播放器三分支与进度', () => {
  const document = {
    meta: { classroomId: 'stage-ABC', title: '勾股定理课堂', requirement: 'r', materialIds: [], sourceCount: 2, sceneCount: 3, sceneTypes: { slide: 1, quiz: 1, interactive: 1 }, generatedAt: 1, fetchedAt: 1, cloudBase: 'https://studyandchat.top' },
    stage: { name: '勾股定理课堂' },
    scenes: [
      { id: 'scene_1', type: 'slide', order: 1, title: '导入', content: { type: 'slide', canvas: { viewportSize: 1000, elements: [] } }, actions: [
        { type: 'speech', text: '大家好，今天讲勾股定理。' },
        { id: 'action_sp', type: 'spotlight', elementId: 'text_abc' },
      ] },
      // 选项形状取云端/官方 DSL 口径：value 是代号（"A"），label 是显示文本；answer 存代号。
      { id: 'scene_2', type: 'quiz', order: 2, title: '小测', content: { type: 'quiz', questions: [{ id: 'q1', type: 'single', question: '3-4-5 是直角三角形吗？', options: [{ label: '是', value: 'A' }, { label: '否', value: 'B' }], answer: ['A'], hasAnswer: true, analysis: '满足平方和。' }] } },
      { id: 'scene_3', type: 'interactive', order: 3, title: '互动演示', content: { type: 'interactive', html: '<html><body>demo</body></html>', widgetType: 'demo' } },
    ],
    progress: { sceneId: 'scene_2', answers: { q1: ['B'] }, updatedAt: 1 },
  };

  it('从上次的场景继续，slide 渲染画布、quiz 可作答与查看答案、interactive 走沙箱 iframe', async () => {
    mocks.api.classroomList.mockResolvedValue({ classrooms: [document.meta] });
    mocks.api.classroomGet.mockResolvedValue(document);
    render(<ClassroomWorkspace course={COURSE} />);
    fireEvent.click(await openFirstClassroom());
    expect(await screen.findByLabelText('课堂播放器')).toBeInTheDocument();
    // 上次停在 scene_2（quiz），作答保留。
    expect(screen.getByText(/2 \/ 3/)).toBeInTheDocument();
    const picked = screen.getByRole('button', { name: /B 否/ });
    expect(picked.getAttribute('aria-pressed')).toBe('true');
    // 改选 A → 本机进度保存（400ms 去抖后）。
    fireEvent.click(screen.getByRole('button', { name: /A 是/ }));
    await waitFor(() => expect(mocks.api.classroomProgress).toHaveBeenCalled(), { timeout: 2000 });
    expect(mocks.api.classroomProgress.mock.calls[0]!.slice(0, 4)).toEqual([COURSE.id, 'stage-ABC', 'scene_2', { q1: ['A'] }]);
    // 查看答案：显示对错与解析。
    fireEvent.click(screen.getByRole('button', { name: '查看答案' }));
    expect(await screen.findByText(/回答正确 · 满足平方和/)).toBeInTheDocument();

    // 上一页：slide 分支（渲染器桩被调用）。
    fireEvent.click(screen.getByRole('button', { name: /上一页/ }));
    expect(screen.getByTestId('slide-canvas')).toBeInTheDocument();
    expect(screen.getByText('大家好，今天讲勾股定理。')).toBeInTheDocument();
    // 步进到聚光灯动作：只下发 spotlight（官网口径），不再叠加自创的粉色 highlights。
    expect(screen.getByTestId('slide-canvas').getAttribute('data-effects')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '下一步' }));
    await waitFor(() => expect(screen.getByTestId('slide-canvas').getAttribute('data-effects')).toContain('"spotlight"'));
    const slideEffects = screen.getByTestId('slide-canvas').getAttribute('data-effects') ?? '';
    expect(slideEffects).toContain('text_abc');
    expect(slideEffects).not.toContain('highlights');
    // 翻到 interactive：sandbox iframe，不给它授权访问本机。
    fireEvent.click(screen.getByRole('button', { name: /下一页/ }));
    fireEvent.click(screen.getByRole('button', { name: /下一页/ }));
    const frame = screen.getByTitle('互动演示') as HTMLIFrameElement;
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts allow-forms allow-popups');
    expect(frame.getAttribute('src')).toContain('data:text/html');
  });

  it('测验按代号判分：选对显示「回答正确」；简答题可作答且只给参考要点', async () => {
    const quizDoc = {
      ...document,
      meta: { ...document.meta, sceneCount: 1, sceneTypes: { quiz: 1 } },
      scenes: [
        { id: 'scene_q', type: 'quiz', order: 1, title: '练习', content: { type: 'quiz', questions: [
          { id: 'q1', type: 'single', question: 'AB 与 BA 的规模？', options: [{ label: 'AB 是 2×2、BA 是 3×3', value: 'A' }, { label: '两者都是 2×2', value: 'B' }], answer: ['A'], hasAnswer: true, analysis: '乘法要求列数等于行数。' },
          { id: 'q2', type: 'short_answer', question: '说明行列式每一步的变化。', hasAnswer: false, analysis: '交换变号、转置不变、数乘提倍。', commentPrompt: '评分要点：三步各占三成以上。' },
        ] } },
      ],
      progress: { sceneId: 'scene_q', answers: {}, updatedAt: 1 },
    };
    mocks.api.classroomList.mockResolvedValue({ classrooms: [quizDoc.meta] });
    mocks.api.classroomGet.mockResolvedValue(quizDoc);
    render(<ClassroomWorkspace course={COURSE} />);
    fireEvent.click(await openFirstClassroom());
    // 单选用 value（代号）判分：旧实现拿 label（整段文本）比 answer 里的 "A"，恒判「回答错误」。
    fireEvent.click(await screen.findByRole('button', { name: /A AB 是 2×2/ }));
    fireEvent.click(screen.getAllByRole('button', { name: '查看答案' })[0]!);
    expect(await screen.findByText(/回答正确 · 乘法要求列数等于行数/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /A AB 是 2×2/ }).className).toContain('is-answer');
    // 简答题：无标准答案（hasAnswer=false）——输入框可作答；查看答案给参考要点，不判对错。
    const box = screen.getByLabelText('第 2 题作答') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: '先交换两行变号……' } });
    expect(box.value).toContain('交换两行');
    fireEvent.click(screen.getAllByRole('button', { name: '查看答案' })[1]!);
    expect(await screen.findByText(/参考要点：交换变号/)).toBeInTheDocument();
    expect(screen.queryByText(/回答错误/)).toBeNull();
  });

  it('场景列表标注类型与数量，rail 可跳转且当前场景有 aria-current', async () => {
    mocks.api.classroomList.mockResolvedValue({ classrooms: [document.meta] });
    mocks.api.classroomGet.mockResolvedValue(document);
    render(<ClassroomWorkspace course={COURSE} />);
    fireEvent.click(await openFirstClassroom());
    const rail = await screen.findByLabelText('场景列表');
    const buttons = within(rail).getAllByRole('button');
    expect(buttons).toHaveLength(3);
    expect(within(rail).getByRole('button', { name: /2 小测/ }).getAttribute('aria-current')).toBe('true');
    fireEvent.click(within(rail).getByRole('button', { name: /3 互动演示/ }));
    expect(screen.getByTitle('互动演示')).toBeInTheDocument();
    // 场景类型统计来自 meta（丢弃数量不静默：这里按类型逐项展示）。
    expect(screen.getByText(/幻灯片×1 · 测验×1 · 互动演示×1/)).toBeInTheDocument();
  });

  it('没有可播放场景时明确提示而不是白屏', async () => {
    mocks.api.classroomList.mockResolvedValue({ classrooms: [document.meta] });
    mocks.api.classroomGet.mockResolvedValue({ ...document, scenes: [], meta: { ...document.meta, sceneCount: 0, sceneTypes: {} } });
    render(<ClassroomWorkspace course={COURSE} />);
    fireEvent.click(await openFirstClassroom());
    expect(await screen.findByText(/这份课堂没有可播放的场景/)).toBeInTheDocument();
  });
});

describe('虚拟课堂：删除与生成中进入', () => {
  it('两步确认后删除课堂，并刷新列表', async () => {
    const meta = {
      classroomId: 'stage-ABC', title: '勾股定理课堂', requirement: 'r', materialIds: [], sourceCount: 1, sceneCount: 1,
      sceneTypes: { slide: 1 }, generatedAt: 1, fetchedAt: 1, cloudBase: 'https://studyandchat.top',
    };
    mocks.api.classroomList.mockResolvedValue({ classrooms: [meta] });
    mocks.api.classroomDelete.mockResolvedValue({ deleted: true, cloud: 'deleted' });
    render(<ClassroomWorkspace course={COURSE} />);
    const del = await screen.findByRole('button', { name: '删除课堂「勾股定理课堂」' });
    fireEvent.click(del);
    // 第一次只是进入确认态：不发请求。
    expect(mocks.api.classroomDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '确认删除课堂「勾股定理课堂」' }));
    await waitFor(() => expect(mocks.api.classroomDelete).toHaveBeenCalledWith(COURSE.id, 'stage-ABC', true));
    await waitFor(() => expect(mocks.api.classroomList).toHaveBeenCalledTimes(2));
  });

  it('生成中已产出页面时可以先进入课堂（边学边生成）', async () => {
    mocks.generate.mockResolvedValue({ jobId: 'job-live', status: 'queued', step: 'queued' });
    // 作业一直「进行中」，同时 classroomLive 报已经生成 2 页。
    mocks.poll.mockImplementation(async () => await new Promise(() => {}));
    mocks.api.classroomLive.mockResolvedValue({
      classroomId: 'stage-LIVE', generating: true, count: 2, sceneTypes: { slide: 2 },
      scenes: [
        { id: 'live-1', type: 'slide', order: 1, title: '第一页', content: { type: 'slide', canvas: { viewportSize: 1000, elements: [] } }, actions: [{ type: 'speech', text: '先讲第一页。' }, { type: 'spotlight', elementId: 'text_1' }, { type: 'speech', text: '再强调这一点。' }] },
        { id: 'live-2', type: 'slide', order: 2, title: '第二页', content: { type: 'slide', canvas: { viewportSize: 1000, elements: [] } }, actions: [] },
      ],
    });
    render(<ClassroomWorkspace course={COURSE} />);
    fireEvent.change(await screen.findByLabelText('课堂需求'), { target: { value: '生成本章课堂' } });
    fireEvent.click(screen.getByRole('button', { name: /进入课堂/ }));
    // 轮询到 classroomLive 后出现「先进入课堂」。
    const enter = await screen.findByRole('button', { name: /先进入课堂/ }, { timeout: 3000 });
    fireEvent.click(enter);
    expect(await screen.findByLabelText('课堂播放器')).toBeInTheDocument();
    expect(screen.getByRole('status').textContent).toContain('生成中');
    expect(screen.getByText(/已取回 2 页/)).toBeInTheDocument();
    // 动作播放：台词与步进控制都在。
    expect(screen.getByText('先讲第一页。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /播放讲解/ })).toBeInTheDocument();
  });
});

describe('虚拟课堂：讲解音频', () => {
  const meta = { classroomId: 'stage-audio', title: '声音验收', sceneCount: 2, sceneTypes: { slide: 2 }, fetchedAt: 1 };
  const scenes = [
    { id: 's1', type: 'slide', title: '第一页', actions: [{ type: 'speech', text: '第一句', audioId: 'ast_first' }, { type: 'speech', text: '最后一句', audioId: 'ast_last' }] },
    { id: 's2', type: 'slide', title: '第二页', actions: [{ type: 'speech', text: '下一页', audioId: 'ast_next' }] },
  ];
  let play: ReturnType<typeof vi.spyOn>, pause: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, writable: true, value: vi.fn(() => 'blob:test-audio') });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, writable: true, value: vi.fn() });
    mocks.api.classroomList.mockResolvedValue({ classrooms: [meta] });
    mocks.api.classroomGet.mockResolvedValue({ meta, scenes, progress: { sceneId: null, answers: {} } });
    mocks.api.classroomAudio.mockResolvedValue({ mime: 'audio/wav', base64: 'UklGRg==' });
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });
  async function open() {
    const view = render(<ClassroomWorkspace course={COURSE} />);
    fireEvent.click(await openFirstClassroom());
    const audio = await screen.findByLabelText('课堂讲解音频') as HTMLAudioElement;
    return { ...view, audio };
  }
  it('waits for audio ended instead of a four-second timer, plays the final speech, and replays', async () => {
    const { audio } = await open();
    fireEvent.click(screen.getByRole('button', { name: '播放讲解' }));
    await waitFor(() => expect(play).toHaveBeenCalled());
    expect(mocks.api.classroomAudio).toHaveBeenCalledWith({ courseId: COURSE.id, classroomId: 'stage-audio', sceneId: 's1', audioId: 'ast_first' });
    vi.useFakeTimers();
    await act(async () => { vi.advanceTimersByTime(8000); });
    expect(screen.getByText('第 1 / 2 步')).toBeInTheDocument();
    vi.useRealTimers();
    fireEvent.ended(audio);
    await waitFor(() => expect(mocks.api.classroomAudio).toHaveBeenLastCalledWith(expect.objectContaining({ audioId: 'ast_last' })));
    expect(screen.getByRole('button', { name: '暂停' })).toBeInTheDocument();
    fireEvent.ended(audio);
    fireEvent.click(await screen.findByRole('button', { name: '重播' }));
    await waitFor(() => expect(mocks.api.classroomAudio).toHaveBeenLastCalledWith(expect.objectContaining({ audioId: 'ast_first' })));
  });
  it('pauses, resumes at the same position, and stops on page change and unmount', async () => {
    const { audio, unmount } = await open();
    fireEvent.click(screen.getByRole('button', { name: '播放讲解' }));
    await waitFor(() => expect(play).toHaveBeenCalled());
    audio.currentTime = 2;
    fireEvent.click(screen.getByRole('button', { name: '暂停' }));
    expect(pause).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '播放讲解' }));
    expect(audio.currentTime).toBe(2);
    expect(mocks.api.classroomAudio).toHaveBeenCalledTimes(1);
    pause.mockClear();
    fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    expect(pause).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '播放讲解' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '播放讲解' }));
    await waitFor(() => expect(mocks.api.classroomAudio).toHaveBeenLastCalledWith(expect.objectContaining({ audioId: 'ast_next' })));
    pause.mockClear(); unmount();
    expect(pause).toHaveBeenCalled();
    expect(URL.revokeObjectURL).toHaveBeenCalled();
  });
  it('does not play a late audio response after navigating away', async () => {
    let resolve!: (value: { mime: string; base64: string }) => void;
    mocks.api.classroomAudio.mockReturnValue(new Promise(done => { resolve = done; }));
    await open();
    fireEvent.click(screen.getByRole('button', { name: '播放讲解' }));
    fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    await act(async () => { resolve({ mime: 'audio/wav', base64: 'UklGRg==' }); });
    expect(play).not.toHaveBeenCalled();
  });
  it('keeps the current step and gives a retry message on audio failure', async () => {
    mocks.api.classroomAudio.mockRejectedValue(new Error('讲解音频读取失败，请检查云端连接后重试。'));
    await open(); fireEvent.click(screen.getByRole('button', { name: '播放讲解' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('音频读取失败');
    expect(screen.getByText('第 1 / 2 步')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '播放讲解' })).toBeInTheDocument();
  });
  it('allows retry after autoplay is blocked without fetching the audio again', async () => {
    play.mockRejectedValueOnce(new DOMException('blocked', 'NotAllowedError'));
    await open(); fireEvent.click(screen.getByRole('button', { name: '播放讲解' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('再次点击');
    fireEvent.click(screen.getByRole('button', { name: '播放讲解' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(mocks.api.classroomAudio).toHaveBeenCalledTimes(1);
  });
});
