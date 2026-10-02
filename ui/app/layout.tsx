import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Syllora · 学习工作台',
  description: 'Syllora 独立前端界面，使用本地演示数据。',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
