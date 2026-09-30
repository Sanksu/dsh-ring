# dsh-ring

DeepSeek Harness 的回合分级提示音插件：agent 回合收尾时按场景播放一次提示音，纯问答保持安静，子代理不单独发声。

| 音效 | 触发场景 |
|---|---|
| `plan` | 计划模式产出了方案 |
| `done` | 本回合执行过任务类工具（`execTools` 白名单命中） |
| `ask` | 调用了 `ask_user_question`，或出现审批请求 |
| `fail` | 回合内 agent 报错 |

只在根会话发声；同类音效各有独立防抖窗口（`debounceMs`）。

## 设置界面

配置项都在 **设置 → 通用**，改完即时生效，共两行：

**提示音音量**

- 总音量滑块（0% = 静音）+ 当前百分比
- `音效目录`：一键在资源管理器中打开自定义音效目录

**提示音场景**

- 四个胶囊（`计划` / `完成` / `回应` / `出错`），**高亮 = 启用**，点击切换
- 停用后该类音效连播放调用都不发起；胶囊悬浮提示给出全称（如"计划出方案"）与当前状态

两行都遵循官方 General 行的排版（左标题/描述 + 右控件，行间 0.5px 分隔），胶囊使用官方 `@deepseek-ai/dsh-client-ui-primitives` 的 `Pill` 组件。

## 安装

在 profile 的 `package.json` 中声明后重启 DSH：

```json
{ "dependencies": { "dsh-ring": "https://codeload.github.com/Sanksu/dsh-ring/tar.gz/refs/heads/main" } }
```

## 配置（cordis.yml / 用户 patch 层）

```yaml
plugins:
  dsh-ring:
    enabled: true       # 总开关
    volume: 100         # 初始总音量；界面滑块调过的值优先（见下方持久化）
    debounceMs: 2500    # 同类音效最小间隔（毫秒）
    soundDir: ""        # 自定义音效目录；留空则按下方查找顺序
    execTools: []       # 执行类工具白名单；空数组 = 所有工具都算作"执行了任务"
```

`execTools` 默认是内置白名单：`pwsh`、`bash`、`write`、`edit`、`run_code`、`str-replace-editor`、`task`、`subagent`、`subagent_fork`、`workflow`、`ralph`、`job_kill`、`create_goal`、`update_goal`、`todo_write`、`cordis_*`。只读工具（`read` / `grep` / `glob` / `web_search` 等）不计入，因此"查个文件就答"不会响。

## 自定义音效

把 `plan.wav / done.wav / ask.wav / fail.wav` 放到下列任一处即可覆盖内置音效：

1. `soundDir` 配置的目录
2. **`~/.dsh/dsh-ring/sounds/`** ← 推荐，设置页「音效目录」按钮直达
3. 工作区根目录
4. 包内自带（`sounds/`）
5. 系统音兜底

第 2 项在 `node_modules` 之外，**插件更新/重装不会丢失**。

要求：**PCM WAV**（8 或 16-bit；24kHz/32kHz/44.1kHz 均可）。音量调节靠重缩放 PCM 采样实现，非 PCM（如 MP3 转存）会退回原始音量播放。

## 状态持久化

`~/.dsh/dsh-ring/volume.json`（v2）：

```json
{
  "version": 2,
  "volume": 70,
  "kinds": { "plan": { "enabled": true, "volume": 100 }, "done": { "enabled": true, "volume": 100 } }
}
```

- `volume`：总音量；`kinds[kind].enabled`：场景开关
- 有效音量 = 总音量 × 场景音量（场景音量当前固定 100%，界面不暴露）
- v1 旧文件（只有顶层 `volume`）自动迁移，全局音量保留
- 该文件是唯一数据源；未写入过时回退到配置里的 `volume`

## 实现

- **触发**：`agent/turn-stopping` 收尾判定（优先 `planMode` 服务，不可用时折叠会话事件流）+ `tools/execute`（`ask_user_question`）+ `approval/request` + `agent/error`
- **播放**：Windows PowerShell `SoundPlayer`、macOS `afplay`、Linux `paplay`/`aplay`
- **音量**：直接缩放 WAV 的 PCM 采样（16/8-bit，含 `WAVE_FORMAT_EXTENSIBLE` 包装），结果按音量缓存到系统临时目录，不改系统音量、不依赖 ffmpeg
- **设置桥**：环回路由 `/ring/api/state`（GET）、`/ring/api/volume`（POST）、`/ring/api/kind`（POST）、`/ring/api/open-sounds`（POST）；`webServer` 延迟注入，因此没有 web 载体的部署也不影响提示音本身
- **打开音效目录**：与官方 `dsh-native-command` 同法——Windows 把 `file://` URI 交给 `explorer.exe`（容忍委派给已运行实例后的 `exit 1`），用 `node:child_process` 直接启动；DSH 的 `subprocess` sandbox seam 起的 GUI 进程无法完成该委派
- **客户端**：以 `settings.general.item` 插槽注册（`order: 60`）；场景胶囊用官方 primitives 的 `Pill`，行样式复刻官方 General 行
- **模块依赖**：manifest `dsh.client.inject` 声明 `@deepseek-ai/dsh-client-ui-slots` 与 `@deepseek-ai/dsh-client-ui-primitives`。注意包名只能写在这里（模块图顺序）；bundle 内的 `exports.inject` 是 cordis **服务名**清单，写包名会让该 entry 永远 pending、拖垮 web boot

## 兼容性

在 DSH `0.2.0-rc.2` 实测；客户端依赖 `@deepseek-ai/dsh-client-ui-slots` 与 `@deepseek-ai/dsh-client-ui-primitives`。

## 致谢

内置音效来自 [Kenney "Interface Sounds"](https://kenney.nl/assets/interface-sounds)（CC0，无署名义务，此处仍致谢）：plan=maximize_001，done=confirmation_001，ask=question_001，fail=error_004（已转 44.1kHz 单声道 16-bit PCM）。播放与音量缩放机制参考 [dsh-perlica-ding](https://www.npmjs.com/package/dsh-perlica-ding)（MIT）。
