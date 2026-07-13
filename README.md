# YouTube 双语字幕

在 YouTube 上同时显示**原文 + 译文**字幕的浏览器扩展（Chrome / Safari Web Extension 兼容）。

> 当前版本：`0.2.0`。已实现双轨 timedtext 拉取、时间对齐与播放器内双语叠放（Phase 1 + Phase 2 核心）。

## 当前能力

- 从播放器读取 `captionTracks`（主世界桥接 `page-bridge.js`，DOM 解析兜底）
- 按 popup 的原语言 / 目标语言选轨；无独立译轨时对原文轨加 `tlang=` 请求翻译
- 拉取 `fmt=json3` timedtext，按时间重叠 / 最近邻（约 400ms）对齐
- 在播放器内叠放 `#yt-bilingual-overlay`（原文一行、译文一行），`requestAnimationFrame` 跟 `video.currentTime`
- 启用双语时弱化原生单语字幕，避免叠字
- 尊重「启用」开关、调试标记；`chrome.storage` 变更热更新
- SPA 换视频：`yt-navigate-finish` / `history` / URL MutationObserver 重载

## 目录结构

```
safari插件/
├── manifest.json                 # MV3，含 web_accessible_resources（page-bridge）
├── background/
│   └── service-worker.js         # 设置默认值、消息中转
├── content/
│   ├── youtube-bilingual.js      # 双语引擎（选轨 / 拉取 / 对齐 / 渲染）
│   ├── page-bridge.js            # 注入主世界，读取 player response
│   └── youtube-bilingual.css
├── popup/
│   ├── popup.html
│   ├── popup.css
│   └── popup.js
├── icons/
│   ├── generate-icons.py
│   └── icon{16,32,48,128}.png
└── README.md
```

## 在 Chrome 中加载测试

1. 打开 `chrome://extensions`
2. 开启「开发者模式」
3. 「加载已解压的扩展程序」→ 选择本目录（含 `manifest.json`）
4. 打开带 CC 的视频，例如：https://www.youtube.com/watch?v=jNQXAC9IVRw
5. 在播放器底部附近应看到**两行字幕**（原文 + 译文）；原生单语字幕会被弱化
6. 右上角调试条（可关）显示加载状态，例如「双语就绪 · N 条」
7. 打开扩展 popup：切换语言 / 关闭启用，页面应热更新
8. DevTools Console 可搜 `[yt-bilingual]` 查看轨列表与对齐条数

建议验证：

- [ ] 有人工英文字幕的视频：英文 + 简中
- [ ] 仅有自动生成（asr）字幕的视频
- [ ] 无目标语言独立轨时，仍能通过翻译出中文
- [ ] 站内点另一个视频（不整页刷新）后双语重载
- [ ] 关闭「启用插件」后叠放消失、原生字幕恢复

## 在 Safari 中加载调试（macOS）

Safari 使用 **Web Extension**；可用 Apple 转换工具从本目录生成 Xcode 工程：

```bash
xcrun safari-web-extension-converter "/Users/taoma/Documents/safari插件" \
  --project-location "/Users/taoma/Documents" \
  --app-name "YouTubeBilingualCaptions" \
  --bundle-identifier "com.example.yt-bilingual-captions"
```

然后：

1. 用 Xcode 打开生成的工程并 Run（会安装宿主 App）
2. Safari → 设置 → 扩展 → 启用「YouTube 双语字幕」
3. 开发菜单中允许未签名扩展（若需要）
4. 打开 YouTube 验证双语叠放与调试标记

> 若曾转换过旧版，请重新 converter 一次以带上 `page-bridge.js` 与新的 `web_accessible_resources`。

## 技术要点

| 模块 | 说明 |
|------|------|
| `page-bridge.js` | 主世界读取 `getPlayerResponse()` / `ytInitialPlayerResponse` |
| `fetchTimedText` | `baseUrl` + `fmt=json3`（可选 `tlang`） |
| `alignCues` | 重叠优先，否则中点距离 ≤ 400ms |
| Overlay | 挂在 `.html5-video-player`，不依赖原生字幕是否已开启 |

## 已知限制

- 依赖 YouTube 非公开 timedtext / player 结构，站点改版可能导致失效
- 直播、部分会员/版权限制、完全无字幕视频：降级为空，不崩溃
- 广告时段可能短暂无对应字幕或错位
- ASR 与翻译轨切分不一致时，个别句子对齐可能偏移
- Popup 语言列表仍为固定选项，尚未按当前视频 `captionTracks` 动态填充
- 未在本环境对真实 YouTube 页面做端到端实测；请按上文清单手动验证

## 后续可选

- Popup 根据当前视频轨列表动态填充语言
- 字体大小 / 位置 / 透明度设置
- 广告检测后主动隐藏 overlay
- Background 代理 timedtext（若遇个别环境下的网络限制）
