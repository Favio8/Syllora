import type { WorkspaceService } from '@/types';
import { mockService } from './mock';
import { mockReadingService } from './reading';

/** 接后端时在这里切换适配器。所有组件只依赖 WorkspaceService 契约。 */
export const workspaceService: WorkspaceService = mockService;
export const readingService = mockReadingService;
