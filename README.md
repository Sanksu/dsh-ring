# dsh-ring

DeepSeek Harness 回合分级提示音插件（精简重写版）。

agent 回合收尾时按场景播放一次提示音：计划出方案 / 任务完成 / 需要你回应 / 出错；纯问答静音，子代理不响。音量滑块在 **设置 → 通用** 里，拖动即存即生效。

## 安装

在 profile 的 `package.json` 中声明后重启 DSH：

```json
{ "dependencies": { "dsh-ring": "https://codeload.github.com/Sanksu/dsh-ring/tar.gz/refs/heads/main" } }
```

## 配置（cordis.yml / patch 层）

```yaml
plugins:
  dsh-ring:
    enabled: true       # 总开关
    volume: 100         # 初始音量（滑块设置优先，持久化在 ~/.dsh/dsh-ring/volume.json）
    debounceMs: 2500    # 同类音效最小间隔
    soundDir: ""        # 自定义音效目录；留空则 依次找 工作区 → 包内 → 系统音
    execTools: []       # 执行类工具白名单；空数组 = 所有工具都算
```

换音效：把 `plan.wav / done.wav / ask.wav / fail.wav`（PCM WAV）放进 `~/.dsh/dsh-ring/sounds/`（设置页「打开音效目录」直达）即覆盖内置音效；该目录在 node_modules 之外，**插件更新不会丢失**。也支持 `soundDir` 配置或工作区根目录。

## 实现

- 触发：`agent/turn-stopping` 收尾判定（planMode 服务，兜底折叠会话事件流）+ `tools/execute`（ask_user_question）与 `approval/request`（ask）+ `agent/error`（fail）
- 播放：Windows PowerShell SoundPlayer / macOS afplay / Linux paplay，音量经 PCM 采样缩放实现（零依赖），结果按音量缓存于系统临时目录
- 设置桥：`/ring/api/state`（GET）、`/ring/api/volume`（POST）、`/ring/api/open-sounds`（POST）环回路由，webServer 延迟注入，无 web 载体的部署不影响提示音
- 打开音效目录：与官方 `dsh-native-command` 同法——Windows 交给 explorer.exe 一个 file:// URI（容忍委派后的 exit 1），用 node:child_process 直接启动，不经过 subprocess 沙箱 seam

## 致谢

音效来自 [Kenney "Interface Sounds"](https://kenney.nl/assets/interface-sounds)（CC0，无署名义务，此处仍致谢）：plan=maximize_001，done=confirmation_001，ask=question_001，fail=error_004（44.1kHz 单声道 16-bit PCM）。播放机制参考 [dsh-perlica-ding](https://www.npmjs.com/package/dsh-perlica-ding)（MIT）。
