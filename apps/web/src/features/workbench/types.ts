export type View = 'home' | 'workspace' | 'courses' | 'materials' | 'review';
export type CourseIconId = 'math' | 'statistics' | 'code' | 'science' | 'physics' | 'language' | 'literature' | 'art' | 'music' | 'geography' | 'history' | 'notebook';
export type PanelTab = 'plan' | 'outline' | 'materials' | 'review';
export type EvidenceState = '未评估' | '待验证' | '待加强' | '初步掌握' | '复测通过';
export type LearningMode = 'chat' | 'reading';

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
}

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
}

export interface Course {
  revision?:string;
  id: string;
  name: string;
  subtitle: string;
  symbol: string;
  icon?: CourseIconId;
  archived?: boolean;
  color: 'blue' | 'green' | 'orange';
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

export interface ReadingDocument {
  id: string;
  courseId:string;revision:string|null;sources:Array<{id:string;text:string;anchor:string;kind?:string}>;previewUrl?:string|null;
  name: string;
  title: string;
  content: string;
  source: 'published' | 'unavailable';
}

export interface ReadingAssistance {
  mode: 'explain' | 'search';
  selection: string;
  explanation: string;
  matches: Array<{ title: string; excerpt: string;sourceId:string;materialId?:string }>;
}

export interface ReadingService {
  document(courseId: string, materialId: string): Promise<ReadingDocument>;
  assist(document: ReadingDocument, selection: string, mode: 'explain' | 'search', signal?:AbortSignal): Promise<ReadingAssistance>;
}
