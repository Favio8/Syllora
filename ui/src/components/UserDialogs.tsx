'use client';

import { useState } from 'react';
import { UserRound, BookOpen, MessageSquareText, MousePointer2 } from 'lucide-react';
import Modal from './Modal';

export default function UserDialogs({ page, name, error, onClose, onSave }: { page: 'profile' | 'guide' | 'agreement'; name: string; error: string; onClose: () => void; onSave: (name: string) => Promise<boolean> }) {
  const [value, setValue] = useState(name);
  const [saving, setSaving] = useState(false);
  const title = { profile: '用户资料', guide: '用户指南', agreement: '协议说明' }[page];
  return <Modal title={title} error={error} onClose={onClose}>
    {page === 'profile' && <><div className="user-profile-heading"><span><UserRound size={26} /></span><div><h3>用户</h3><p>你的个人学习空间</p></div></div><form onSubmit={async e => { e.preventDefault(); setSaving(true); if (await onSave(value.trim())) onClose(); setSaving(false); }}><div className="form-field"><span id="profile-name-label">用户名称</span><input aria-labelledby="profile-name-label" autoFocus required maxLength={16} value={value} onChange={e => setValue(e.target.value)} /></div><p className="modal-description">名称用于学习对话中的称呼。当前为本地预览用户。</p><div className="modal-actions"><button type="button" className="button" onClick={onClose}>取消</button><button className="button primary" disabled={!value.trim() || saving}>{saving ? '正在保存…' : '保存资料'}</button></div></form></>}
    {page === 'guide' && <div className="user-guide"><section><BookOpen size={19} /><div><h3>从课程开始</h3><p>左侧图标可以打开工作台、课程、资料库和复习页。把光标移到图标上，可以看到名称。</p></div></section><section><MessageSquareText size={19} /><div><h3>对话学习</h3><p>在工作台右上角选择“对话学习”，向学习伙伴提问，或从计划中开始一次学习活动。</p></div></section><section><MousePointer2 size={19} /><div><h3>辅助阅读</h3><p>选择“辅助阅读”和一份资料，在正文中选中文字，点击“AI解释”或“AI搜索”。结果会显示在阅读助手中。</p></div></section><p className="modal-footnote">当前 AI 内容为本地演示。TXT、Markdown 正文可以本地阅读；PDF 正文解析待后续接入。</p></div>}
    {page === 'agreement' && <div className="agreement-copy"><h3>当前预览的数据说明</h3><p>课程、学习记录、个人偏好及添加的文本正文保存在当前浏览器。此版本不会将学习资料上传到服务器。</p><h3>AI 功能说明</h3><p>对话、解释和搜索结果均来自本地演示逻辑，未连接真实模型或互联网搜索。示例 PDF 正文是演示文字。</p><h3>账号与正式协议</h3><p>当前没有真实账号认证。退出登录会返回本地预览的进入页面，并保留学习数据。正式服务协议将在接入账号与后端服务后提供。</p></div>}
  </Modal>;
}
