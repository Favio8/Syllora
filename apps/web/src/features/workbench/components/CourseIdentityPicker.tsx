'use client';
import { Check } from 'lucide-react';
import { courseIcons, resolveCourseIcon } from '../lib/courseIcons';
import type { Course, CourseIconId } from '../types';
export const courseColors = [
  {id:'blue',label:'蓝色'}, {id:'green',label:'绿色'}, {id:'orange',label:'橙色'},
  {id:'purple',label:'紫色'}, {id:'rose',label:'玫瑰色'}, {id:'slate',label:'石板色'},
] as const;
export default function CourseIdentityPicker({icon,color,name,onIcon,onColor}:{icon:string;color:Course['color'];name:string;onIcon:(value:CourseIconId)=>void;onColor:(value:Course['color'])=>void}) {
  const Icon=resolveCourseIcon(undefined,icon as CourseIconId).icon;
  return <div className="course-identity-picker">
    <fieldset className="course-icon-picker"><legend>课程图标</legend><div className={`icon-choice-grid identity-${color}`}>
      {courseIcons.map(option=><label key={option.id} className={`icon-choice ${icon===option.id?'selected':''}`}>
        <input type="radio" name="course-icon" value={option.id} checked={icon===option.id} onChange={()=>onIcon(option.id)}/>
        <option.icon size={23} aria-hidden/><span>{option.label}</span>{icon===option.id&&<Check size={12} className="icon-choice-check"/>}
      </label>)}
    </div></fieldset>
    <fieldset className="course-color-picker"><legend>图标颜色</legend><div className="color-choice-row">{courseColors.map(option=><label key={option.id} className={`color-choice identity-${option.id}`} title={option.label}>
      <input type="radio" name="course-color" aria-label={option.label} value={option.id} checked={color===option.id} onChange={()=>onColor(option.id)}/><span>{color===option.id&&<Check size={15}/>}</span>
    </label>)}</div></fieldset>
    <div className="course-identity-preview"><span className={`course-symbol large ${color}`}><Icon size={25}/></span><div><strong>{name.trim()||'你的课程'}</strong><small>课程图标预览 · 可随时修改</small></div></div>
  </div>;
}
