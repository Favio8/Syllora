export type View = 'home' | 'workspace' | 'courses' | 'materials' | 'review' | 'tasks' | 'practice' | 'lecture' | 'outline-manage' | 'plan-manage';
export type CourseIconId = 'math' | 'statistics' | 'code' | 'science' | 'physics' | 'language' | 'literature' | 'art' | 'music' | 'geography' | 'history' | 'notebook';
export type PanelTab = 'plan' | 'outline' | 'materials' | 'review';
export type EvidenceState = '未评估' | '待验证' | '待加强' | '初步掌握' | '复测通过';
export type LearningMode = 'chat' | 'reading' | 'classroom';

export interface Task {
  id: string;
  title: string;
  kind: '学习' | '复习';
  minutes: number;
  completed: boolean;
  date?:string;status?:string;available?:boolean;
}

export interface KnowledgePoint {
  id: string;
  chapter: string;
  title: string;
  state: EvidenceState;
}

export interface Material {
  id: string;
  name: string;
  size: number;
  addedAt: string;
  content?: string;
  /** 解析引擎：docmind=云端解析（默认）；local=本地回退。旧资料没有这个字段。 */
  engine?: 'docmind' | 'local';
}

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  sourceIds: string[];
  /** 阅读助手回答上下文（与后端 domain.ReadingContext 对齐）。 */
  reading?: { materialId: string; revision: string; selection: string; sourceIds: string[]; mode: 'explain' | 'search' };
}

export interface Course {
  revision?:string;
  id: string;
  name: string;
  subtitle: string;
  symbol: string;
  icon?: CourseIconId;
  archived?: boolean;
  color: 'blue' | 'green' | 'orange' | 'purple' | 'rose' | 'slate';
  chapter: string;
  tasks: Task[];
  points: KnowledgePoint[];
  materials: Material[];
  messages: Message[];
}

export interface Preferences {
  name: string;
  dailyMinutes: number;
  compact: boolean;
  theme?: 'light' | 'dark';
}

export interface WorkspaceData {
  version: 1;
  revision?: number;
  preferencesVersion?: number;
  apiConfigVersion?: number;
  courses: Course[];
  preferences: Preferences;
  activity?: LearningRecord[];
  apiConfig?: ApiConfiguration;
}

export interface LearningRecord {
  id: string;
  date: string;
  courseId: string;
  kind: 'task' | 'practice' | 'chat' | 'reading';
  minutes: number;
  taskId?: string;
  demo?: boolean;
}

export interface ApiConfiguration {
  baseUrl: string;
  model: string;
  format: 'compatible' | 'native';
  temperature: number;
}

/** 解析产物（DocMind markdown 的章节大纲与本地化图片；正文与引证仍以 sources 为准）。 */
export interface MaterialDocumentInfo {
  engine: 'docmind' | 'local';
  hasMarkdown: boolean;
  images: number;
  outline: Array<{ title: string; level: number; anchor: string; page: number | null }>;
}

export interface ReadingDocument {
  id: string;
  courseId:string;revision:string|null;sources:Array<{id:string;materialId?:string;text:string;anchor:string;kind?:string;section?:string}>;previewUrl?:string|null;
  name: string;
  title: string;
  content: string;
  source: 'published' | 'unavailable';
  document?: MaterialDocumentInfo | null;
  engine?: 'docmind' | 'local' | null;
  /** 阅读标记：大纲锚点 → 自评状态（不计学习证据）。 */
  marks?: Record<string, 'mastered' | 'learning' | 'weak'>;
}

export interface ReadingAssistance {
  mode: 'explain' | 'search';
  selection: string;
  explanation: string;
  matches: Array<{ title: string; excerpt: string;sourceId:string;materialId?:string }>;
}

export interface ReadingService {
  document(courseId: string, materialId: string): Promise<ReadingDocument>;
  assist(document: ReadingDocument, selection: string, mode: 'explain' | 'search', signal?:AbortSignal, options?: { sourceIds?:string[]; onWaiting?: (message: string) => void }): Promise<ReadingAssistance>;
  /** 需求六：选中文字 + 自定义提示词的流式直答（不参考知识库、不标注来源）。 */
  ask(document: ReadingDocument | null, selection: string, prompt: string, signal?:AbortSignal, options?: { onDelta?: (delta: string) => void }): Promise<{ text: string }>;
}
