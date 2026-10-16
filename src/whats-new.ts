// What a release changed, in the user's words. Two readers: the dialog that
// opens once after an update, and the release history behind the ⋯ menu.
// Every release gets an entry here, so the history is complete; `announce`
// decides only whether the entry also pops up on the first launch after the
// update. Most releases pass silently: the dialog is for the few where a
// person opening the app should learn that a new door exists. Content lives
// here, not in a network call: the app is local-first and this must work
// offline. Links open in the system browser through the shell's window-open
// handler. Newest first.

import type { Lang } from './i18n';
import { DOCS_URL, REPO_URL } from './lib/brand';

export interface WhatsNewItem {
  title: Record<Lang, string>;
  body: Record<Lang, string>;
  /** where to read more, if anywhere */
  link?: { label: Record<Lang, string>; href: string };
}

export interface WhatsNewEntry {
  version: string;
  /** release day, YYYY-MM-DD */
  date: string;
  /** pop up on the first launch after updating to this version */
  announce: boolean;
  /** one line under the version: what this release is about */
  lead: Record<Lang, string>;
  items: WhatsNewItem[];
}

const DOCS = DOCS_URL;

export const WHATS_NEW: WhatsNewEntry[] = [
  {
    version: '0.4.24',
    date: '2026-10-16',
    announce: false,
    lead: {
      zh: '连线更贴合卡片边缘；详情面板收起顶部的上下文历史，从内容顶部向下拉动即可展开。画布缩放时卡片字号更平稳，图片资料与对话链的显示也更一致。',
      en: 'Edges meet card borders more cleanly. The details panel starts with earlier context tucked away; pull down from the top of the content to reveal it. Card text scales more steadily across canvas zoom levels, and image materials display more consistently alongside conversation turns.',
    },
    items: [],
  },
  {
    version: '0.4.23',
    date: '2026-10-15',
    announce: false,
    lead: {
      zh: '两处修复。画布切换里的"重命名"恢复正常：之前点了之后输入框会立刻消失。撤销不再影响正在运行或已经结束的回答：一次撤销只退一步，提问后撤销只会撤掉这个问题；已经答完的节点不会被撤销拉回"生成中"；撤销掉的节点如果还在运行，运行会一并停止。在输入框里按 ⌘Z 只撤销输入的文字，不再撤销画布。',
      en: 'Two fixes. Rename in the canvas switcher works again; the field used to vanish the moment it opened. Undo no longer reaches into answers that are running or done: one undo is one step, so undoing right after a question takes back just that question; a node that finished answering is never put back to generating; and a node an undo removes stops its run. Cmd+Z in a text field undoes the text, not the canvas.',
    },
    items: [],
  },
  {
    version: '0.4.22',
    date: '2026-10-15',
    announce: false,
    lead: {
      zh: '画布切换和会话地图重新整理。左上角的画布切换改回下拉面板：可以搜索、用方向键和回车切换，每张画布一行，新建画布固定在底部，归档后可以在提示里撤销，已归档的画布需要时再展开。会话地图里单击一行只是勾选，点底部按钮才会添加到新画布或选定的画布，不会再一点就写进当前画布；单个会话加到新画布时，会回到它原来的画布或挂回出发的节点。会话按项目目录分组，新会话和有更新的会话有标记。同步会话的画布在名称前显示终端图标，在这样的画布上打开会话地图会直接定位到对应会话。另外，从画布打开的会话里，即使上一轮在打开前改过，追问也会留在这个会话里。',
      en: 'The canvas switcher and the session map, reworked. The switcher in the top-left is a dropdown again: search, switch with the arrow keys and Enter, one line per canvas, New canvas pinned at the bottom, archiving undoable from its notice, and archived canvases shown on request. In the session map a click only picks a session; the footer button adds the picks to a new canvas or one you choose, so nothing lands on the current canvas by a stray click, and a single session added to a new canvas returns to its earlier canvas or mounts back at the node it left from. Sessions are grouped by project folder, with new and updated ones marked. A canvas that follows a session shows a terminal icon by its name, and opening the session map there lands on that session. A follow-up in a session the canvas opened also stays in that session when the turn above it was edited before it opened.',
    },
    items: [],
  },
  {
    version: '0.4.21',
    date: '2026-10-13',
    announce: false,
    lead: {
      zh: '画布和本机 Agent 会话之间换了一套更稳的底层：从会话里追问时，沿用那一轮实际用的模型、思考强度和目录，不再落到工具栏上的全局选择；面板也会显示镜像轮次用的模型。Agent 回合在你切到别的画布时照常跑完，回来就能看到结果，期间它提的问题在顶栏等你回答。同一个会话被另一个客户端从中间接着问、或者你删掉的镜像轮次，都不会再错位或重新长回来。会话原来的目录被移走时，追问会在画布目录另起会话，并提示你选一个目录。',
      en: 'The link between the canvas and local agent sessions has a sturdier base. A follow-up from a session turn runs on the model, effort and folder that turn actually used, not on the toolbar\'s pick, and the panel shows the model for mirrored turns too. An agent turn finishes when you switch to another canvas, and its answer is there when you come back; a question it asks meanwhile waits in the top bar. A session another client continues from an earlier turn no longer lands out of place, and a mirrored turn you deleted stays deleted. When a session\'s folder has been moved, a follow-up starts a new session in the canvas folder and offers to pick one.',
    },
    items: [],
  },
  {
    version: '0.4.20',
    date: '2026-10-12',
    announce: false,
    lead: {
      zh: '同一个 agent 会话在两处续写时，画布按会话真实的分叉来画：比如画布从命令行接着问了几轮，你又在原来的应用里接着回复，那一轮会作为分支长在它真正接着的那一轮旁边，不再接到画布那条链的末尾。DeepSeek Harness 插件：why 查询工具和对应的系统提示默认关闭，需要时在插件配置里打开，模型不会再在无关任务里频繁去查。',
      en: 'When one agent session is continued in two places, the canvas draws the fork where the session actually forks: if the canvas went on from the command line for a few turns and you then replied in the original app, that reply grows as a branch beside the turn it really follows, instead of landing at the end of the canvas\'s line. DeepSeek Harness plugin: the why tools and their system-prompt section are off by default; turn them on in the plugin config when you want them, and the model no longer reaches for them on unrelated tasks.',
    },
    items: [],
  },
  {
    version: '0.4.19',
    date: '2026-10-12',
    announce: false,
    lead: {
      zh: '子代理上画布：一轮对话派出的子代理，会作为分支节点出现在这一轮旁边——任务是问题，子代理交回的报告是回答，它自己的工具调用记为步骤，主线照旧往下走。DeepSeek Harness 的子代理（前台和后台）、以及其他 agent 会话里的子代理都支持；在画布上提问派出的子代理，这一轮结束就出现，不用重开画布。回答里的 HTML 现在先过滤再显示，内嵌框架和脚本不会再运行。DeepSeek Harness 插件：画布上的 agent 轮次不再有 20 分钟上限，以 harness 报告结束为准；摘要、标题和整理不再为此新开 agent 会话。另外修了几处小问题：删除正在生成的节点会停止生成，概览窗口关着时不再占用资源。',
      en: 'Subagents on the canvas: a run a turn delegates appears as a branch node beside that turn, with the task as its question, the report the subagent sent back as its answer, and its own tool calls as its steps, while the main line carries on. Works for DeepSeek Harness subagents, foreground and background, and for subagents in other agents\' sessions; one launched by a question asked on the canvas shows up as soon as the turn ends, no reopening needed. HTML in an answer is now sanitized before it is shown, so embedded frames and scripts no longer run. DeepSeek Harness plugin: an agent turn on the canvas has no twenty-minute cap and ends when the harness says it has; summaries, titles and condensing no longer open an agent session of their own. Smaller fixes: deleting a node that is still generating stops the generation, and closed overview windows no longer do work in the background.',
    },
    items: [],
  },
  {
    version: '0.4.18',
    date: '2026-10-11',
    announce: false,
    lead: {
      zh: '提问只有一个入口：首页、详情面板、回答阅读器和资料阅读器都用同一个提问框，详情面板底部只留一个输入框。DeepSeek Harness 插件：新开会话时可以在提问框的模型菜单里选一个 agent 预设。中文界面下，菜单、下拉和命令项的字号小一号，读起来更匀称。靠近屏幕右边缘的提示不再一字一行竖着排。',
      en: 'One place to ask: the landing page, the details panel, the answer viewer and the reader all share the same ask box, and the details panel keeps a single input at the bottom. DeepSeek Harness plugin: a new session can start from an agent preset picked in the ask box\'s model menu. In the Chinese interface, menu, select and command items are a size smaller. A tooltip near the right edge of the screen no longer stacks one character per line.',
    },
    items: [],
  },
  {
    version: '0.4.17',
    date: '2026-10-10',
    announce: false,
    lead: {
      zh: '选中文字后的「探索 / 高亮」：浮条改成一条安静的工具条，弹出和消失都有过渡，换一段文字时在新位置重新浮起。高亮现在画在你看到的文字上：跨过代码块、行内代码、链接、表格和公式的选段都能完整标出，代码块里不再冒出一串标签原文，公式整块标记并按 TeX 记录。详情面板的高亮列表改成荧光笔式的一行一条，公式直接排版显示。',
      en: 'Explore / Highlight on a selection: the bar is a quiet toolbar that rises in and fades out, and re-enters at each new passage. Highlights are now drawn on the text you see: a passage through code blocks, inline code, links, tables or formulas is marked whole, code blocks no longer show stray tag text, and a formula is marked as one piece and kept as TeX. The highlight list in the details panel reads as highlighter strokes, one per line, with formulas typeset.',
    },
    items: [],
  },
  {
    version: '0.4.16',
    date: '2026-09-17',
    announce: false,
    lead: {
      zh: '分区框：两个只是部分重叠的框不再互相收编。拖动大框时，重叠的小框和它自己的节点留在原地；拖动和一键排版现在用同一条成员规则，普通节点按中心点归属，框只有完整落在另一个框里才算它的成员（#40，感谢 @nanami-0713）。DeepSeek Harness 插件：「插件有新版本」提示复制的命令带上具体版本号，发版当天也能立刻装到新版。',
      en: 'Frames: two frames that merely overlap no longer own each other. Dragging the larger one leaves the overlapping smaller frame and its own nodes in place; dragging and auto layout now share one membership rule, nodes by centre and a frame only when it lies fully inside another (#40, thanks @nanami-0713). DeepSeek Harness plugin: the update hint now copies a command naming the exact version, so a release installs on its first day too.',
    },
    items: [],
  },
  {
    version: '0.4.15',
    date: '2026-09-15',
    announce: false,
    lead: {
      zh: '分区框三件事：一键排版后，框跟着框内的节点重新包好（#32）；拖动外框会带动嵌套在里面的框；重叠时小框叠在大框上面，标题栏不再被盖住。三项均来自 @hexu321。DeepSeek Harness 插件：「对话 | 思维图」切换器移进会话标题栏，不再遮挡标题；返回按钮居中，画布右上的工具栏保持可见；从画布切回会话的跳转修好了（#30，来自 @nanami-0713）。插件重新在 npm 上发布，安装命令恢复为包名。',
      en: 'Frames, three fixes: after auto layout a frame re-wraps the nodes it held (#32); dragging an outer frame carries the frames nested inside it; where frames overlap, the smaller one stacks on top so its title bar stays reachable. All three by @hexu321. DeepSeek Harness plugin: the 对话 | 思维图 switch moves into the session header and no longer covers the title; the back button sits top centre, clear of the canvas toolbar; jumping from the canvas back to a session works again (#30, by @nanami-0713). The plugin is back on npm and the install command is the package name again.',
    },
    items: [],
  },
  {
    version: '0.4.14',
    date: '2026-09-11',
    announce: false,
    lead: {
      zh: '插件的「有新版本」提示现在复制 dsh plugin --profile web add dsh-dotline@latest，这条命令对从 npm 装和从 Release 文件装的用户都有效（update 对文件安装无效）。其余同 0.4.13。',
      en: 'The plugin\'s update hint now copies dsh plugin --profile web add dsh-dotline@latest, which works for installs from npm and from a release file alike (update does nothing for a file install). Otherwise the same as 0.4.13.',
    },
    items: [],
  },
  {
    version: '0.4.13',
    date: '2026-09-11',
    announce: false,
    lead: {
      zh: '修复：DeepSeek Harness 插件里，模型选择器丢失了「Harness · 模型」这一组 Agent 条目（0.4.11 起，机器上没装 Pi、Codex 等命令行时整组消失）。原因是思维图把 Harness 给的条目当成本机命令行的探测结果替换掉了，现在只替换命令行报来的那几种。插件里「如何使用」的教程动图也能显示了（#35，感谢 @Moya-Doc）。',
      en: 'Fix: inside the DeepSeek Harness plugin, the model picker lost the "Harness · model" agent entries (since 0.4.11; with no Pi or Codex CLI on the machine the whole group vanished). The canvas had been replacing the harness\'s entries with the local CLI probe; now only the entries the CLIs report get replaced. The tutorial gifs inside the plugin load again (#35, thanks @Moya-Doc).',
    },
    items: [],
  },
  {
    version: '0.4.12',
    date: '2026-09-10',
    announce: false,
    lead: {
      zh: 'DeepSeek Harness 插件里，Agent 子节点现在续接父节点的会话；同一父节点下的第二个分支从父节点那一轮分叉出自己的会话，preset 的会话状态不再在每个子节点重头开始（#28、#29）。插件的构建脚本在 Windows 上也能跑了（#24、#26）。桌面版本次只同步版本号。',
      en: 'Inside the DeepSeek Harness plugin, an agent child node now continues its parent\'s session, and a second branch off the same parent forks its own session at that parent\'s turn, so a preset\'s session state no longer restarts at every child (#28, #29). The plugin\'s build script runs on Windows too (#24, #26). The desktop app only moves its version number.',
    },
    items: [],
  },
  {
    version: '0.4.11',
    date: '2026-09-08',
    announce: false,
    lead: {
      zh: '性能优化：启动更快，后台更省，多个工具调用并行时更稳；300 节点以上的画布实测流畅。Dotline 现在可以用 Claude Code、Codex、Pi 作为节点的 Agent 运行时，处于测试阶段。',
      en: 'Performance: faster launch, lighter in the background, steadier when several tool calls run in parallel; canvases past 300 nodes measured smooth. Dotline can now run a node through Claude Code, Codex or Pi as its agent runtime, in testing.',
    },
    items: [],
  },
  {
    version: '0.4.10',
    date: '2026-09-07',
    announce: false,
    lead: {
      zh: 'Agent 执行预览继续：Codex 加入，和 Pi 一样在画布里带工具作答；这条通道现在在桌面版、本地网页版和 DeepSeek Harness 插件里都可用；插件里的 Harness Agent 按模型平铺；插件有新版本时画布会提示。',
      en: 'Agent runs, preview continued: Codex joins Pi, answering with tools right from the canvas; the lane now works in the desktop app, the local web app and the DeepSeek Harness plugin alike; inside the plugin the Harness agent lists one entry per model; the canvas tells you when a newer plugin is out.',
    },
    items: [],
  },
  {
    version: '0.4.9',
    date: '2026-09-07',
    announce: false,
    lead: {
      zh: 'Agent 执行预览：桌面版的模型选择器多了「Agent 执行」组，装了 Pi 的话可以直接在画布里让它带工具作答，轨迹、足迹、审批和提问都落在节点上，工作目录在顶栏可见可改。正式版会连同 Claude Code 与 Codex 一起发布。DeepSeek Harness 插件里的审批卡片同步更新。',
      en: 'Agent runs, preview: the desktop picker gains an "Agent runs" group; with Pi installed, a question runs through it with tools right from the canvas, and the trace, footprints, approvals and questions land on the node, with the working directory visible on the toolbar. The full release will arrive together with Claude Code and Codex. The approval card inside the DeepSeek Harness plugin is updated alike.',
    },
    items: [],
  },
  {
    version: '0.4.8',
    date: '2026-09-07',
    announce: false,
    lead: {
      zh: 'DeepSeek Harness 插件在 Windows 上能打开了：静态资源和会话目录的路径守卫此前只认正斜杠，Windows 用户看到的是一片 403。感谢 GitHub 上的报告（#23）。桌面版本次只同步版本号。',
      en: 'The DeepSeek Harness plugin now opens on Windows: the path guards for static assets and session directories only accepted forward slashes, so Windows users saw nothing but 403s. Thanks to the report on GitHub (#23). The desktop app only moves its version number this time.',
    },
    items: [],
  },
  {
    version: '0.4.7',
    date: '2026-09-07',
    announce: false,
    lead: {
      zh: 'DeepSeek Harness 插件里，Agent 需要你批准的操作现在直接出现在节点上：工具、命令、理由，允许一次或拒绝，决定留在节点记录里。桌面版本次只同步版本号。',
      en: 'Inside the DeepSeek Harness plugin, an action the agent needs approved now appears on the node itself: tool, command, reason, allow once or reject, and the decision stays in the node\'s record. The desktop app only moves its version number this time.',
    },
    items: [],
  },
  {
    version: '0.4.6',
    date: '2026-09-06',
    announce: true,
    lead: {
      zh: '🎉 Pi 的会话进了对话地图，「⋯」菜单里多了更新历史，随时能回看每一版改了什么。',
      en: '🎉 Pi sessions join the Session Atlas, and the ⋯ menu gains a release history, so what every version changed is one click away.',
    },
    items: [
      {
        title: { zh: 'Pi 的会话也在地图上了', en: 'Pi sessions are on the map' },
        body: {
          zh: '本地 Pi 会话按项目聚在一起，打开就是一张图。Pi 里的每次分叉在图上就是一条支线，不再压成一条直线。命令行 why 和 MCP 也同步认识 Pi 留下的文件足迹。',
          en: 'Local Pi sessions group by project and open as a graph. Every fork you made in Pi shows up as a branch instead of being flattened into one line. The why command and MCP index Pi\'s file footprints too.',
        },
        link: { label: { zh: '怎么用', en: 'How it works' }, href: `${DOCS}/zh/guides/session-atlas` },
      },
      {
        title: { zh: '更新历史，随时补看', en: 'Release history, whenever you like' },
        body: {
          zh: '右上「⋯」菜单，「如何使用」下面。每个版本改了什么都在这里，从新到旧，当前版本有标记。',
          en: 'In the ⋯ menu, under How it works: what each release changed, newest first, with the version you are running marked.',
        },
      },
    ],
  },
  {
    version: '0.4.5',
    date: '2026-09-06',
    announce: true,
    lead: {
      zh: '🎉 这是 Dotline 到目前为止最大的一次升级：散在各个 Agent 里的对话接成了一张地图，能从画布里查，还能直接在 DeepSeek Harness 里用。四件新东西，都值得试一试。',
      en: '🎉 The biggest Dotline release so far: the conversations scattered across your agents become one map, you can query them, and it all runs inside DeepSeek Harness. Four new things, each worth a try.',
    },
    items: [
      {
        title: { zh: '跨 Agent 的对话地图，终于连成一张', en: 'Session Atlas: all your agents, one map' },
        body: {
          zh: 'Claude Code、Codex 和 DeepSeek Harness 的本地会话按项目文件夹聚在一起，点开就是一张图，随对话实时生长。',
          en: 'Local Claude Code, Codex and DeepSeek Harness sessions, grouped by project; open one as a graph and it follows the conversation live.',
        },
        link: { label: { zh: '怎么用', en: 'How it works' }, href: `${DOCS}/zh/guides/session-atlas` },
      },
      {
        title: { zh: '命令行 why：一条命令找回塑造文件的那些对话', en: 'thoughtdag why: one command finds the conversations that shaped a file' },
        body: {
          zh: 'npx thoughtdag why <文件> 列出哪些轮次读过、改过它，当时问了什么、改了什么；find 按原话搜，MCP 让 Agent 自己来查。',
          en: 'npx thoughtdag why <file> lists the turns that read or changed it, what was asked and what changed; find searches verbatim; MCP lets your agent ask.',
        },
      },
      {
        title: { zh: 'DeepSeek Harness 插件上线', en: 'DeepSeek Harness plugin is live' },
        body: {
          zh: 'dsh plugin --profile web add dsh-dotline，Harness 的网页里多一个"思维图"视图：在画布上提问、让 Harness 的 Agent 带工具作答，why 也成了它的原生工具。',
          en: 'dsh plugin --profile web add dsh-dotline adds a canvas view to the Harness web UI: ask from the canvas, let its agent answer with tools, and why becomes a native tool there.',
        },
        link: { label: { zh: '插件说明', en: 'Plugin README' }, href: `${REPO_URL}/tree/main/dsh#readme` },
      },
      {
        title: { zh: '文档站上线', en: 'The docs site is live' },
        body: {
          zh: '概念、任务指南、命令字典和隐私说明各有一页，中英文对照。感谢一路同行，欢迎来 Discussions 说说你怎么用它。',
          en: 'Concepts, task guides, the command dictionary and the privacy notes, each on its own page, in both languages. Thank you for coming this far with us; tell us how you use it in Discussions.',
        },
        link: { label: { zh: '打开文档', en: 'Open the docs' }, href: `${DOCS}/zh/` },
      },
    ],
  },
  {
    version: '0.4.4',
    date: '2026-09-04',
    announce: false,
    lead: {
      zh: 'DeepSeek Harness 成为对话地图的内置来源：它的 zstd 日志由桌面壳逐帧解码，每条消息一个节点，工具调用与结果配对成附件。',
      en: 'DeepSeek Harness becomes a built-in Atlas source: the shell decodes its zstd logs frame by frame, one node per message, tool calls paired with their results as attachments.',
    },
    items: [],
  },
  {
    version: '0.4.3',
    date: '2026-09-03',
    announce: false,
    lead: {
      zh: '深链接可以直达某一轮，画布可以按稳定 id 打开；子 Agent 的会话文件不再打扰实时监听。',
      en: 'A deep link can land on a turn and a canvas opens by its stable id; subagent session files no longer disturb the live watcher.',
    },
    items: [],
  },
  {
    version: '0.4.2',
    date: '2026-09-02',
    announce: false,
    lead: {
      zh: '镜像节点列出那一轮碰过的文件（✏️ 改过、📖 读过），预览用结论而不是开头；子 Agent 的会话作为子线程识别，报告折回发起它的那一轮。',
      en: 'A mirrored node lists the files its turn touched (✏️ edited, 📖 read) and previews the conclusion rather than the opening line; subagent files are recognized as sub-threads and their reports fold into the launching turn.',
    },
    items: [],
  },
  {
    version: '0.4.1',
    date: '2026-09-01',
    announce: false,
    lead: {
      zh: 'Agent 对话地图首发：本地 Claude Code 与 Codex 的会话按项目文件夹聚成一张图，一键接入，随对话实时生长。',
      en: 'Session Atlas debuts: local Claude Code and Codex sessions group by project folder into one map, connect in one click, and grow with the conversation.',
    },
    items: [],
  },
];

/** Numeric compare of dotted versions: negative when a < b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((x) => parseInt(x, 10) || 0);
  const pb = b.split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * What to show a person who last saw `after` (null: never saw any notes) and
 * now runs `upTo`: every announced entry in between, newest first. Skipped
 * releases are included, so an update that arrives two versions late still
 * tells the whole story.
 */
export function announcedSince(after: string | null, upTo: string): WhatsNewEntry[] {
  return WHATS_NEW.filter((e) => e.announce
    && compareVersions(e.version, upTo) <= 0
    && (after === null || compareVersions(e.version, after) > 0));
}
