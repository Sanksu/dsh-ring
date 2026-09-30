/**
 * dsh-ring — client half.
 *
 * 「设置 → 通用」注册提示音配置块：
 *   - 主行：总音量滑块 + 音效目录按钮
 *   - 四个场景行：仅启用开关（计划出方案 / 任务完成 / 需要你回应 / 出错）
 * 行样式复刻官方 General 行；开关为自绘组件，CSS 逐属性复刻官方 primitives 的
 * Switch（该包无 client 半，插件无法 require 它）。改动即时持久化到宿主 volume.json。
 */
window.__ModuleLoader__.load({
  id: 'dsh-ring',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var React = require('react')
    var h = React.createElement

    var API = '/ring/api'
    var KIND_LABELS = { plan: '计划出方案', done: '任务完成', ask: '需要你回应', fail: '出错' }
    var KIND_DESC = {
      plan: '计划模式产出方案时',
      done: '回合内执行过任务工具时',
      ask: '等待你的输入或审批时',
      fail: '执行出错时',
    }

    var CSS = '.dsh-ring-row{border-bottom:.5px solid var(--dsw-alias-border-l2);justify-content:space-between;align-items:center;gap:24px;padding:14px 0;display:flex}' +
      '.dsh-ring-title{font-size:14px;line-height:20px}' +
      '.dsh-ring-desc{color:var(--dsw-alias-label-secondary);margin-top:4px;font-size:12px;line-height:18px}' +
      '.dsh-ring-control{display:flex;align-items:center;gap:10px;flex-shrink:0}' +
      '.dsh-ring-slider{width:180px;accent-color:var(--dsw-alias-brand-primary);cursor:pointer}' +
      '.dsh-ring-badge{min-width:40px;text-align:right;font-size:13px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}' +
      '.dsh-ring-link{font-size:12px;color:var(--dsw-alias-brand-primary);cursor:pointer;background:none;border:none;padding:0;text-decoration:underline}' +
      '.dsh-ring-warn{color:var(--dsw-alias-state-warn-primary);font-size:12px;line-height:18px}' +
      '.dsh-ring-switch{box-sizing:border-box;position:relative;flex:0 0 auto;width:36px;height:20px;padding:2px;border:0;border-radius:999px;corner-shape:round;background:var(--dsw-alias-border-l3);cursor:pointer}' +
      ".dsh-ring-switch[aria-checked='true']{background:var(--dsw-alias-brand-primary)}" +
      '.dsh-ring-switch:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}' +
      '.dsh-ring-switch-thumb{display:block;width:16px;height:16px;border-radius:50%;corner-shape:round;background:var(--dsw-alias-label-primary-foreground);transition:transform 120ms ease}' +
      ".dsh-ring-switch[aria-checked='false'] .dsh-ring-switch-thumb{background:var(--dsw-alias-switch-thumb)}" +
      ".dsh-ring-switch[aria-checked='true'] .dsh-ring-switch-thumb{transform:translateX(16px)}"
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css="dsh-ring"]') === null) {
      var tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-ring'
      tag.dataset.pluginCss = 'dsh-ring/style'
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    /* 自绘开关：语义与官方 Switch 一致（role=switch + aria-checked 驱动外观） */
    function RingSwitch(props) {
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': props.checked,
        'aria-label': props.label,
        className: 'dsh-ring-switch',
        onClick: () => props.onChange(!props.checked),
      }, h('span', { className: 'dsh-ring-switch-thumb' }))
    }

    async function request(path, body) {
      var options = { headers: { 'content-type': 'application/json' } }
      if (body !== undefined) { options.method = 'POST'; options.body = JSON.stringify(body) }
      var response = await fetch(API + path, options)
      var contentType = response.headers.get('content-type') || ''
      if (!contentType.includes('application/json')) {
        throw new Error('插件后台接口未就绪（HTTP ' + response.status + '）')
      }
      var data = null
      try { data = await response.json() } catch (error) { data = null }
      if (!response.ok) throw new Error((data && data.error) || 'HTTP ' + response.status)
      return data
    }

    function RingSettings(props) {
      var injected = props && props.injected
      var sd = React.useState(injected || null)
      var data = sd[0], setData = sd[1]
      var ns = React.useState('')
      var notice = ns[0], setNotice = ns[1]
      var rs = React.useState(0)
      var reloadKey = rs[0], setReloadKey = rs[1]
      var saveTimer = React.useRef(null)

      React.useEffect(() => { if (injected) setData(injected) }, [injected])

      /* 宿主未就绪时周期重试 /state */
      React.useEffect(() => {
        if (data) return
        var timer = setTimeout(() => setReloadKey((n) => n + 1), 2000)
        return () => clearTimeout(timer)
      }, [reloadKey, data])

      var setVolume = (value) => {
        setData((d) => d && Object.assign({}, d, { volume: value }))
        if (saveTimer.current) clearTimeout(saveTimer.current)
        saveTimer.current = setTimeout(() => {
          request('/volume', { volume: value }).catch((error) => setNotice('保存失败：' + error.message))
        }, 200)
      }
      /* 只提交开关状态；音量字段由宿主保留不动 */
      var setKindEnabled = (kind, enabled) => {
        setData((d) => {
          if (!d) return d
          var kinds = Object.assign({}, d.kinds)
          kinds[kind] = Object.assign({}, kinds[kind], { enabled: enabled })
          return Object.assign({}, d, { kinds: kinds })
        })
        request('/kind', { kind: kind, enabled: enabled }).catch((error) => setNotice('保存失败：' + error.message))
      }
      var openSounds = () => {
        request('/open-sounds', {})
          .then(() => setNotice(''))
          .catch((error) => setNotice('打开目录失败：' + error.message))
      }

      if (!data) {
        return h('div', { className: 'dsh-ring-row' },
          h('div', null,
            h('div', { className: 'dsh-ring-title' }, '提示音音量'),
            h('div', { className: 'dsh-ring-desc' }, (notice || '连接插件后台中…') + '，稍后自动重试'),
          ),
        )
      }

      var kinds = data.kinds || {}
      var kindRows = Object.keys(KIND_LABELS).map((kind) => {
        var kc = kinds[kind] || { enabled: true, volume: 100 }
        return h('div', { key: kind, className: 'dsh-ring-row' },
          h('div', null,
            h('div', { className: 'dsh-ring-title' }, KIND_LABELS[kind]),
            h('div', { className: 'dsh-ring-desc' }, KIND_DESC[kind]),
          ),
          h('div', { className: 'dsh-ring-control' },
            h(RingSwitch, {
              checked: kc.enabled,
              label: KIND_LABELS[kind] + '开关',
              onChange: (next) => setKindEnabled(kind, next),
            }),
          ),
        )
      })

      return h('div', { style: { width: '100%' } },
        h('div', { className: 'dsh-ring-row' },
          h('div', null,
            h('div', { className: 'dsh-ring-title' }, '提示音音量'),
            h('div', { className: 'dsh-ring-desc' }, '回合收尾提示音的总音量，0% 为静音'),
            notice ? h('div', { className: 'dsh-ring-warn' }, notice) : null,
          ),
          h('div', { className: 'dsh-ring-control' },
            h('input', {
              type: 'range', min: 0, max: 100, step: 1, value: data.volume,
              onChange: (e) => setVolume(Number(e.target.value)),
              className: 'dsh-ring-slider', 'aria-label': '提示音音量',
            }),
            h('span', { className: 'dsh-ring-badge' }, data.volume + '%'),
            h('button', { type: 'button', onClick: openSounds, className: 'dsh-ring-link' }, '音效目录'),
          ),
        ),
        kindRows,
      )
    }

    function apply(ctx) {
      var slots = ctx.slots || ctx.get('slots')
      if (!slots) return
      var injected = null
      request('/state')
        .then((s) => { if (s && typeof s.volume === 'number') injected = s })
        .catch(() => { injected = null })
      slots.inject('settings.general.item', () => slots.register({
        name: 'settings.general.item',
        id: 'dsh-ring-volume',
        order: 60,
        inject: () => ({ injected: injected }),
      }, RingSettings))
    }

    exports.apply = apply
    exports.inject = ['slots']
    exports.RingSettings = RingSettings
    return module.exports
  },
})
