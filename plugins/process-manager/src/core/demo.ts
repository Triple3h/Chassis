/**
 * 演示数据：不在启动台宿主里（`npm run dev` 的浏览器）时展示，
 * 让界面每一处（风险徽标、系统进程、终止确认）都能被点一遍 —— 不白屏、不静默失败。
 */

import type { PortEntry, ProcDetail, ProcEntry } from './types'

export const DEMO_PORTS: PortEntry[] = [
  { port: 3000, protocol: 'tcp', address: '*', state: 'listen', pid: 51234, process: 'node', user: 'you', memory: 154 * 1024 * 1024, risk: 'safe', selfRelated: false },
  { port: 5173, protocol: 'tcp', address: '127.0.0.1', state: 'listen', pid: 51234, process: 'node', user: 'you', memory: 154 * 1024 * 1024, risk: 'safe', selfRelated: false },
  { port: 5432, protocol: 'tcp', address: '127.0.0.1', state: 'listen', pid: 812, process: 'postgres', user: 'you', memory: 43 * 1024 * 1024, risk: 'safe', selfRelated: false },
  { port: 5037, protocol: 'tcp', address: '127.0.0.1', state: 'listen', pid: 64777, process: 'adb', user: 'you', memory: 6 * 1024 * 1024, risk: 'safe', selfRelated: false },
  { port: 53, protocol: 'udp', address: '*', state: '', pid: 341, process: 'mDNSResponder', user: 'root', memory: 9 * 1024 * 1024, risk: 'safe', selfRelated: false },
  { port: 7000, protocol: 'tcp', address: '*', state: 'listen', pid: 719, process: 'ControlCenter', user: 'you', memory: 74 * 1024 * 1024, risk: 'safe', selfRelated: false },
  { port: 88, protocol: 'tcp', address: '127.0.0.1', state: 'listen', pid: 1, process: 'launchd', user: 'root', memory: 14 * 1024 * 1024, risk: 'blocked', selfRelated: false },
]

export const DEMO_PROCS: ProcEntry[] = [
  { pid: 949, name: 'OrbStack Helper', user: 'you', cpu: 42.6, memory: 891 * 1024 * 1024, parent: 1, risk: 'safe', selfRelated: false },
  { pid: 51234, name: 'node', user: 'you', cpu: 18.4, memory: 154 * 1024 * 1024, parent: 4012, risk: 'safe', selfRelated: false },
  { pid: 719, name: 'ControlCenter', user: 'you', cpu: 6.2, memory: 74 * 1024 * 1024, parent: 1, risk: 'safe', selfRelated: false },
  { pid: 4012, name: 'Code Helper (Renderer)', user: 'you', cpu: 4.8, memory: 322 * 1024 * 1024, parent: 3980, risk: 'safe', selfRelated: false },
  { pid: 812, name: 'postgres', user: 'you', cpu: 0.4, memory: 43 * 1024 * 1024, parent: 801, risk: 'safe', selfRelated: false },
  { pid: 642, name: 'Finder', user: 'you', cpu: 0.3, memory: 88 * 1024 * 1024, parent: 1, risk: 'caution', selfRelated: false },
  { pid: 521, name: 'WindowServer', user: '_windowserver', cpu: 12.1, memory: 402 * 1024 * 1024, parent: 1, risk: 'blocked', selfRelated: false },
  { pid: 65001, name: 'launcher-kernel', user: 'you', cpu: 0.2, memory: 21 * 1024 * 1024, parent: 64990, risk: 'blocked', selfRelated: true },
  { pid: 1, name: 'launchd', user: 'root', cpu: 0.1, memory: 14 * 1024 * 1024, parent: undefined, risk: 'blocked', selfRelated: false },
]

export const DEMO_DETAIL: ProcDetail = {
  pid: 51234,
  name: 'node',
  user: 'you',
  cpu: 18.4,
  memory: 154 * 1024 * 1024,
  parent: 4012,
  risk: 'safe',
  selfRelated: false,
  exe: '/usr/local/bin/node',
  cmd: 'node /Users/you/project/node_modules/.bin/vite --port 3000',
  startedAt: Math.floor(Date.now() / 1000) - 3_720,
  ports: DEMO_PORTS.filter((entry) => entry.pid === 51234),
}

export const DEMO_TOTAL_MEMORY = 16 * 1024 * 1024 * 1024
export const DEMO_CORES = 10
