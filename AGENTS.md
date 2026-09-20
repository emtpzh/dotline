# AGENTS.md

ThoughtDAG：把 LLM 对话变成无限画布上可编辑的思维 DAG（节点=一轮问答，边=上下文流）。React 19 + Vite + TypeScript 前端，Express 代理后端。状态：活跃开发中的开放原型（github.com/chenxiachan/thoughtdag）。

## 常用命令

```bash
npm run dev      # Vite 前端 (默认 5173)
npm run server   # LLM 代理 server.mjs (端口 3001，前端默认指向它)
npm run build    # tsc -b && vite build
npm run smoke    # scripts/smoke.mjs 冒烟测试
npm run lint
```

需要 `.env`（见 `.env.example`）：至少一把 LLM key（`ZHIPU_API_KEY` 免费档 glm-4.5-flash，或 `DASHSCOPE_API_KEY` 付费）。

## 架构

- `server.mjs` — 唯一后端文件：Express 代理，用 Vercel AI SDK（`ai` + `@ai-sdk/openai-compatible` + `zhipu-ai-provider`）调 LLM；含 agentic 网页搜索 + 行内引用（搜索后保证有综合回答）。
- `src/store/` — zustand 全局状态；持久化用 idb-keyval（IndexedDB）。
- `src/components/` — 画布基于 `@xyflow/react`（React Flow）：`ThoughtNode`、`ThoughtEdgeView`、`SelectionToolbar`（圈选对齐，对齐前有确认提示）、`focus-panel/`。
- `src/lib/api.ts` — 前端到 server.mjs 的调用层。
- `src/i18n/` — 中英双语。
- Markdown 渲染：react-markdown + KaTeX + highlight.js；PDF 附件用 pdfjs-dist。

## UI 约定

界面走 shadcn（Base UI 底座，样式 `base-nova`，配置在 `components.json`）。lint 会挡住下面大部分违规写法，`npm run lint` 是最终裁判。

- **基础组件只从 `@/components/ui/*` 来**。缺什么用 `npx shadcn@latest add <name>` 加，不要手写。改 `components/ui/` 里的文件只允许调样式和加变体，不要塞业务逻辑。
- **Base UI 用 `render` prop 组合，不是 Radix 的 `asChild`**。
- **颜色只用语义 token**：shadcn 标准集加上 `warning`、`success`；画布连线用 `edge-continue` / `edge-explore` / `edge-trace` / `edge-watch`；画布底色 `canvas`。token 表在 `src/index.css`，JS 侧镜像在 `lib/constants.ts` 的 `COLORS`。原生色阶（`text-red-500`）和字面色值都会报错。画框身份色是唯一例外，集中在 `constants.ts` 的 `FRAME_COLORS`。
- **层级**：画布内 `z-0`–`z-10`，应用骨架到 `z-30` 为止，弹层一律由 `components/ui` 的组件处理（它们用 `z-50`）。业务代码里不要出现 `z-50` 及以上或 `z-[...]`。三个例外（教程、可拖动的 condense 窗口、阅读器的提问条）把层级定义在 `src/styles/base.css`，组件里写明了原因。
- **弹窗用 `Dialog`**，自己写 `fixed inset-0` 遮罩会报错。每个弹窗都要有 `DialogTitle`（纯图标场景用 `sr-only`）。
- **圆角**跟 `--radius` 派生的 token 走：按钮和输入框 `rounded-md`，卡片和弹窗 `rounded-xl`。
- **主题**挂在 `<html>` 的 `.dark` class 上（`lib/appearance.ts` 切换），`dark:` 变体据此生效；`data-palette='harness'` 是插件里的第三套中性色。改颜色时三套都要看。
- 视觉改动用 `node scripts/screens.mjs <label>` 截图、`node scripts/screens-diff.mjs <a> <b>` 对比（需要 `npm run dev` 在 5173）。

## 约定

- 布局必须遵守箭头（上下文流）顺序，同一对话链节点竖向对齐——这是用户明确要求过的行为，改布局逻辑时不要破坏。
- 与用户交流用中文；代码标识符和注释保持英文。
- UI 文案（i18n、tooltip、toast、placeholder）不出现第三方品牌名。功能性标识除外：环境变量名、导入格式的身份（如 ChatGPT 导出文件）、实际数据源（arXiv、Semantic Scholar）。举例、推荐、宣传式的品牌提及一律用通称（"外部 OCR 工具""其他助手"）或扩展名（.docx）替代。
