/**
 * dsh-ring — DeepSeek Harness 回合分级提示音（宿主半）。
 *
 * agent 回合收尾时按场景播放一次提示音：
 *   - 计划模式生效            -> plan（产出了方案）
 *   - 本回合用过执行类工具     -> done（执行了任务）
 *   - 纯问答，没用工具         -> 静音
 *   - ask_user_question / 审批请求 -> ask（需要用户输入）
 *   - agent 出错              -> fail
 *
 * 只有根会话 agent 发声，子代理不响。同类音效有独立防抖窗口。
 * 音量在「设置 → 通用」的滑块里调，经 /ring/api/* 环回接口读写，
 * 持久化到 ~/.dsh/dsh-ring/volume.json。
 *
 * 声音资产改自 dsh-perlica-ding（MIT），播放原理与其一致：
 * Windows 走 PowerShell SoundPlayer，macOS afplay，Linux paplay/aplay；
 * 音量通过重缩放 WAV PCM 采样实现，不碰系统音量、不依赖 ffmpeg。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { execFile } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { homedir, tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'

const BUNDLED_SOUNDS = join(dirname(fileURLToPath(import.meta.url)), 'sounds')
// 用户自定义音效目录：在 node_modules 外，插件更新/重装不会动它
const USER_SOUNDS = join(homedir(), '.dsh', 'dsh-ring', 'sounds')
const CACHE_DIR = join(tmpdir(), 'dsh-ring')
const PERSIST_PATH = join(homedir(), '.dsh', 'dsh-ring', 'volume.json')

export const name = 'dsh-ring'
export const inject = ['subprocess']

/** 认定为"执行任务"的工具白名单；read/grep/glob/web_search 等只读工具不响。 */
const DEFAULT_EXEC_TOOLS = [
  'pwsh', 'bash', 'write', 'edit', 'run_code', 'str-replace-editor', 'task',
  'subagent', 'subagent_fork', 'workflow', 'ralph', 'job_kill',
  'create_goal', 'update_goal', 'todo_write',
  'cordis_define', 'cordis_run', 'cordis_stop', 'cordis_undefine',
]

export const Config = z.object({
  enabled: z.boolean().default(true),
  debounceMs: z.number().min(100).max(60000).default(2500),
  soundDir: z.string().default(''),
  volume: z.number().min(0).max(100).default(100),
  execTools: z.array(z.string()).default(DEFAULT_EXEC_TOOLS),
})

const KINDS = ['plan', 'done', 'ask', 'fail']

const SYSTEM_SOUNDS = {
  win32: {
    plan: ['C:\\Windows\\Media\\chimes.wav', 'C:\\Windows\\Media\\notify.wav'],
    done: ['C:\\Windows\\Media\\notify.wav', 'C:\\Windows\\Media\\chimes.wav'],
    ask: ['C:\\Windows\\Media\\ding.wav', 'C:\\Windows\\Media\\Windows Notify System Default.wav'],
    fail: ['C:\\Windows\\Media\\Windows Ding.wav'],
  },
  darwin: {
    plan: ['/System/Library/Sounds/Ping.aiff'],
    done: ['/System/Library/Sounds/Glass.aiff'],
    ask: ['/System/Library/Sounds/Pop.aiff'],
    fail: ['/System/Library/Sounds/Basso.aiff'],
  },
  linux: {
    plan: ['/usr/share/sounds/freedesktop/stereo/complete.oga'],
    done: ['/usr/share/sounds/freedesktop/stereo/complete.oga'],
    ask: ['/usr/share/sounds/freedesktop/stereo/message-new-instant.oga'],
    fail: ['/usr/share/sounds/freedesktop/stereo/dialog-error.oga'],
  },
}

/** ---- 持久化：volume.json v2 = 全局音量 + 每场景开关/音量（v1 只有 volume，迁移时全部默认开/100） ---- */
const KIND_DEFAULTS = () => Object.fromEntries(KINDS.map((k) => [k, { enabled: true, volume: 100 }]))

