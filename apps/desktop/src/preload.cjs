'use strict'
const { contextBridge, ipcRenderer } = require('electron')

// 最小化、显式的桥接。Web UI 不需要 Node 访问；Host token 由静态托管按
// 浏览器路径的方式注入 window.__SYLLORA__——桌面壳不额外注入任何凭据。
// C-5：host-info 只返回目录事实 {dev, port, hostHome, logsDir, dataDir}，
// 不透出 host.json 全文（含访问 token）。
// openPath：设置弹窗「本机与诊断」打开数据/日志目录用；主进程侧只放行
// hostHome 子树内的路径，渲染层无法借它打开任意文件。
contextBridge.exposeInMainWorld('sylloraDesktop', {
  hostInfo: () => ipcRenderer.invoke('syllora:host-info'),
  openPath: (path) => ipcRenderer.invoke('syllora:open-path', path),
  pickDirectory: () => ipcRenderer.invoke('syllora:pick-directory'),
  isDesktop: true,
  platform: process.platform,
})
