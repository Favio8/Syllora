/**
 * 共享设置目录登记：工作台的模型配置写在共享目录（桌面壳的
 * `SYLLORA_DATA_DIR`，设置页只写这一处），而对话、构课、判题解析的都是
 * 课程目录。Host 启动时登记一次，config 与 settings 两个读取层共用同一份
 * 回落目标——否则「设置里已配好、对话却报未配置」。
 * @module @syllora/chat-service/src/shared-root
 */

import { resolve } from 'node:path'

let sharedRoot: string | null = null

/** 登记共享设置目录；空串表示清除（测试用）。 */
export function setSharedConfigRoot(root: string): void {
  const trimmed = root.trim()
  sharedRoot = trimmed === '' ? null : resolve(trimmed)
}

/** 当前登记的共享设置目录；未登记返回 null。 */
export function sharedConfigRootOf(): string | null {
  return sharedRoot
}
