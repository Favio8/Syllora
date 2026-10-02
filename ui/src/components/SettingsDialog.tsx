'use client';

import { useEffect, useState } from 'react';
import { Database, Eye, EyeOff, Monitor, SlidersHorizontal, UserRound, Check, KeyRound, Sun, Moon } from 'lucide-react';
import Modal from './Modal';
import Dropdown from './Dropdown';
import type { ApiConfiguration, Preferences, WorkspaceData } from '@/types';

export default function SettingsDialog({ data, error, onClose, onReset, onPreferences, onApi }: { data: WorkspaceData; error: string; onClose: () => void; onReset: () => void; onPreferences: (preferences: Preferences) => Promise<boolean>; onApi: (config: ApiConfiguration) => Promise<boolean> }) {
  const [page, setPage] = useState('preferences');
  const [preferences, setPreferences] = useState<Preferences>({ ...data.preferences, theme: data.preferences.theme ?? 'light', compact: false });
  const [config, setConfig] = useState<ApiConfiguration>(data.apiConfig ?? { baseUrl: '', model: '', format: 'compatible', temperature: 0.7 });
  const [key, setKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState('');
  useEffect(() => { try { setKey(sessionStorage.getItem('syllora-ui.api-key') ?? ''); } catch {} }, []);
  const pages = [{ id: 'preferences', label: '用户偏好', icon: UserRound }, { id: 'model', label: '模型配置', icon: SlidersHorizontal }, { id: 'display', label: '显示与交互', icon: Monitor }, { id: 'data', label: '数据管理', icon: Database }];
  function validate() {
    try { const address = new URL(config.baseUrl); if (!['https:', 'http:'].includes(address.protocol) || !config.model.trim()) throw new Error(); setFeedback('配置格式有效。真实连接将在接入后端后验证。'); return true; }
    catch { setFeedback('请填写有效的 HTTP / HTTPS 接口地址和模型名称。'); return false; }
  }
  async function save() {
    if (page === 'model' && !validate()) return;
    setSaving(true); setFeedback('');
    try {
      const success = page === 'model' ? await onApi(config) : await onPreferences(preferences);
      if (success) {
        if (page === 'model') {
          try { if (key.trim()) sessionStorage.setItem('syllora-ui.api-key', key.trim()); else sessionStorage.removeItem('syllora-ui.api-key'); }
          catch { setFeedback('接口配置已保存；浏览器未允许保存密钥，密钥仅保留在当前设置中。'); return; }
        }
        setFeedback(page === 'model' ? '配置已保存。当前对话与阅读仍使用演示服务。' : page === 'display' ? '外观已更新。' : '学习偏好已保存。');
      }
    } finally { setSaving(false); }
  }
  return <Modal title="设置" className="settings-modal" error={error} onClose={onClose}><div className="settings-layout"><nav className="settings-navigation" aria-label="设置分类"><span>个人学习空间</span>{pages.map(({ id, label, icon: Icon }) => <button key={id} className={page === id ? 'active' : ''} aria-current={page === id ? 'page' : undefined} onClick={() => { setPage(id); setFeedback(''); }}><Icon size={17} />{label}</button>)}<small>Syllora UI<br />让学习更有自己的节奏</small></nav><form className="settings-page" onSubmit={e => { e.preventDefault(); void save(); }}><div className="settings-page-scroll" key={page}><header className="settings-page-heading"><span className="eyebrow">{page === 'model' ? '连接与模型' : page === 'data' ? '本地工作空间' : '你的使用习惯'}</span><h3>{pages.find(item => item.id === page)?.label}</h3><p>{page === 'model' ? '配置接口地址、访问密钥与默认模型。' : page === 'data' ? '管理保存在这台设备上的学习数据。' : page === 'display' ? '选择适合当前环境的外观，让学习更舒适。' : '调整称呼和学习目标，按自己的节奏前进。'}</p></header>
      {page === 'preferences' && <><div className="form-field"><span id="preference-name-label">你的称呼</span><input aria-labelledby="preference-name-label" required maxLength={16} value={preferences.name} onChange={e => setPreferences({ ...preferences, name: e.target.value })} /></div><div className="form-field"><span id="daily-minutes-label">每天留给学习的时间</span><div className="input-unit"><input aria-labelledby="daily-minutes-label" type="number" required min={5} max={480} value={preferences.dailyMinutes} onChange={e => setPreferences({ ...preferences, dailyMinutes: Number(e.target.value) })} /><span>分钟</span></div></div><div className="settings-info"><Check size={17} /><p>主页和任务看板会显示你的每日目标；目标是提醒，可以随时调整。</p></div></>}
      {page === 'model' && <><div className="form-field"><span id="api-address-label">接口地址</span><input aria-labelledby="api-address-label" required type="url" autoComplete="off" placeholder="https://your-api.example/v1" value={config.baseUrl} onChange={e => setConfig({ ...config, baseUrl: e.target.value })} /></div><div className="form-field"><span id="api-secret-label">API 密钥</span><div className="secret-input"><input id="api-secret" aria-labelledby="api-secret-label" type={showKey ? 'text' : 'password'} autoComplete="off" placeholder="输入访问密钥（可选）" value={key} onChange={e => setKey(e.target.value)} /><button type="button" className="icon-button" aria-label={showKey ? '隐藏 API 密钥' : '显示 API 密钥'} onClick={() => setShowKey(!showKey)}>{showKey ? <EyeOff size={16} /> : <Eye size={16} />}</button></div><small>密钥仅保留在当前标签页会话，关闭标签页后清除。</small></div><div className="settings-field-grid"><div className="form-field"><span id="api-model-label">模型名称</span><input aria-labelledby="api-model-label" required autoComplete="off" maxLength={120} placeholder="填写服务提供的模型 ID" value={config.model} onChange={e => setConfig({ ...config, model: e.target.value })} /></div><div className="form-field"><span id="api-format-label">接口格式</span><Dropdown label="接口格式" value={config.format} onChange={value => setConfig({ ...config, format: value as ApiConfiguration['format'] })} options={[{ value: 'compatible', label: '兼容接口', description: '通用消息格式，后端适配' }, { value: 'native', label: '原生接口', description: '按服务提供方的格式适配' }]} /></div></div><div className="form-field">随机度 <span className="range-value">{config.temperature.toFixed(1)}</span><input aria-label="随机度" type="range" min="0" max="2" step="0.1" value={config.temperature} onChange={e => setConfig({ ...config, temperature: Number(e.target.value) })} /></div><div className="settings-info"><KeyRound size={17} /><p>这是前端配置演示，不发送网络请求。真实调用和密钥管理会在后端接入时完成。</p></div></>}
      {page === 'display' && <><fieldset className="theme-options"><legend>界面外观</legend><div className="theme-option-grid">{([{ id: 'light', name: '浅色', icon: Sun, description: '清爽的白色与克莱因蓝' }, { id: 'dark', name: '深色', icon: Moon, description: '沉静的墨蓝与柔和亮蓝' }] as const).map(({ id, name, icon: Icon, description }) => <label className={`theme-option ${preferences.theme === id ? 'selected' : ''}`} key={id}><input type="radio" name="appearance" aria-label={`${name}外观`} value={id} checked={preferences.theme === id} onChange={() => setPreferences({ ...preferences, theme: id })} /><span className={`theme-preview ${id}`} aria-hidden="true"><span className="preview-rail"><i /><i /><i /></span><span className="preview-main"><span className="preview-top"><i /><i /></span><span className="preview-body"><i /><span><i /><i /></span></span></span></span><span className="theme-option-caption"><Icon size={16} /><strong>{name}</strong>{preferences.theme === id && <Check size={15} />}</span><small>{description}</small></label>)}</div></fieldset><p className="appearance-note">外观应用于主页、学习工作台、资料和菜单。保存后会在当前浏览器中保留。</p></>}
      {page === 'data' && <><div className="settings-data-card"><Database size={22} /><h4>浏览器中的学习空间</h4><p>课程、资料文本、学习记录和偏好保存在当前浏览器，便于之后接入后端。</p><dl><div><dt>课程</dt><dd>{data.courses.length} 门</dd></div><div><dt>学习资料</dt><dd>{data.courses.reduce((count, course) => count + course.materials.length, 0)} 份</dd></div></dl></div><div className="settings-reset"><strong>恢复演示数据</strong><p>清除新增课程和本地记录，恢复初始课程与示例统计。</p><button type="button" className="button" onClick={onReset}>恢复初始演示数据</button></div></>}
    </div><footer className="settings-page-footer">{feedback && <p role="status">{feedback}</p>}<div>{page === 'model' && <button type="button" className="button" onClick={validate}>检查配置格式</button>}<button type="button" className="button" onClick={onClose}>关闭</button>{page !== 'data' && <button className="button primary" disabled={saving}>{saving ? '正在保存…' : page === 'model' ? '保存配置' : page === 'display' ? '保存外观' : '保存偏好'}</button>}</div></footer></form></div></Modal>;
}