function loadState() {
  try {
    const parsed = JSON.parse(readFileSync(PERSIST_PATH, 'utf8'))
    const kinds = KIND_DEFAULTS()
    if (parsed && typeof parsed.volume === 'number' && Number.isFinite(parsed.volume)) {
      const state = {
        volume: Math.max(0, Math.min(100, Math.round(parsed.volume))),
        kinds,
      }
      if (parsed.kinds && typeof parsed.kinds === 'object') {
        for (const k of KINDS) {
          const raw = parsed.kinds[k]
          if (!raw) continue
          if (typeof raw.enabled === 'boolean') kinds[k].enabled = raw.enabled
          if (typeof raw.volume === 'number' && Number.isFinite(raw.volume)) {
            kinds[k].volume = Math.max(0, Math.min(100, Math.round(raw.volume)))
          }
        }
      }
      return state
    }
  } catch { /* 首次运行 */ }
  return null
}

function saveState(state) {
  try {
    mkdirSync(dirname(PERSIST_PATH), { recursive: true })
    writeFileSync(PERSIST_PATH, JSON.stringify({ version: 2, ...state, updatedAt: new Date().toISOString() }, null, 2))
  } catch (error) {
    console.error('[dsh-ring] 状态持久化失败', error)
  }
}

/** ---- WAV PCM 音量缩放（8/16-bit PCM，含 WAVE_FORMAT_EXTENSIBLE 包装），按音量缓存 ---- */
function scaleWavVolume(srcPath, volume) {
  const gain = volume / 100
  if (gain === 1) return srcPath
  let buf
  try { buf = readFileSync(srcPath) } catch { return srcPath }
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return srcPath
  let offset = 12, audioFormat = 0, bitsPerSample = 0, dataOffset = -1, dataSize = 0
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4)
    const chunkSize = buf.readUInt32LE(offset + 4)
    const body = offset + 8
    if (id === 'fmt ' && chunkSize >= 16) {
      audioFormat = buf.readUInt16LE(body)
      bitsPerSample = buf.readUInt16LE(body + 14)
      if (audioFormat === 0xfffe && chunkSize >= 40 && buf.readUInt16LE(body + 24) === 1) audioFormat = 1
    } else if (id === 'data') {
      dataOffset = body
      dataSize = Math.min(chunkSize, buf.length - body)
    }
    if (dataOffset >= 0 && bitsPerSample > 0) break
    offset = body + chunkSize + (chunkSize % 2)
  }
  if (dataOffset < 0 || audioFormat !== 1) return srcPath
  const out = Buffer.from(buf)
  if (bitsPerSample === 16) {
    for (let i = 0; i + 1 < dataSize; i += 2) {
      const pos = dataOffset + i
      let v = Math.round(out.readInt16LE(pos) * gain)
      if (v > 32767) v = 32767
      else if (v < -32768) v = -32768
      out.writeInt16LE(v, pos)
    }
  } else if (bitsPerSample === 8) {
    for (let i = 0; i < dataSize; i++) {
      const pos = dataOffset + i
      const v = Math.round((out.readUInt8(pos) - 128) * gain + 128)
      out.writeUInt8(Math.max(0, Math.min(255, v)), pos)
    }
  } else {
    return srcPath
  }
  const dest = join(CACHE_DIR, basename(srcPath).replace(/\.wav$/i, '') + '-v' + volume + '-' + buf.length + '.wav')
  try {
    if (!existsSync(dest)) {
      mkdirSync(CACHE_DIR, { recursive: true })
      writeFileSync(dest, out)
    }
    return dest
  } catch (error) {
    console.error('[dsh-ring] 音量缓存写入失败', error)
    return srcPath
  }
}

/**
 * 用系统文件管理器打开一个目录。
 * 与官方 @deepseek-ai/dsh-native-command 同法：Windows 交给 explorer.exe 一个
 * file:// URI（explorer 委派给已运行实例后自身以 exit 1 退出，必须容忍），
 * 且用 node:child_process 直接启动——DSH 的 subprocess seam 起不了这个 GUI 进程。
 */
function explorerTarget(windowsPath) {
  return pathToFileURL(windowsPath, { windows: true }).href
    .replace(/(?:%[89A-F][0-9A-F])+/gi, (escaped) => decodeURIComponent(escaped))
    .replaceAll(',', '%2C')
    .replaceAll('=', '%3D')
}

