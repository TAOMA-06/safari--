# YouTube 双语字幕

> 在 YouTube 播放器中同时显示原文和译文字幕的浏览器扩展。

[![Version](https://img.shields.io/badge/version-0.3.0-2d8a4e)](./manifest.json)
[![Chrome](https://img.shields.io/badge/Chrome-tested-4285F4?logo=googlechrome&logoColor=white)](#chrome-%E5%AE%89%E8%A3%85)
[![Safari](https://img.shields.io/badge/Safari-Web%20Extension-006CFF?logo=safari&logoColor=white)](#safari-%E8%B0%83%E8%AF%95)

YouTube 双语字幕会自动读取当前视频的字幕轨道，将原文与目标语言按时间对齐，然后以两行字幕叠放在播放器中。如果视频没有独立译文轨，扩展会尝试使用 YouTube 自带的翻译能力。

## 功能亮点

- 同时显示英文原文和简体中文译文
- 支持人工字幕和自动生成字幕
- 无独立译轨时自动使用 `tlang` 翻译
- 按时间重叠和最近时间点对齐双轨字幕
- 广告期间等待主视频授权，广告结束后自动加载
- 支持 YouTube 站内切换视频，无需整页刷新
- 语言和开关修改后立即热更新
- 兼容 Chrome Manifest V3 和 Safari Web Extension

## 界面说明

点击浏览器工具栏中的扩展图标，可以设置：

| 选项 | 作用 |
| --- | --- |
| 启用插件 | 显示或关闭双语字幕 |
| 调试标记 | 在页面右上角显示轨道加载状态和字幕数量 |
| 原语言 | 选择原文字幕语言，默认为 English |
| 目标语言 | 选择译文语言，默认为简体中文 |

播放器中的显示顺序为：

```text
Original English subtitle
简体中文译文
```

## Chrome 安装

1. 下载或克隆本项目。
2. 在 Chrome 地址栏输入 `chrome://extensions/`。
3. 开启右上角的「开发者模式」。
4. 点击「加载已解压的扩展程序」。
5. 选择包含 `manifest.json` 的项目根目录。
6. 打开一个带字幕的 YouTube 视频。

扩展会默认以「English → 简体中文」显示双语字幕。

## Safari 调试

Safari 需要先将源码转换为 Safari Web Extension Xcode 工程：

```bash
xcrun safari-web-extension-converter "/path/to/youtube-bilingual-captions" \
  --project-location "/path/to/output" \
  --app-name "YouTubeBilingualCaptions" \
  --bundle-identifier "com.example.yt-bilingual-captions"
```

然后在 Xcode 中运行生成的宿主 App，并前往 Safari 「设置 → 扩展」启用扩展。

## 实测状态

`0.3.0` 已在 Chrome 中使用真实 YouTube 播放页验证：

- 测试视频：`But what is a neural network? | Deep learning chapter 1`
- 识别并对齐 286 条字幕
- 英文原文与简体中文同时显示
- 广告结束后可自动加载字幕
- 调试标记开启时页面保持流畅

## 工作原理

1. `page-bridge.js` 在 YouTube 页面主世界中读取播放器响应和字幕轨道。
2. 复用 YouTube 播放器生成的 Proof-of-Origin Token，请求 timedtext 字幕。
3. 优先解析 JSON3，失败时回退到 WebVTT。
4. 将原文和译文按时间区间重叠或最近中点对齐。
5. 根据 `video.currentTime` 在播放器内渲染双行字幕。

## 隐私

扩展不需要服务器，不上传观看记录或字幕内容。语言和开关设置仅保存在浏览器的扩展存储中。

## 项目结构

```text
.
├── manifest.json
├── background/
│   └── service-worker.js
├── content/
│   ├── page-bridge.js
│   ├── youtube-bilingual.js
│   └── youtube-bilingual.css
├── popup/
│   ├── popup.html
│   ├── popup.css
│   └── popup.js
└── icons/
```

## 已知限制

- 依赖 YouTube 的播放器和 timedtext 内部接口，站点改版后可能需要更新。
- 无字幕、直播、会员限制或版权限制视频可能无法显示双语字幕。
- 自动字幕和翻译轨切分方式不同时，少数句子可能有轻微时间偏差。
- Safari 版本需要使用 Xcode 转换、签名和安装。

## 开发检查

```bash
node --check content/youtube-bilingual.js
node --check content/page-bridge.js
node --check background/service-worker.js
node --check popup/popup.js
```
