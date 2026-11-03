# magpie-doubao-desktop

magpie / OpenCode 的 provider 插件：用**本机「豆包工作」桌面端已有的登录**来跑豆包对话。
不装 Docker，不抓包，不用从 DevTools 里粘 Cookie——点一下登录就好。

> ⚠️ **先看清这个再决定要不要用**
>
> 豆包（doubao.com）没有对外的第三方授权接口。这个插件走的是桌面端自己那份登录态，
> 直接调它的私有接口。magpie 官方仓库的维护者明确评估过并拒绝收录这类插件，理由是
> **这违反字节的服务条款，也可能让账号被风控**。原话（PR #548 的 review）：
>
> > doubao.com 没有官方第三方接入路径，它的网页聊天有 bot 检测，用拷贝出来的浏览器
> > 会话去驱动它违反 ByteDance 的条款，并让用户账号有风险。我们不接受用这种方式接
> > 消费级聊天产品的插件。
>
> 所以这个包**只适合自己用**。被封号、被限流、哪天接口改了直接失效，都是自己要承担的。
> 想要稳的、能商用的，走官方：**火山方舟（Volcengine Ark）**，magpie 内置就有——
> `magpie provider add volcengine <key>`。

## 装

```sh
magpie plugin add github:zyf2492313716-cloud/magpie-doubao-desktop
magpie plugin login doubao-free          # 选「使用本机豆包工作的登录」
```

前提：本机装了「豆包工作」（DoubaoWork）并且已经登录。目前只在 macOS 上读过那份登录。

## 它做了什么

- 读 `~/Library/Application Support/DoubaoWork/Default/Cookies`：**复制一份出来读，读完删掉**，
  不写它、不改它、不删它的原文件。
- Cookie 的密钥来自这个应用自己的钥匙串条目 `DoubaoWork Browser Safe Storage`，
  按 Chromium 那套 PBKDF2 + AES-128-CBC 解出来。第一次会弹一次系统授权框。
- 对话：`POST /samantha/thread/create` 开一个会话，`POST /chat/completion` 发一条，SSE 收。
  带着这份登录去调，**不需要算签名**。

## 模型

下面三个是从豆包工作自己缓存的配置里读出来的（`Default/Preferences` →
`frontend-request-cache` → `modeSelectData`），不是我编的名字：

| id | 名称 | 应用里的 model_item_key | 窗口 |
|---|---|---|---|
| `auto` | 自动 · 豆包 | `9` | 256k |
| `doubao-2.1-pro` | 豆包 2.1 Pro | `5` | 256k |
| `doubao-2.1-lite` | 豆包 2.1 Lite | `seed-lite-7b` | 256k |

`reasoningEffort` 会按应用自己的写法放进 `ext.reasoning_effort`（3 低 / 4 中 / 5 高，默认 5）。

**没验证的部分要说清楚**：`model_item_key` 是照桌面端的方式发过去的，但我没法证实
服务端真的换了模型——问它「你是什么型号」，三个都拒绝透露，措辞不同也说明不了什么。
256k 是应用自己标的 `total_window_size`，不是我测出来的上限。

**没有独立的思考通道。** 让它「展示推理」，回来的是 527 个增量、全部落在
`patch_object: 102` 的 `content.text_block` 里，没有任何一条单独的 reasoning 流。
所以三个模型都声明 `reasoning: false`——写 true 只会让 magpie 给你一个永远空着的
thinking 面板，推理其实就在正文里。`reasoningEffort` 仍然照应用自己的写法发过去
（3 低 / 4 中 / 5 高），但它只影响回答本身，不会多出一种输出。

**没验证的部分要说清楚**：`model_item_key` 是照桌面端的方式发过去的，但我没法证实
服务端真的换了模型——问它「你是什么型号」，三个都拒绝透露，措辞不同也说明不了什么。
256k 是应用自己标的 `total_window_size`，不是我测出来的上限。

## 上下文是自己带过去的

豆包的历史存在服务端，但**从这里发的请求它不给加载**。同一个会话连着问两轮，
第二轮完全不记得第一轮——试过的都不行：新建会话、用已有的 `conversation_type: 1`
会话、回传 ack 里的 `section_id` 和 `message_index`、固定 `unique_key`。

所以插件把之前的轮次拼成一段文字一起发过去（系统提示词不带，那是 harness 自己的
东西，每轮付一遍不划算）。测试里就查这个：连着两轮，第二轮必须记得第一轮的暗号。

