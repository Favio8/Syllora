/**
 * 教学技能库：id 唯一、正文非空、未启用/未知 id 不注入、关键规则确实在正文里。
 * 这些断言是"技能没有在改写中丢机制"的最低保障。
 */

import { describe, expect, it } from 'vitest'
import { AGENT_SKILLS, AGENT_SKILL_IDS, agentSkillPrompt } from '../src/skills.ts'

describe('教学技能库', () => {
  it('id 唯一，且每项都有名称、描述与非空正文', () => {
    expect(new Set(AGENT_SKILL_IDS).size).toBe(AGENT_SKILL_IDS.length)
    for (const skill of AGENT_SKILLS) {
      expect(skill.name.trim()).not.toBe('')
      expect(skill.description.trim()).not.toBe('')
      expect(skill.prompt.length).toBeGreaterThan(200)
    }
  })

  it('未启用或未知 id 不注入任何内容', () => {
    expect(agentSkillPrompt('')).toBe('')
    expect(agentSkillPrompt(undefined)).toBe('')
    expect(agentSkillPrompt(null)).toBe('')
    expect(agentSkillPrompt('nope')).toBe('')
  })

  it('注入的正文带标题行，且保留各技能的承重规则', () => {
    expect(agentSkillPrompt('feynman')).toContain('## 教学技能：费曼学习法')
    expect(agentSkillPrompt('feynman')).toContain('7 项记录')
    expect(agentSkillPrompt('zpd')).toContain('支持表')
    expect(agentSkillPrompt('zpd')).toContain('撤架')
    expect(agentSkillPrompt('spiral')).toContain('假螺旋')
    expect(agentSkillPrompt('ubd')).toContain('GRASPS')
    expect(agentSkillPrompt('learn-to-learn')).toContain('并行目标')
    expect(agentSkillPrompt('fact-check')).toContain('A. 明确事实错误')
  })

  it('正文不含模板占位符花括号（避免被误当模板渲染）', () => {
    for (const skill of AGENT_SKILLS) expect(skill.prompt).not.toContain('{')
  })
})
