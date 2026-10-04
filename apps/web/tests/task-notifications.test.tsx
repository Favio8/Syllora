import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import EvidenceSources from '../src/components/EvidenceSources';
import TasksPage from '../src/components/chat/TasksPage';
import NotificationCapsule from '../src/components/chat/NotificationCapsule';
afterEach(cleanup);
describe('任务通知与依据入口', () => {
  it('deduplicates source IDs and provides one entry for differently labelled citations', () => {
    const onOpen = vi.fn();
    render(<EvidenceSources sourceIds={['a', 'a', 'b']} label={id => `讲义 ${id}`} onOpen={onOpen} />);
    expect(screen.getByText('查看依据（2 条）')).toBeInTheDocument();
    fireEvent.click(screen.getByText('查看依据（2 条）'));
    fireEvent.click(screen.getByRole('button', { name: '2. 讲义 b' }));
    expect(onOpen).toHaveBeenCalledWith('b');
  });
  it('hides dismissed notifications from the task list and failed badge but keeps running tasks', () => {
    const jobs = [
      { id: 'a', courseId: 'c', state: 'failed', dismissedAt: 1, message: '旧失败' },
      { id: 'b', courseId: 'c', state: 'succeeded', message: '完成' },
      { id: 'c', courseId: 'c', state: 'running', message: '进行中' },
    ] as never;
    const onDismiss = vi.fn();
    render(<><TasksPage jobs={jobs} courseName={() => '测试课程'} onCancel={() => {}} onDismiss={onDismiss} /><NotificationCapsule jobs={jobs} onOpen={() => {}} /></>);
    expect(screen.queryByText('旧失败')).toBeNull();
    expect(screen.getAllByRole('button', { name: '删除测试课程的任务通知' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '删除测试课程的任务通知' }));
    expect(onDismiss).toHaveBeenCalledWith('b');
    expect(document.querySelector('.notification-capsule')).not.toHaveClass('is-failed');
  });
});
