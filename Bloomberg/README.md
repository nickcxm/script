# Bloomberg 文章中英对照 — Surge 实验模块

根据用户提供的真实 HAR 中的文章详情 JSON 编写。只处理：

```text
GET https://cdn-mobapi.bloomberg.com/wssmobile/v1/stories/<14位大写字母或数字的文章ID>
```

这是针对一个接口族的实验版，不处理首页列表、搜索、`stories/find`、`mobapi.bloomberg.com`、网页文章、视频或 Professional/Anywhere 的其他接口。需要在真实 iOS App 中验证译文是否按预期渲染。

## 安装

在 Surge 中添加远程模块：

```text
https://raw.githubusercontent.com/nickcxm/script/main/Bloomberg/Bloomberg.Translate.sgmodule
```

启用 MITM 并信任 Surge 证书，模块仅追加 `cdn-mobapi.bloomberg.com`。不需要给 Google 翻译域名开启 MITM。

若其他响应脚本也匹配同一接口，需要关闭或调整它们：Surge 每个响应只运行第一个匹配的响应脚本。

重新打开一篇文章以触发请求。已缓存或离线的文章可能不会发起网络请求；本模块不会主动重新请求文章，也不会主动删除 App 缓存。

## 显示方式

保留原来的 `role: "p"` 段落及其全部 `parts`、链接、证券字段，在后面追加一个普通正文组件：

```json
{
  "role": "p",
  "_nickcxmTranslation": true,
  "parts": [
    { "role": "text", "text": "这里是上一段的中文翻译。" }
  ]
}
```

提取时只递归 `parts` 树。某些 anchor 同时包含 `text` 与嵌套 `parts`，以嵌套文字为准，避免重复。对整段翻译，保持上下文；新中文段落是纯文本，不复制英文链接位置。

标题、摘要、作者、图片说明、嵌入 HTML、链接 URL、行情和证券元数据均不翻译。图片、相关阅读和未知组件保留。

译文直接显示中文，不附加“中文译文”文字。新增段落使用不显示在正文中的 `_nickcxmTranslation` 元数据标记避免重复追加；旧版本带标签的译文也可识别并去掉标签。相同正文在同一次请求内只翻译一次。

## 参数

| 参数 | 默认 | 行为 |
| --- | --- | --- |
| 启用翻译 | `true` | 关闭后直接放行原响应，包括广告配置 |
| 去除广告配置 | `true` | 删除 `adParams`，并在已有布尔 `disableAds` 字段为 false 时设为 true |
| 调试日志 | `false` | 仅输出段落成功/失败数量等统计，不输出正文、URL或凭证 |

HAR 样本中没有明确的广告组件；其中 `webview` 是相关阅读，因此保留。删除广告配置是有限的广告处理尝试，不保证客户端或其他接口的广告完全消失。

## 翻译服务与隐私

固定使用无需 API key 的 Google 端点：

```text
https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh-CN&dt=t&q=...
```

该端点也被 DualSubs 的 Google 翻译实现使用，但它不是有稳定性承诺的 Google Cloud Translation 正式接口，可能限流、改变或停止服务。

- Google 会收到英文正文段落及普通网络连接信息。这不是离线翻译。
- 发出的请求仅从正文构造 `q` 和固定的语言参数；不转发 Bloomberg 的 Cookie、Authorization、设备标识、文章 URL、证券元数据或 HAR 请求头。
- 新请求显式设置独立请求头，关闭自动重定向与自动 Cookie 处理。相关选项在 Surge iOS 5.9.0+ / Mac 5.5.0+ 支持；建议使用当前版本。
- 不使用第三方 Worker、API key、持久化缓存或动态代码加载。
- 脚本自身不记录正文，但 Google 请求含 `q` 查询参数，因此 Surge 请求查看器中可能显示待翻译文本；不要将完整请求记录公开分享。
- 源码、测试和说明不包含原始 HAR/PCAP、真实文章样本或用户凭证。

## 超时和兼容性

最多同时请求 3 段；长段落拆为最多 1200 Unicode 字符的片段，每次处理最多 48 个翻译请求。全局翻译预算 45 秒，单次请求最多 7 秒，模块脚本超时 60 秒。后续超出预算或失败的段落保留英文。长段落中任一片段失败时，该段不追加残缺译文。

翻译会延迟文章响应交付；没有跨请求缓存，每次真正获取文章都可能再次翻译。当前机制无法在 App 已显示原文后后台插入译文，第一次显示必须等待翻译完成。

仅处理 HTTP 200 的 JSON。304、非 JSON、结构不符、参数错误及解析失败直接放行。若所有翻译失败但去广告配置开启，仍可能只清理广告配置。

修改响应时移除过期的压缩/长度字段和 ETag 等校验字段，并设置 `Cache-Control: no-store`，避免沿用原响应的缓存校验；这不保证 App 自己不缓存正文。

机器翻译可能误译金融术语、币种或数字含义。保留英文便于对照。

## 验证记录

2026-10-09：

- 22 项自动测试通过：原结构保留、完整段落合并、旧标签迁移、嵌套链接去重、段落追加、幂等、局部失败、并发/请求数量限制、超时、限流、请求隔离以及模块参数和正则。
- 使用 HAR 的响应 JSON，在 Node VM 中运行完整 Surge 脚本，并将 `$httpClient` 适配为真实 HTTPS 请求。
- 真实 Google 测试：20/20 段翻译成功，20 次请求，耗时约 4.9 秒；组件从 23 个变为 43 个，原有 23 个组件深度比较一致。
- 没有在这次测试中请求 Bloomberg，也没有发送 HAR 请求头或 Cookie。
- 尚未在 iOS App 内确认新增段落的显示效果和加载体验。

运行测试不需要 npm 依赖：

```sh
node --check Bloomberg/bloomberg.response.js
node --test Bloomberg/tests/translate.test.cjs
```

参考：[Surge HTTP Response](https://manual.nssurge.com/scripting/http-response.html)、[Surge JS API](https://manual.nssurge.com/scripting/api.html)、[DualSubs Google 翻译实现](https://github.com/DualSubs/Universal/blob/main/src/class/Translate.mjs)。本脚本为独立实现，没有复制或打包 DualSubs 代码。
