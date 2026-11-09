'use client';
/**
 * Settings dialog. Shell layout and visual language adapted from deepseek-harness
 * (packages/client/ui-settings-general SettingsRoot, MIT License, Copyright (c) 2026 DeepSeek):
 * 188px nav rail + content column, 40px nav cells, title/description rows with a
 * control on the right, capsule buttons. Syllora sections are passed in as a static list.
 */
import type { ReactNode } from 'react';
import { Archive, Cpu, FileText, FolderOpen, RefreshCw, RotateCcw, ShieldCheck, Trash2, UserRound, X } from 'lucide-react';
import ModelsSection from '../../../components/settings/ModelsSection';
import PreferencesEditor, { type UiPreferences } from './PreferencesEditor';
import '../settings.css';

export type SettingsTab = 'prefs'|'models'|'privacy'|'archive'|'diag';
export interface ArchivedCourse { id:string; name:string; points:number; materials:number; attempts:number }
export interface DiagFile { name:string; bytes:number; text:string; truncated:boolean }

const SECTIONS:Array<{id:SettingsTab;label:string;icon:ReactNode}> = [
  {id:'prefs',label:'用户偏好',icon:<UserRound size={16}/>},
  {id:'models',label:'模型配置',icon:<Cpu size={16}/>},
  {id:'privacy',label:'数据与授权',icon:<ShieldCheck size={16}/>},
  {id:'archive',label:'归档管理',icon:<Archive size={16}/>},
  {id:'diag',label:'诊断日志',icon:<FileText size={16}/>},
];

export function SectionHead({title,children}:{title:string;children?:ReactNode}) {
  return <header className="settings-section-head"><h3>{title}</h3>{children&&<p>{children}</p>}</header>;
}

export default function SettingsPanel(props:{
  tab:SettingsTab; onTab:(tab:SettingsTab)=>void; onClose:()=>void; busy:boolean;
  preferences:UiPreferences; onPreferencesSaved:()=>Promise<void>;
  consent:boolean; onConsent:(value:boolean)=>void; calls:number; onSaveConsent:()=>void;
  archived:ArchivedCourse[]; onRestore:(id:string)=>void; onDelete:(course:ArchivedCourse)=>void;
  diagFiles:DiagFile[]|null; diagLoading:boolean; onExportDiag:()=>void; onReloadDiag:()=>void; onOpenLogs?:(()=>void)|undefined;
}) {
  const {tab,busy}=props;
  return <div className="settings-overlay" role="presentation">
    <div className="settings-mask" aria-hidden="true" onClick={props.onClose}/>
    <section className="settings-panel" role="dialog" aria-modal="true" aria-label="模型与设置">
      <nav className="settings-nav" aria-label="设置分区">
        <h2 className="settings-nav-title">设置</h2>
        <div className="settings-nav-list">{SECTIONS.map(section=><button key={section.id} type="button" className={`settings-nav-cell${tab===section.id?' active':''}`} aria-current={tab===section.id?'true':undefined} onClick={()=>props.onTab(section.id)}>{section.icon}<span>{section.label}</span></button>)}</div>
      </nav>
      <div className="settings-content">
        <header className="settings-header"><button type="button" className="settings-close" aria-label="关闭设置" onClick={props.onClose}><X size={14}/></button></header>
        <div className="settings-options">
          {tab==='prefs'&&<PreferencesEditor initial={props.preferences} onSaved={props.onPreferencesSaved}/>}
          {tab==='models'&&<div className="sy-settings-models"><ModelsSection initial={null}/></div>}
          {tab==='privacy'&&<div className="settings-section">
            <SectionHead title="数据与授权">生成大纲、回答和题目时，Syllora 会向所选模型服务发送相关资料片段、问题和题目。供应商的数据留存规则以其实际政策为准。</SectionHead>
            <div className="settings-group">
              <label className="settings-row settings-row-check"><span className="settings-row-text"><span className="settings-row-title">允许向已配置模型发送以上内容</span><span className="settings-row-desc">关闭后，资料整理、讲解和出题会暂停，已有学习记录不受影响。</span></span><input type="checkbox" className="settings-switch" role="switch" checked={props.consent} onChange={event=>props.onConsent(event.target.checked)}/></label>
              <div className="settings-row"><span className="settings-row-text"><span className="settings-row-title">模型调用次数</span><span className="settings-row-desc">供应商账户费用与额度由你自行管理。</span></span><span className="settings-value">{props.calls} 次</span></div>
            </div>
            <div className="settings-actions"><button type="button" className="settings-btn primary" disabled={busy} onClick={props.onSaveConsent}>保存授权</button></div>
          </div>}
          {tab==='archive'&&<div className="settings-section">
            <SectionHead title="归档管理">已归档课程不参与学习与复习。可以恢复，也可以永久删除——删除只清理 Syllora 产物与学习记录，课程文件夹和原始资料保留，此操作不可撤销。</SectionHead>
            {!props.archived.length?<p className="settings-empty">暂无已归档课程。在工作台顶部的课程操作里点「归档」，课程就会移到这里。</p>
            :<ul className="settings-list">{props.archived.map(course=><li className="settings-card" key={course.id}>
              <span className="settings-card-icon"><FileText size={16}/></span>
              <span className="settings-card-text"><strong>{course.name}</strong><small>{course.points} 个知识点 · {course.materials} 份资料 · {course.attempts} 次作答</small></span>
              <span className="settings-card-actions"><button type="button" className="settings-btn sm" disabled={busy} onClick={()=>props.onRestore(course.id)}><RotateCcw size={13}/>恢复</button><button type="button" className="settings-btn sm danger" disabled={busy} onClick={()=>props.onDelete(course)}><Trash2 size={13}/>永久删除</button></span>
            </li>)}</ul>}
          </div>}
          {tab==='diag'&&<div className="settings-section">
            <SectionHead title="诊断日志">宿主运行日志按天存放在本机。模型配置或生成失败时，这里能找到确切原因；导出后可直接发给开发排查。</SectionHead>
            <div className="settings-actions start">
              <button type="button" className="settings-btn primary" disabled={props.diagLoading||!(props.diagFiles?.length)} onClick={props.onExportDiag}>导出诊断日志</button>
              {props.onOpenLogs&&<button type="button" className="settings-btn" onClick={props.onOpenLogs}><FolderOpen size={14}/>打开日志目录</button>}
              {props.diagFiles!==null&&!props.diagLoading&&<button type="button" className="settings-btn" onClick={props.onReloadDiag}><RefreshCw size={14}/>重新读取</button>}
            </div>
            {props.diagLoading?<p className="settings-empty">正在读取日志…</p>:!(props.diagFiles?.length)?<p className="settings-empty">暂无日志文件。</p>
            :<ul className="settings-list">{props.diagFiles.map(file=><li className="settings-card" key={file.name}><span className="settings-card-icon"><FileText size={16}/></span><span className="settings-card-text"><strong>{file.name}</strong><small>{(file.bytes/1024).toFixed(1)} KiB{file.truncated?' · 已截断':''}</small></span></li>)}</ul>}
          </div>}
        </div>
      </div>
    </section>
  </div>;
}
