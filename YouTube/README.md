# YouTube Local for Surge

基于 Maasea YouTube Enhance 的协议字段与行为研究，以可阅读的 JavaScript 重新实现。所有响应处理都在 Surge 本地执行，模块只从本仓库下载两个 JS 文件；没有运行时依赖、混淆代码、第三方 Worker、网络调用或播放密钥存储。

这是独立实现，并非原模块完整等效的重新托管版。尤其是加密 Onesie/UMP 链路只尝试回退，不实现原作者 Worker 的解密和流处理。尚未在真实 YouTube / YouTube Music 客户端上验证去广告和播放兼容性。

## 安装

在 Surge 中添加远程模块：

```text
https://raw.githubusercontent.com/nickcxm/script/main/YouTube/YouTube.Local.sgmodule
```

1. 关闭其他 YouTube 响应修改模块，包括 Maasea Enhance 和 Aioneas 去广告模块。Surge 每个响应只运行第一个匹配的响应脚本，多个模块不会顺序叠加。
2. 启用 MITM 并安装、信任 Surge 证书。模块追加 `youtubei.googleapis.com` 和 `*.googlevideo.com`。
3. 根据需要设置参数。要隐藏 Shorts，请将“屏蔽Shorts按钮”改成 `true`；它同时过滤已识别的 Shorts 卡片／专区。
4. 完全退出并重新打开 YouTube，分别检查首页、搜索、长视频播放和字幕。已有缓存 UI 可能暂时不变。

## 参数

| 参数 | 默认 | 行为 |
| --- | --- | --- |
| 屏蔽上传按钮 | `true` | 移除导航项 `FEuploads` |
| 屏蔽选段按钮 | `true` | 移除导航项 `FEmusic_immersive`，主要涉及 YouTube Music |
| 屏蔽Shorts按钮 | `false` | 开启后移除 `FEshorts` 入口、已识别 Shorts 布局及 reel 专区；不保证所有 UI 场景均可隐藏 |
| 字幕翻译语言 | `off` | 如 `zh-Hans` / `zh-Hant` / `en`；使用原字幕 URL 的 `tlang` 参数，翻译由 YouTube 字幕接口提供 |
| 启用后台与画中画 | `true` | 修改播放器能力字段和对应设置 UI；能否使用仍取决于客户端、系统和服务端 |
| 启用播放回退 | `true` | 对 `googlevideo.com/initplayback` 的 `ack` 请求返回本地空响应，尝试让客户端回退到 `player/get_watch` |
| 启用调试模式 | `false` | 仅输出路由、响应字节数或解析错误类别；不记录完整 URL、正文、凭证或密钥 |

播放器广告清理、信息流广告清理、Shorts 流中的广告条目清理及 Premium 推广入口移除默认执行。

## 实现和数据处理

- `youtube.response.js`：轻量 Protobuf 读取器、协议字段表和所有响应修改。覆盖 `browse`、`next`、`player`、`search`、`reel/reel_watch_sequence`、`guide`、`account/get_setting` 和 `get_watch`。
- `youtube.request.js`：只处理指定 `initplayback` 请求的本地回退。请求无需正文，不收集播放密钥，不转发请求，不处理 `log_event`。
- 不调用 `$httpClient`、`fetch`、`$persistentStore` 或通知 API；不包含 `eval`、动态脚本加载或其他作者的脚本 URL。
- 对认识的消息字段按明确协议结构解析；其他字段保留原始字节，包括大整数和未识别的二进制内容。不会猜测任意字节串都是嵌套消息。
- 限制单个响应为 16 MiB、嵌套深度为 64、总字段数为 200000。未知线格式、损坏响应、无效参数或超出限制时放行原响应。
- 不缓存“某个字段号总是广告”这类分类，避免同一字段号的正常内容被后续误删。
- 信息流的 `pagead` 识别继承了原脚本的启发式：仅检查特定位置且至少 1000 字节的未知载荷。这不是完美分类器，仍可能漏删或误删。

## 与原模块的差异

| 项目 | Maasea 当前版本 | 本实现 |
| --- | --- | --- |
| 加密播放 | 采集 Onesie 配置中的密钥；条件满足时转发到作者 Worker | 不采集密钥；仅使用本地回退策略 |
| `config` / `log_event` | 响应中缓存密钥，请求侧修改相关头 | 不拦截这两个接口，也不修改它们的头 |
| Shorts 内容 | 信息流过滤含独立于 `blockShorts` 的 Shorts 判定 | 入口和已识别卡片均受 Shorts 开关控制 |
| 广告分类缓存 | 使用持久化字段号／布局分类 | 每次按当前载荷判断，不持久化 |
| 字幕 | 修改翻译轨道及支持语言列表 | 独立创建 `@Local` 轨道，保留原支持语言并追加缺少的语言 |
| 重复处理 | 部分设置会再次追加 | 设置和翻译轨道避免重复追加 |
| 响应上限 | `max-size=-1` | 16 MiB；超出时跳过修改 |

后台、画中画和下载设置中的布尔字段只是客户端 UI 能力标志；本实现不获取订阅，也不承诺下载授权、后台播放或画中画必定可用。

## 兼容性验证与排查

代码测试不能证明实际去广告率或当前客户端一定接受播放回退。

安装后建议验证：首页与搜索正常加载；多个长视频可以开始播放、拖动和连续播放；Shorts 开关符合预期；字幕语言可选；后台／画中画符合设备能力。YouTube Music 应另外验证。

若视频无法加载，先关闭“启用播放回退”并重启应用。关闭后，加密播放响应可能绕过本模块的广告过滤。若仍异常，停用模块并检查 Surge 请求记录；可开启调试获得路由与错误类别，但无需公开凭证或原始播放密钥。

## 开发验证

无需安装 npm 依赖：

```sh
node --check YouTube/youtube.response.js
node --check YouTube/youtube.request.js
node --test YouTube/tests/local.test.cjs
```

测试覆盖字段保留、广告清理、Shorts、字幕、设置幂等、异常放行、请求作用域，以及 `.sgmodule` 的正则与参数渲染。通过 VM 沙箱禁用网络和持久化，验证两个脚本均能调用 `$done` 完成。

开发时还使用审查版本的原始编解码器和处理函数进行了 17 项离线交叉检查，覆盖播放器、导航开关组合、Shorts 广告、设置、嵌套播放、首页／搜索过滤和字幕协议字段。原始打包脚本和一次性对照脚本不随本模块发布。

## 审查来源与许可

详见 [AUDIT.md](AUDIT.md) 与 [NOTICE](NOTICE)。本目录以 Apache-2.0 发布，许可范围仅为本目录，不改变仓库其他文件的许可。

Surge 官方接口文档：[HTTP Response](https://manual.nssurge.com/scripting/http-response.html)、[HTTP Request](https://manual.nssurge.com/scripting/http-request.html)。
