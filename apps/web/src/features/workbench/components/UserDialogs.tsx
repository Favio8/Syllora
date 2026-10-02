'use client';

import { useState } from 'react';
import { UserRound, BookOpen, MessageSquareText, MousePointer2 } from 'lucide-react';
import Modal from './Modal';

export default function UserDialogs({ page, name, error, onClose, onSave }: { page: 'profile' | 'guide' | 'agreement'; name: string; error: string; onClose: () => void; onSave: (name: string) => Promise<boolean> }) {
  const [value, setValue] = useState(name);
  const [saving, setSaving] = useState(false);
  const title = { profile: '用户资料', guide: '用户指南', agreement: '协议说明' }[page];
  return <Modal title={title} error={error} onClose={onClose}>
    {page === 'profile' && <><div className="user-profile-heading"><span><UserRound size={26} /></span><div><h3>用户</h3><p>你的个人学习空间</p></div></div><form onSubmit={async e => { e.preventDefault(); setSaving(true); if (await onSave(value.trim())) onClose(); setSaving(false); }}><div className="form-field"><span id="profile-name-label">用户名称</span><input aria-labelledby="profile-name-label" autoFocus required maxLength={16} value={value} onChange={e => setValue(e.target.value)} /></div><p className="modal-description">名称用于学习对话中的称呼。称呼和外观在本机应用中保存。</p><div className="modal-actions"><button type="button" className="button" onClick={onClose}>取消</button><button className="button primary" disabled={!value.trim() || saving}>{saving ? '正在保存…' : '保存资料'}</button></div></form></>}
    {page === 'guide' && <div className="user-guide"><section><BookOpen size={19} /><div><h3>从课程开始</h3><p>左侧图标可以打开工作台、课程、资料库和复习页。把光标移到图标上，可以看到名称。</p></div></section><section><MessageSquareText size={19} /><div><h3>对话学习</h3><p>在工作台右上角选择“对话学习”，向学习伙伴提问，或从计划中开始一次学习活动。</p></div></section><section><MousePointer2 size={19} /><div><h3>辅助阅读</h3><p>选择“辅助阅读”和一份资料，在正文中选中文字，点击“AI解释”或“AI搜索”。结果会显示在阅读助手中。</p></div></section><p className="modal-footnote">打开课程文件夹并初始化资料后，可使用模型问答、引用、练习和复习。</p></div>}
    {page === 'agreement' && <div className="agreement-copy"><h3>本机数据说明</h3><p>课程与学习记录保存在本机课程文件夹，个人偏好由本机服务保存。资料原件不会因删除应用记录而被删除。</p><h3>AI 功能说明</h3><p>获得外部调用授权后，相关资料片段会发送给你配置的模型供应商。AI 搜索只检索当前课程资料；供应商费用与数据政策由你管理。</p><h3>访问与会话</h3><p>应用供本机单用户使用。结束当前会话会关闭当前课程的学习会话并保留学习记录；下次开始任务时建立新会话。桌面宿主使用本机访问令牌保护接口。</p></div>}
  </Modal>;
}
