export type View = 'home' | 'workspace' | 'courses' | 'materials' | 'review';
export type CourseIconId = 'math' | 'statistics' | 'code' | 'science' | 'physics' | 'language' | 'literature' | 'art' | 'music' | 'geography' | 'history' | 'notebook';
export type PanelTab = 'plan' | 'outline' | 'materials' | 'review';
export type EvidenceState = '待学习' | '待巩固' | '已验证';
export type LearningMode = 'chat' | 'reading';

export interface Task {
  id: string;
  title: string;
  kind: '学习' | '复习';
  minutes: number;
  completed: boolean;
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

/** UI 使用的应用服务契约。后续真实接口适配器实现相同方法。 */
export interface WorkspaceService {
  load(): Promise<WorkspaceData>;
  createCourse(name: string, icon: CourseIconId): Promise<WorkspaceData>;
  renameCourse(courseId: string, name: string): Promise<WorkspaceData>;
  setCourseArchived(courseId: string, archived: boolean): Promise<WorkspaceData>;
  deleteCourse(courseId: string): Promise<WorkspaceData>;
  toggleTask(courseId: string, taskId: string): Promise<WorkspaceData>;
  addMaterials(courseId: string, files: Array<Pick<Material, 'name' | 'size' | 'content'>>): Promise<WorkspaceData>;
  removeMaterial(courseId: string, materialId: string): Promise<WorkspaceData>;
  appendMessage(courseId: string, content: string): Promise<WorkspaceData>;
  reply(courseId: string, content: string): Promise<WorkspaceData>;
  savePreferences(preferences: Preferences): Promise<WorkspaceData>;
  saveApiConfig(config: ApiConfiguration): Promise<WorkspaceData>;
  recordActivity(courseId: string, kind: 'practice' | 'reading', minutes?: number): Promise<WorkspaceData>;
  reset(): Promise<WorkspaceData>;
}

export interface ReadingDocument {
  id: string;
  name: string;
  title: string;
  content: string;
  source: 'demo' | 'local' | 'unavailable';
}

export interface ReadingAssistance {
  mode: 'explain' | 'search';
  selection: string;
  explanation: string;
  matches: Array<{ title: string; excerpt: string }>;
}

export interface ReadingService {
  document(courseId: string, materialId: string): Promise<ReadingDocument>;
  assist(document: ReadingDocument, selection: string, mode: 'explain' | 'search'): Promise<ReadingAssistance>;
}