## 一个已经踩过的坑：harness 自己塞进来的那段话

DSH / OpenCode 这类 harness 会把自己的状态（当前时间、浏览器时区、注入的提醒）
**作为额外的一条 user 消息**追加在末尾。一开始我把「回答用户最后一条消息」照原样
发过去，结果用户发了张截图问「帮我下载这里面的课程 ppt」，豆包回的是：

> It seems you've provided some time-related technical information, including the sampled time…

——它老老实实回答了那段时钟文本，因为那才是「最后一条消息」，而图片根本没送到它手上。

现在 `mergeTurns()` 会把 harness 那几块（`Current runtime context.` /
`Time sampled while preparing turn…` / `Browser time zone…` / `<system-reminder>`）
从消息里剔掉，连续的同一方消息合并成一条，剔完如果结尾落在助手身上就退回上一条
真正的用户提问。测试里 `a harness's own context never becomes the question` 就是钉这个的。

**这是尽力而为的**：匹配的是本机几个 harness 实际发出来的形状，换个 harness 用别的
写法就可能漏。

## 工具调用：在插件层模拟出来的

豆包的聊天接口没有工具协议——只收文字、只回文字。但它**认提示词协议**：实测给它
一段工具说明加一句「要调用就输出一行 `TOOL_CALL {json} END_CALL`」，它吐出来的
就是格式严整的调用；把结果喂回去，它照着结果答。

所以插件把这层补齐了，magpie / OpenCode 看到的是**原生 OpenAI 格式**：

```
harness 发 tools=[...]        插件把工具表翻成提示词协议，跟在对话最前面
模型回 TOOL_CALL {...} END_CALL   插件解析成 delta.tool_calls + finish_reason:"tool_calls"
harness 执行完发 role:"tool"  插件把 调用→结果 渲染回 transcript 继续问
```

发工具的那一回是**先收齐再吐**（标记可能横跨增量，直播流拆不回来；调用行本来就短），
不带工具的普通对话仍然全程流式。

实测一轮完整回合在 `DOUBAO_E2E=1` 里：回合 1 流式吐
`get_weather {"city":"上海"}`，回合 2 喂结果后答出 22℃。

**它终究是提示词模拟，不是原生函数调用**，差别在这：

- 遵循度看模型心情。豆包 2.1 Pro 实测很规矩，但协议词被它写进正文、或者该调的
  时候没调，概率比原生接口高。解析失败时标记原样当文本退回，不会崩，但那一轮等于白跑。
- 每轮都要重发工具说明，token 花在最前面对话头。
- 并行调用按多行协议走，一次多个调用没问题；但「边说边调」的中途插话它学不会。

## 限制

- **只发文字**。图片、文件传不过去；插件会在提示里明确告诉模型「这条消息带了 N 个
  附件你看不到，别猜」，免得它像上面那样编。
- 历史按 6000 字截，从最近的往前留。
- 只在 macOS 上读本机登录。
- 每 40 轮换一个豆包会话，免得在你自己的豆包列表里堆出一个无限长的会话。
  换掉的旧会话不会自动删除，介意的话自己去豆包里清。

## 两个坑（写在这免得别人再踩）

- **文字块的形状错了不会报错。** 得是 `block_type: 10000` + `content.text_block.text`。
  写成 `{type:1, text:{body}}` 服务端**照样收**、照样 ACK、照样回一大段流畅的话——
  只是回的是「你没说清楚需求呢」。问题根本没送到模型。
- **一条回答分两路来**：`STREAM_CHUNK` 里 `patch_object: 102` 的增量，和
  `STREAM_MSG_NOTIFY` 里那块累积文字。两条是互补的，不是重复的——短回答真的会是
  累积块里给一个字、下一个字走增量。只取一条会截断，两条都取会重字。

## 测

```sh
bun test doubao-free.test.mjs            # 不联网：形状、文字块、两路拼装、上下文、工具协议往返
DOUBAO_E2E=1 bun test doubao-free.test.mjs   # 真发对话 + 完整工具回合（要装了豆包工作并登录）
```

联网那几条问的都是有唯一答案的问题（「中国的首都是哪里」查「北京」、「1+1」查「2」），
最后一条连着问两轮、查第二轮记不记得第一轮的暗号。**只看「有没有吐出字」是查不出
上面那两个坑的**——两个都真踩过。

## License

MIT