function openDirectory(dir, platform) {
  if (platform === 'win32') {
    execFile('explorer.exe', [explorerTarget(dir)], { windowsHide: false }, (error) => {
      if (error && error.code !== 1) console.error('[dsh-ring] 打开目录失败', error)
    })
    return
  }
  const command = platform === 'darwin' ? 'open' : 'xdg-open'
  execFile(command, [dir], { windowsHide: false }, (error) => {
    if (error) console.error('[dsh-ring] 打开目录失败', error)
  })
}

/** PowerShell -EncodedCommand 需要 UTF-16LE base64。 */
function utf16leToBase64(text) {
  let bytes = ''
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    bytes += String.fromCharCode(code & 0xff, code >>> 8)
  }
  return btoa(bytes)
}

/** plan 模式状态兜底：planMode 服务不可用时从会话事件流折叠。 */
function foldPlanModeFromEvents(events) {
  if (!events || !events.length) return false
  let active = false
  for (const event of events) {
    if (event && event.type === 'plan/mode') active = !!(event.data && event.data.active)
  }
  return active
}

export function apply(ctx, config) {
  const cfg = Config(config ?? {})
  const subprocess = ctx.get('subprocess')
  if (subprocess === undefined) return
  const agents = ctx.get('agents')
  const planMode = ctx.get('planMode')
  const platform = process.platform

  const state = loadState() ?? { volume: cfg.volume, kinds: KIND_DEFAULTS() }
  const lastPlayed = {}
  const turnStart = new Map()
  const lastTool = new Map()

  const isRoot = (agent) => {
    if (!agents || !agent) return true
    try { return agents.roots().some((a) => a.id === agent.id) } catch { return true }
  }

  const resolveSound = (kind) => {
    const candidates = []
    if (cfg.soundDir) candidates.push(join(cfg.soundDir, kind + '.wav'))
    candidates.push(join(USER_SOUNDS, kind + '.wav'))
    candidates.push(join(process.cwd(), kind + '.wav'))
    candidates.push(join(BUNDLED_SOUNDS, kind + '.wav'))
    candidates.push(...((SYSTEM_SOUNDS[platform] || {})[kind] || []))
    for (const c of candidates) if (existsSync(c)) return c
    return candidates[0] || null
  }

  const spawnPlay = (attempts) => {
    let index = 0
    const tryNext = () => {
      if (index >= attempts.length) return
      const argv = attempts[index++]
      let handle
      try {
        handle = subprocess.spawn({
          argv,
          cwd: platform === 'win32' ? 'C:\\Windows' : '/',
          stdio: { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' },
          graceMs: 3000,
        })
      } catch (error) {
        console.error('[dsh-ring] spawn 失败', argv[0], error)
        tryNext()
        return
      }
      handle.done.catch((error) => {
        console.error('[dsh-ring] 播放进程失败', argv[0], error)
        tryNext()
      })
    }
    tryNext()
  }

  const play = (kind) => {
    if (!cfg.enabled) return
    const kindCfg = state.kinds[kind] || { enabled: true, volume: 100 }
    if (!kindCfg.enabled) return
    // 有效音量 = 全局 × 场景（两个都是 0-100 百分比）
    const volume = Math.round((state.volume * kindCfg.volume) / 100)
    if (volume <= 0) return
    const now = Date.now()
    if (now - (lastPlayed[kind] || 0) < cfg.debounceMs) return
    lastPlayed[kind] = now
    const resolved = resolveSound(kind)
    if (!resolved) return
    const file = volume < 100 ? scaleWavVolume(resolved, volume) : resolved
    if (platform === 'win32') {
      const script = "$p = New-Object Media.SoundPlayer '" + file.replace(/'/g, "''") + "'; $p.PlaySync()"
      const encoded = utf16leToBase64(script)
      spawnPlay([
        ['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
        ['pwsh.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      ])
    } else if (platform === 'darwin') {
      spawnPlay([['/usr/bin/afplay', file]])
    } else {
      spawnPlay([['paplay', file], ['aplay', file]])
    }
  }

  // ---- 环回接口：/ring/api/state (GET) 与 /ring/api/volume (POST) ----
  // webServer 在启动序里可能晚于本插件，用延迟注入拿服务；没有 web 载体的部署不影响提示音。
  const readJsonBody = (req) => new Promise((resolve) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
      if (data.length > 65536) data = data.slice(0, 65536)
    })
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')) } catch { resolve({}) } })
    req.on('error', () => resolve({}))
  })

  const registerBridge = (webServer, host) => {
    if (!webServer || !host) {
      console.error('[dsh-ring] webServer 不可用，滑块桥接禁用（提示音不受影响）')
      return
    }
    host.effect(() => webServer.register({
      kind: 'prefix',
      path: '/ring/api',
      handler: async (req, res) => {
        const send = (code, payload) => {
          res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify(payload))
        }
        try {
          const path = (req.url || '').split('?')[0]
          if (req.method === 'GET' && path === '/ring/api/state') {
            return send(200, { volume: state.volume, enabled: cfg.enabled, kinds: state.kinds, soundsDir: cfg.soundDir || USER_SOUNDS })
          }
          if (req.method === 'POST' && path === '/ring/api/volume') {
            const body = await readJsonBody(req)
            const next = Math.round(Number(body && body.volume))
            if (!Number.isFinite(next) || next < 0 || next > 100) {
              return send(400, { error: 'volume must be a number between 0 and 100' })
            }
            state.volume = next
            saveState(state)
            return send(200, { volume: state.volume })
          }
          if (req.method === 'POST' && path === '/ring/api/kind') {
            const body = await readJsonBody(req)
            const kind = String((body && body.kind) || '')
            if (!KINDS.includes(kind)) return send(400, { error: 'unknown sound kind' })
            const kc = state.kinds[kind]
            if (body && typeof body.enabled === 'boolean') kc.enabled = body.enabled
            if (body && typeof body.volume === 'number' && Number.isFinite(body.volume)) {
              kc.volume = Math.max(0, Math.min(100, Math.round(body.volume)))
            }
            saveState(state)
            return send(200, { kind, ...kc })
          }
          if (req.method === 'POST' && path === '/ring/api/open-sounds') {
            try { mkdirSync(USER_SOUNDS, { recursive: true }) } catch (error) { /* 已存在或权限不足 */ }
            const dir = cfg.soundDir || USER_SOUNDS
            openDirectory(dir, platform)
            return send(200, { opened: dir })
          }
          return send(404, { error: 'not found' })
        } catch (error) {
          return send(500, { error: String((error && error.message) || error) })
        }
      },
    }))
    console.error('[dsh-ring] 滑块桥接已注册 /ring/api')
  }

  const webServerNow = ctx.get('webServer')
  if (webServerNow) {
    registerBridge(webServerNow, ctx)
  } else if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (scope) => registerBridge(scope.webServer, scope))
  }

  // ---- 事件挂钩 ----
  ctx.on('agent/inbox/claimed', (payload) => {
    if (!payload || !isRoot(payload.agent)) return
    turnStart.set(payload.agent.id, Date.now())
  })

  ctx.on('tools/result', (exec) => {
    if (!exec || !exec.agent || !isRoot(exec.agent)) return
    if (cfg.execTools.length > 0 && !cfg.execTools.includes(exec.name)) return
    lastTool.set(exec.agent.id, Date.now())
  })

  ctx.on('tools/execute', (exec, next) => {
    if (exec && exec.name === 'ask_user_question') play('ask')
    return next()
  })

  ctx.on('approval/request', (req, next) => {
    play('ask')
    return next()
  })

  ctx.on('agent/error', (payload) => {
    if (!payload || !isRoot(payload.agent)) return
    play('fail')
  })

  ctx.on('agent/turn-stopping', (payload) => {
    if (!payload || !payload.agent || !isRoot(payload.agent)) return
    const id = payload.agent.id
    let active = false
    if (planMode) {
      try { const s = planMode.get(payload.agent); active = !!(s && s.active) } catch { /* 兜底 */ }
    } else {
      try { active = foldPlanModeFromEvents(payload.agent.session && payload.agent.session.events) } catch { /* 兜底 */ }
    }
    try {
      if (active) play('plan')
      else if ((lastTool.get(id) || 0) >= (turnStart.get(id) || 0)) play('done')
    } catch (error) {
      console.error('[dsh-ring] turn-stopping 处理失败', error)
    } finally {
      turnStart.delete(id)
      lastTool.delete(id)
    }
  })
}
