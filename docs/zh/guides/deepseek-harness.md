---
title: 在 DeepSeek Harness 中使用 ThoughtDAG
---

# 在 DeepSeek Harness 中使用 ThoughtDAG

插件把 ThoughtDAG 画布嵌入 Harness 网页界面。你在图上整理下一轮的上下文，Harness 负责执行；也可以通过 Agent 对话地图浏览 Claude Code、Codex、Pi 和 Harness 的会话。

## 安装

前提：已安装并配置 DeepSeek Harness **0.1.2-rc.1 或更新版本**，使用 Node.js **22.19+（22.x）或 24+**。

```bash
dsh plugin --profile web add dsh-thoughtdag
dsh web
```

pnpm 11 默认压住发布不满 24 小时的版本；想在发版当天装到新版，直接点名版本：`dsh plugin --profile web add dsh-thoughtdag@<版本号>`。每个 Release 的 GitHub 资产里也附带插件文件 `dsh-thoughtdag-<版本>.tgz`；`dsh plugin` 底层运行 pnpm，同一条命令也接受这个文件的链接或本地路径。已装的用 `dsh plugin --profile web add dsh-thoughtdag@latest` 更新（应用内的更新提示复制的就是这条）。

打开 `dsh web` 输出的地址，在聊天顶部选择 **思维图**。需要返回聊天时，选择 **对话**。

插件已包含画布，**无需另装 ThoughtDAG 桌面版**。模型与工具沿用你的 Harness 配置。

## 运行方式字典

在画布的模型选择器中选择运行方式：

| 选择 | 执行方式 | 结果保存在哪里 |
|---|---|---|
| Harness 提供的普通模型 | 直接调用该模型生成回答，不运行完整 Agent 工具循环 | ThoughtDAG 画布 |
| **DeepSeek Harness · Agent** | 由 Harness 执行真实 Agent 轮次，可按 Harness 配置使用工具 | 画布与 Harness 会话日志 |
| 在已镜像的 Harness 会话链尾，以 Agent 方式继续追问 | 续接对应的 Harness 会话 | 原 Harness 会话新增轮次，画布同步结果 |
| 从已镜像的 Harness 会话中较早的一轮，以 Agent 方式追问 | 在那一轮结束处分叉会话，后面的轮次不会混进这个分支 | 新的 Harness 会话：保留到那一轮为止的对话，再加上新一轮 |

只有当追问上游在画布上没有被编辑过、也没有额外接入其他内容时，才会续接或分叉会话；否则这一轮会在新会话里运行，并带上画布编译出的上下文，确保你的修改能到达 Agent。

选择 Agent 模型后，工具栏上的文件夹按钮决定这一轮在哪个目录运行：默认先跟随镜像的项目，其次是聊天窗口当前会话的目录；也可以手动输入运行 Harness 那台机器上的绝对路径。关闭画布或切换到别的画布后，Agent 轮次会继续运行；画布再次打开时，节点会从会话中取回完成的回答。这期间它提出的问题会在顶栏等你回答。

续接 Harness 会话的追问沿用会话自己的模型。如果在提问框里换了模型，换的是这个会话本身，聊天窗口里的同一个会话也会一起换模型——发送前提问框会提示这一点。

选择普通模型不等于执行 Harness Agent。若希望使用工具并保留真实会话轮次，请选择 **DeepSeek Harness · Agent**。

## 例子：从一个回答继续探索

下面是实际操作录屏：

<video controls playsinline muted preload="metadata" src="/media/harness-user-take-zh.mp4" style="width:100%;border-radius:8px" aria-label="在 Harness 中切换思维图、继续追问并选文探索"></video>

1. 在 Harness 顶部从 **对话** 切换到 **思维图**，打开已有节点。
2. 双击第一个问答节点，在右侧面板阅读完整回答。
3. 在面板下方输入追问并发送。回答会形成第二个节点，与上一节点相连。
4. 在第二个回答中选中想深入了解的文字，选择 **探索**。
5. 新问题与回答形成第三个节点。检查连线，确认后续问题要接收哪些上下文。

普通模型与 Agent 方式都可以生成画布节点；是否进入 Harness 会话日志，取决于上表中的运行方式，而不是节点是否出现。

## 上下文与会话

### 哪些内容进入下一轮

连到问题上的上游节点、已启用的材料和笔记会作为上下文。断开一条边，会将对应分支排除出该路径的下游模型上下文；节点仍留在画布上，可以继续生长或重新连接。

添加 PDF、在阅读器中摘取文字并连接材料的方法，与独立应用相同，参见[材料节点与阅读器](./materials)和[控制上下文](./context-control)。

### 新增轮次，不改写旧历史

镜像节点是会话记录，画布不会改写它：修改它的提问或重新生成，会在旁边创建新分支（Agent 方式下，会话在它之前的那一轮分叉）；修改它的回答，会在旁边生成一个属于画布的修订节点。删除镜像节点只把它从画布上移除，不会改写 Harness 会话日志。通过 Agent 方式发送追问，则是在 Harness 中执行并记录一个**新轮次**。

需要浏览其他会话时，从画布菜单进入 [Agent 对话地图](./session-atlas)。插件能访问的是运行 Harness 的机器上的受支持会话，不是任意浏览器客户端的文件。

## 常见问题

| 问题 | 先检查什么 |
|---|---|
| 顶部没有“思维图” | 是否使用 `--profile web` 安装；安装后重新启动 `dsh web` 并刷新页面；检查 Harness 版本与启动日志 |
| 看不到预期模型 | Harness 中是否已配置相应模型和凭证 |
| 节点有回答，但 Harness 日志没有新轮次 | 是否选择了普通模型；需要日志与工具执行时选择 Agent 方式 |
| Atlas 没找到其他工具的会话 | 对应日志是否位于 Harness 所在机器上，且属于受支持格式 |

存储与删除方式见[隐私与存储](../reference/privacy-storage)。
