/**
 * dsh-ring — client half.
 *
 * 「设置 → 通用」注册两行配置：
 *   1) 提示音音量：滑块 + 百分比 + 音效目录按钮
 *   2) 提示音场景：四个原生 Pill 胶囊（计划/完成/回应/出错），选中=启用
 * 控件来自 @deepseek-ai/dsh-client-ui-primitives（Pill），行样式复刻官方 General 行。
 *
 * 注意：包名写进 manifest 的 dsh.client.inject（模块图依赖），**不能**写进本文件的
 * exports.inject —— 那是 cordis 服务名清单，写包名会让 entry 永远 pending 拖垮 web boot。
 */
window.__ModuleLoader__.load({
  id: 'dsh-ring',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var React = require('react')
    var primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    var Pill = primitives.Pill
    var h = React.createElement

    var API = '/ring/api'
    /* 胶囊短标签 + 悬浮/无障碍用全称 */
    var KINDS = [
      { id: 'plan', chip: '计划', full: '计划出方案' },
      { id: 'done', chip: '完成', full: '任务完成' },
      { id: 'ask', chip: '回应', full: '需要你回应' },
      { id: 'fail', chip: '出错', full: '执行出错' },
    ]

    var CSS = '.dsh-ring-row{border-bottom:.5px solid var(--dsw-alias-border-l2);justify-content:space-between;align-items:center;gap:24px;padding:14px 0;display:flex}' +
      '.dsh-ring-title{font-size:14px;line-height:20px}' +
      '.dsh-ring-desc{color:var(--dsw-alias-label-secondary);margin-top:4px;font-size:12px;line-height:18px}' +
      '.dsh-ring-control{display:flex;align-items:center;gap:10px;flex-shrink:0}' +
      '.dsh-ring-chips{display:flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:flex-end}' +
      '.dsh-ring-slider{width:160px;accent-color:var(--dsw-alias-brand-primary);cursor:pointer}' +
      '.dsh-ring-badge{min-width:40px;text-align:right;font-size:13px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}' +
      '.dsh-ring-link{font-size:12px;color:var(--dsw-alias-brand-primary);cursor:pointer;background:none;border:none;padding:0;text-decoration:underline}' +
      '.dsh-ring-warn{color:var(--dsw-alias-state-warn-primary);font-size:12px;line-height:18px}'
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css="dsh-ring"]') === null) {
      var tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-ring'
      tag.dataset.pluginCss = 'dsh-ring/style'
      tag.textContent = CSS
      document.head.appendChild(tag)
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
            h('div', { className: 'dsh-ring-title' }, '提示音'),
            h('div', { className: 'dsh-ring-desc' }, (notice || '连接插件后台中…') + '，稍后自动重试'),
          ),
        )
      }

      var kinds = data.kinds || {}
      var chips = KINDS.map((item) => {
        var enabled = (kinds[item.id] || {}).enabled !== false
        return h(Pill, {
          key: item.id,
          active: enabled,
          title: item.full + (enabled ? '：已启用，点击停用' : '：已停用，点击启用'),
          'aria-pressed': enabled,
          onClick: () => setKindEnabled(item.id, !enabled),
        }, item.chip)
      })

      return h('div', { style: { width: '100%' } },
        /* 第 1 行：总音量 */
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
        /* 第 2 行：场景开关（胶囊组） */
        h('div', { className: 'dsh-ring-row' },
          h('div', null,
            h('div', { className: 'dsh-ring-title' }, '提示音场景'),
            h('div', { className: 'dsh-ring-desc' }, '点击切换：高亮=启用该类提示音'),
          ),
          h('div', { className: 'dsh-ring-chips' }, chips),
        ),
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
        id: 'dsh-ring-settings',
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
