import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  SelectionMode,
  type OnNodesChange,
  type OnEdgesChange,
  type OnConnect,
  type OnNodeDrag,
  type ReactFlowInstance,
  applyNodeChanges,
  applyEdgeChanges,
  BackgroundVariant,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import 'highlight.js/styles/github.css';
import { ArrowRight, BookOpen, Bot, Brain, CircleHelp, Download, Drama, Eye, FileText, Frame, GitBranch, Highlighter, ImageDown, KeyRound, LayoutGrid, Loader2, MessageCircleQuestion, MoreHorizontal, Paperclip, Redo2, Scissors, Search, Share2, SquareTerminal, Stethoscope, StickyNote, Trash2, Undo2, Workflow, X, ListRestart, FolderSync, Minimize2, Rewind, History as HistoryIcon } from 'lucide-react';
import './index.css';
import ThoughtNode from './components/ThoughtNode';
import ParadigmNode from './components/ParadigmNode';
import { useAppearance, edgePalette, LEGACY_EDGE_HEX } from './lib/appearance';
import ContentNode from './components/ContentNode';
import FrameNode from './components/FrameNode';
import ThoughtEdgeView from './components/ThoughtEdgeView';
import FocusPanel from './components/focus-panel';
import SelectionToolbar from './components/SelectionToolbar';
import NodeContextMenu from './components/NodeContextMenu';
import HighlightsOverviewModal from './components/app/HighlightsOverviewModal';
import MaterialsOverviewModal from './components/app/MaterialsOverviewModal';
import SearchBar from './components/SearchBar';
import DiagnosticsPanel from './components/DiagnosticsPanel';
import MaterialReader from './components/MaterialReader';
import ProjectSwitcher from './components/ProjectSwitcher';
import SessionAtlas from './components/SessionAtlas';
import { useStore } from './store';
import { frameMembers } from './lib/frames';
import { useProjects, adoptImportedProject, markInstantiatedFrom } from './store/projects';
import { projectStorageKey } from './store/projects';
import { set as idbSet } from 'idb-keyval';
import { instantiateParadigm } from './lib/paradigm';
import { isContentKind, spawnContentNode, ingestFiles, fetchLinkIntoNode, clipboardTextToMarkdown } from './lib/content';
import { generateId, isImeComposing } from './utils';
import { recapToNote, recapCamera } from './lib/recap';
import type { Attachment, ThoughtNode as ThoughtNodeType, ThoughtEdge } from './types';
import { processFile, FILE_INPUT_ACCEPT } from './lib/attachments';
import { walkUpAncestors, partitionContext } from './lib/graph';
import { buildContext } from './store/context-builder';
import { exportActiveParadigm, exportActiveProjectJson, exportEventLogCsv } from './lib/export';
import { countTokens } from './utils';
import { buildExampleGraph } from './lib/example-graph';
import { COLORS, FRAME_COLORS, PANEL_INSET } from './lib/constants';
import { panelShift } from './lib/panel-shift';
import { migrateActiveCanvasToVault, gcVaultAtBoot } from './lib/attachment-vault-boot';
import { consumeOpenRouterCallback, handMintedKeyToModal, startOpenRouterOAuth } from './lib/openrouter-oauth';
import { bootDesktopUpdateUI } from './lib/desktop-update-ui';
import { confirmDialog, toast, useUiStore } from './lib/ui-store';
import ConfirmDialog from './components/app/ConfirmDialog';
import Toaster from './components/app/Toaster';
import GlobalTooltip from './components/app/GlobalTooltip';
import RoleManagerModal from './components/app/RoleManagerModal';
import MemoryManagerModal from './components/app/MemoryManagerModal';
import ApiKeyModal from './components/app/ApiKeyModal';
import ResponseViewer from './components/app/ResponseViewer';
import ShareDialog from './components/app/ShareDialog';
import ThoughtMapDialog from './components/app/ThoughtMapDialog';
import BackupDialog from './components/app/BackupDialog';
import CondenseDialog from './components/app/CondenseDialog';
import { backupSupported } from './lib/local-backup';
import LangSwitch from './components/app/LangSwitch';
import ModelPicker from './components/app/ModelPicker';
import RoleTemplateChips from './components/app/RoleTemplateChips';
import SearchToggles from './components/app/SearchToggles';
import Tutorial from './components/Tutorial';
import WhatsNewDialog from './components/app/WhatsNewDialog';
import ReleaseNotesDialog from './components/app/ReleaseNotesDialog';
import AgentCwdChip from './components/app/AgentCwdChip';
import { pluginUpdateCommand } from './lib/plugin-update';
import { useT, t as ti, fmt, useI18n } from './i18n';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from './components/ui/dropdown-menu';
import { isViewerMode, buildViewerLink } from './lib/viewer';
import { useModels } from './lib/use-models';
import { useZoomTier } from './lib/use-map-mode';
import { TimelineBar } from './components/app/TimelineBar';
import TimelineOverviewModal from './components/app/TimelineOverviewModal';
import { useStore as useRfStore, useReactFlow } from '@xyflow/react';
import { Button } from './components/ui/button';
import { Textarea } from './components/ui/textarea';

// One node type key, three renderers: content nodes (notes / files) render
// the same in every mode; otherwise the active project's kind decides
// whether a node is a conversation card or an orchestration step card.
// memo matters at scale: a 555-node canvas re-rendering every visible card
// on each React Flow store tick is the difference between smooth and stuck
const NodeDispatch = memo(function NodeDispatch(props: Parameters<typeof ThoughtNode>[0]) {
  const isParadigm = useProjects((s) => s.projects.find((p) => p.id === s.activeId)?.kind === 'paradigm');
  if (props.data?.stepKind === 'frame') return <FrameNode {...props} />;
  if (isContentKind(props.data?.stepKind)) return <ContentNode {...props} />;
  return isParadigm ? <ParadigmNode {...props} /> : <ThoughtNode {...props} />;
});
const nodeTypes = { thought: NodeDispatch };
// Overrides the built-in smoothstep so persisted edges need no migration
const edgeTypes = { smoothstep: memo(ThoughtEdgeView) };

// Gate on rehydration: the store loads asynchronously from IndexedDB, and
// mounting the canvas only after hydration lets ReactFlow's fitView see the
// restored graph (and avoids flashing the landing input).
// The minimap's colors are token references, so they follow the theme on
// their own — no need to re-resolve them when the lighting flips.
const MINIMAP_COLORS = {
  mask: 'color-mix(in oklch, var(--canvas) 70%, transparent)',
  archived: 'var(--muted)',
  ordinary: 'var(--muted-foreground)',
};

export default function App() {
  const [hydrated, setHydrated] = useState(isViewerMode || useStore.persist.hasHydrated());
  useEffect(() => useStore.persist.onFinishHydration(() => setHydrated(true)), []);
  // Attachment vault: whenever the graph changes (hydration, project
  // switch, seed load, import), lighten any PDF still carrying its bytes
  // inline. The check is one cheap some() pass and the migration itself is
  // idempotent, so a debounced subscription beats racing load timings.
  useEffect(() => {
    if (!hydrated || isViewerMode) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const kick = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void migrateActiveCanvasToVault(), 800);
    };
    const unsub = useStore.subscribe((s, prev) => { if (s.nodes !== prev.nodes) kick(); });
    kick();
    return () => { unsub(); clearTimeout(timer); };
  }, [hydrated]);
  // Sweep orphaned vault payloads once per boot, off the critical path.
  useEffect(() => {
    // A condense build cannot survive a page load — its runner lives in
    // module memory. A leftover 'building' here is a stale lock: clear it.
    if (useUiStore.getState().condenseRun.status === 'building') {
      useUiStore.getState().setCondenseRun({ status: 'idle', current: 0, total: 0, streaming: '' });
    }
  }, []);
  useEffect(() => {
    if (isViewerMode) return;
    const timer = setTimeout(() => void gcVaultAtBoot(), 6000);
    return () => clearTimeout(timer);
  }, []);
  // True first launch (no tutorial ever closed, an empty canvas, not a
  // shared-link viewer): open the lesson unprompted. The example-canvas
  // button keeps its own trigger for people who skip straight there.
  useEffect(() => {
    if (!hydrated || isViewerMode) return;
    if (localStorage.getItem('thoughtdag.tutorialDone')) return;
    if (useStore.getState().nodes.length > 0) return;
    const timer = setTimeout(() => useUiStore.getState().setTutorialOpen(true), 900);
    return () => clearTimeout(timer);
  }, [hydrated]);

  // Desktop shell: update prompts render as in-app toasts (no-op on web)
  useEffect(() => { bootDesktopUpdateUI(); }, []);

  // A pending Sign-in-with-OpenRouter callback (?code=) resolves here: the
  // exchange runs entirely in the browser, then the ApiKeyModal opens on
  // the model-picking view for the user to confirm what to enable.
  // /thoughtdag handoff: #import-url=<loopback> imports a runner session
  // straight onto a fresh canvas (validation + one-shot in the consumer)
  useEffect(() => {
    if (isViewerMode) return;
    void import('./lib/session-handoff').then((m) => m.consumeSessionHandoff());
    // desktop only: the live mirror — the active canvas follows its
    // session file on its own (idempotent append via the ledger)
    void import('./lib/atlas/live-mirror').then((m) => m.startLiveMirror());
    // desktop only: the canvas writes its own source record for the why
    // layer, whether or not a backup folder was ever chosen
    void import('./lib/canvas-record').then((m) => m.startCanvasRecord());
    // ledger self-heal: canvases weeded before deletion-as-unsubscription
    // existed may still carry dead subscriptions — clear them on arrival
    void import('./lib/atlas/canonical').then((m) => m.unsubscribeOrphanedSessions());
  }, []);

  useEffect(() => {
    if (isViewerMode) return;
    void consumeOpenRouterCallback().then((r) => {
      if (!r) return;
      if (r.status === 'minted') {
        toast('success', ti('provider.oauthMinted'));
        handMintedKeyToModal(r.key);
      } else {
        toast('error', fmt(ti('provider.oauthFailed'), { error: r.error }));
      }
    });
  }, []);
  return (
    <>
      {hydrated && <Canvas />}
      <Toaster />
      <GlobalTooltip />
      <RoleManagerModal />
      <MemoryManagerModal />
      <ApiKeyModal />
      <ResponseViewer />
      <ShareDialog />
      <ThoughtMapDialog />
      <BackupDialog />
      <ConfirmDialog />
      <Tutorial />
      <WhatsNewDialog />
      <ReleaseNotesDialog />
    </>
  );
}

function Canvas() {
  const { nodes, edges, setNodes, setEdges, addQuestion, undo, redo, addCrossLink, setSelectedNodeId, setSelectedNodeIds, history, historyIndex, relayout } = useStore();
  const t = useT();
  const setTutorialOpen = useUiStore((s) => s.setTutorialOpen);
  const annotationsHidden = useUiStore((s) => s.annotationsHidden);
  const setAnnotationsHidden = useUiStore((s) => s.setAnnotationsHidden);
  const [inputValue, setInputValue] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [rootRole, setRootRole] = useState('');
  const [showRootRole, setShowRootRole] = useState(false);
  const [landingAtlas, setLandingAtlas] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState<Attachment[]>([]);
  const [isDraggingLanding, setIsDraggingLanding] = useState(false);
  const landingFileRef = useRef<HTMLInputElement>(null);
  const docFileRef = useRef<HTMLInputElement>(null);
  const hasNodes = nodes.length > 0;
  const hasEvents = useStore((s) => s.events.length > 0);
  const highlightCount = useStore((s) => s.nodes.reduce((sum, n) => sum + (n.data.highlights?.length ?? 0), 0));
  const materialCount = useStore((s) => s.nodes.reduce((sum, n) =>
    sum + (n.data.attachments?.length ?? 0) + (['note', 'link'].includes(n.data.stepKind ?? '') ? 1 : 0), 0));
  const rfInstance = useRef<ReactFlowInstance<ThoughtNodeType, ThoughtEdge> | null>(null);
  // Arrival focus, runtime lane: a harvest appends to the LIVE canvas (no
  // remount, so onInit never fires) — consume the one-shot here instead.
  const arrivalFocus = useUiStore((s) => s.arrivalFocusNodeId);
  useEffect(() => {
    if (!arrivalFocus) return;
    const n = useStore.getState().nodes.find((x) => x.id === arrivalFocus);
    if (!n) return;
    useUiStore.getState().setArrivalFocusNodeId(null);
    window.setTimeout(() => {
      rfInstance.current?.setCenter(n.position.x + 260, n.position.y + 140, { zoom: 0.9, duration: 400 });
    }, 150);
  }, [arrivalFocus]);
  // Appearance: lighting swaps the token set, paper swaps the canvas texture
  // (and turns the grid's snapping on). Edge colors resolve per theme.
  const paperTexture = useAppearance((s) => s.paper);
  const lightingChoice = useAppearance((s) => s.lighting);
  const resolvedTheme = useAppearance((s) => s.resolved);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const themePalette = useMemo(() => edgePalette(), [resolvedTheme]);
  const prevNodeCount = useRef(nodes.length);
  // Every "center on node" goes through here: when the focus panel is open
  // the visual center sits half the panel further left, so the target shifts
  // right by panelShift/2 in world units — otherwise the node parks under
  // the panel.
  const centerNode = useCallback((n: { id: string; position: { x: number; y: number } }, opts: { zoom?: number; duration?: number; offX?: number } = {}) => {
    const rf = rfInstance.current;
    if (!rf) return;
    const zoom = opts.zoom ?? rf.getZoom();
    rf.setCenter(
      n.position.x + (opts.offX ?? 260) + panelShift(n.id) / (2 * zoom),
      n.position.y + 110,
      { zoom, duration: opts.duration ?? 350 },
    );
  }, []);
  const lang = useI18n((s) => s.lang);
  const condenseRunState = useUiStore((s) => s.condenseRun);
  const condenseBuilding = condenseRunState.status === 'building';
  const isParadigm = useProjects((s) => s.projects.find((p) => p.id === s.activeId)?.kind === 'paradigm');

  // No configured model: do NOT ambush the first open with the key dialog —
  // the example canvas needs no key and must be the first thing a newcomer
  // sees. The dialog is summoned where it has context instead: the toolbar
  // key button, the model picker, and the moment a generation actually
  // needs a model (streaming.ts opens it on the no-model error).
  const modelData = useModels();
  void modelData;

  // Backup nudge: the canvas lives in browser storage — durable across
  // restarts, but "clear site data" erases it. A substantial canvas that
  // hasn't been exported for a week earns one sticky reminder per session.
  useEffect(() => {
    if (isViewerMode || !hasNodes) return;
    if (useStore.getState().nodes.length < 10) return;
    const last = Number(localStorage.getItem('thoughtdag.lastBackupAt') ?? 0);
    // First run ever: start the 7-day clock now instead of nagging a
    // newcomer who loaded the example canvas ten seconds ago.
    if (last === 0) { localStorage.setItem('thoughtdag.lastBackupAt', String(Date.now())); return; }
    if (Date.now() - last < 7 * 24 * 3600 * 1000) return;
    if (sessionStorage.getItem('thoughtdag.backupNudged')) return;
    sessionStorage.setItem('thoughtdag.backupNudged', 'yes');
    toast('info', ti('backup.nudge'), 0, { label: ti('backup.nudgeBtn'), run: () => exportActiveProjectJson() });
  }, [hasNodes]);

  const loadExample = useCallback(() => {
    const { nodes: exNodes, edges: exEdges } = buildExampleGraph(lang);
    const st = useStore.getState();
    st.setNodes([...st.nodes, ...exNodes.filter((n) => !st.nodes.some((x) => x.id === n.id))]);
    st.setEdges([...st.edges, ...exEdges.filter((e) => !st.edges.some((x) => x.id === e.id))]);
    st.pushHistory();
    setTimeout(() => {
      const inst = rfInstance.current;
      if (!inst) return;
      inst.fitView({ duration: 500, padding: 0.1 });
      // A laptop-sized window fits the whole example only at glyph zoom,
      // where every teaching card is unreadable. After the overview beat,
      // land on the oldest node (the welcome card) at takeaway zoom.
      setTimeout(() => {
        if (inst.getViewport().zoom < 0.34) {
          const first = [...useStore.getState().nodes]
            .sort((x, y) => (x.data.createdAt ?? '').localeCompare(y.data.createdAt ?? ''))[0];
          if (first) inst.setCenter(first.position.x + 300, first.position.y + 240, { zoom: 0.6, duration: 550 });
        }
      }, 680);
    }, 100);
    // the example canvas is the classroom: first visit opens the lesson
    if (!localStorage.getItem('thoughtdag.tutorialDone')) setTutorialOpen(true);
  }, [lang, setTutorialOpen]);

  // ── Orchestration (paradigm) mode helpers ──
  const addStep = useCallback((kind: 'human' | 'prompt') => {
    const st = useStore.getState();
    const last = st.nodes[st.nodes.length - 1];
    const pos = last ? { x: last.position.x, y: last.position.y + 340 } : { x: 120, y: 80 };
    const id = generateId();
    st.setNodes([...st.nodes, {
      id, type: 'thought', position: pos, dragHandle: '.drag-handle',
      data: {
        question: '', instruction: '', stepKind: kind,
        response: '', responses: [], responseIndex: -1,
        isCollapsed: false, isEditing: false, isEditingResponse: false, isLoading: false,
        tokenCount: 0, highlights: [], highlightMode: 'tag',
        attachments: [], excludedAttachmentIds: [], includedAttachmentIds: [],
        roleMode: 'inherit', isRoot: st.nodes.length === 0, isBranch: false,
      },
    }]);
    st.pushHistory();
  }, []);

  // After a project switch (from the switcher or the landing shortcuts):
  // reset the recenter baseline and refit the viewport.
  const afterProjectSwitch = useCallback(() => {
    prevNodeCount.current = useStore.getState().nodes.length;
    setTimeout(() => rfInstance.current?.fitView({ duration: 300, padding: 0.2 }), 50);
  }, []);

  // ── Content palette + canvas paste/drop: material lands where you point ──
  const lastMouse = useRef<{ x: number; y: number } | null>(null);

  // Frame: a labeled background region for wayfinding — never in context
  const spawnFrame = useCallback((pos: { x: number; y: number }) => {
    const st = useStore.getState();
    const id = generateId();
    st.setNodes([...st.nodes, {
      id, type: 'thought', position: pos, width: 640, height: 420, zIndex: -1, dragHandle: '.drag-handle',
      data: {
        question: '', stepKind: 'frame',
        // spawn unlinked: the frame is adjusted over its nodes first, then linked
        frameCarry: false,
        response: '', responses: [], responseIndex: -1,
        isCollapsed: false, isEditing: false, isEditingResponse: false, isLoading: false,
        tokenCount: 0, highlights: [], highlightMode: 'tag',
        attachments: [], excludedAttachmentIds: [], includedAttachmentIds: [],
        roleMode: 'inherit', isRoot: false, isBranch: false,
      },
    }]);
    st.pushHistory();
  }, []);

  // Dropped-file gate: accept what we can actually parse (images, PDF,
  // text/code). Word and friends would ingest as binary soup — reject with
  // an actionable hint instead.
  const filterDroppedFiles = useCallback((list: FileList | File[]): File[] => {
    const ok: File[] = [];
    for (const f of Array.from(list)) {
      const ext = f.name.split('.').pop()?.toLowerCase() ?? '';
      if (f.type.startsWith('image/') || f.type === 'application/pdf' || f.type.startsWith('text/')
        || ['pdf', 'docx', 'txt', 'md', 'csv', 'json', 'yaml', 'yml', 'toml', 'js', 'ts', 'tsx', 'jsx', 'py', 'sh', 'c', 'cpp', 'h', 'java', 'rs', 'go', 'rb', 'swift', 'css', 'html', 'xml', 'sql', 'tex', 'bib'].includes(ext)) {
        ok.push(f);
      } else {
        toast('info', fmt(ti('toast.unsupportedFile'), { name: f.name }));
      }
    }
    return ok;
  }, []);

  // Ask node: an ordinary Q&A node dropped EMPTY — wire material in, then
  // type the question; it answers from whatever the edges carry.
  const spawnAskNode = useCallback((pos: { x: number; y: number }): string => {
    const st = useStore.getState();
    const id = generateId();
    st.setNodes([...st.nodes, {
      id, type: 'thought', position: pos, dragHandle: '.drag-handle',
      data: {
        question: '', response: '', responses: [], responseIndex: -1,
        isCollapsed: false, isEditing: false, isEditingResponse: false, isLoading: false,
        tokenCount: 0, highlights: [], highlightMode: 'tag',
        attachments: [], excludedAttachmentIds: [], includedAttachmentIds: [],
        roleMode: 'inherit', isRoot: false, isBranch: false,
        webSearch: useUiStore.getState().webSearchEnabled,
        scholarSearch: useUiStore.getState().scholarSearchEnabled,
      },
    }]);
    st.pushHistory();
    return id;
  }, []);
  // Material-first entry: every dropped document becomes a material node;
  // the reader opens on the first readable one (PDF/text render instantly,
  // extraction fills the model channel in the background). Attachments to
  // the root question remain an EXPLICIT action (the paperclip).
  const startFromDocuments = useCallback((list: FileList | File[]) => {
    const files = filterDroppedFiles(list);
    if (files.length === 0) return;
    let readerTarget: string | null = null;
    files.forEach((f, i) => {
      const id = spawnContentNode('file', { x: 120 + (i % 3) * 480, y: 120 + Math.floor(i / 3) * 620 });
      void ingestFiles(id, [f]);
      if (!readerTarget && !f.type.startsWith('image/')) readerTarget = id;
    });
    if (readerTarget) useUiStore.getState().setReaderNodeId(readerTarget);
    setTimeout(() => rfInstance.current?.fitView({ duration: 400, padding: 0.2 }), 120);
  }, [filterDroppedFiles]);

  // Palette click-or-drag via pointer events (native DnD's click race lost
  // us real clicks): press = arm; move past 6px = drag with a ghost badge;
  // release = create at the drop point, or at screen center for a click.
  const paletteDrag = useCallback((e: React.PointerEvent, create: (screen: { x: number; y: number } | null) => void) => {
    const startX = e.clientX, startY = e.clientY;
    const source = e.currentTarget as HTMLElement;
    let ghost: HTMLElement | null = null;
    const move = (ev: PointerEvent) => {
      if (!ghost && Math.hypot(ev.clientX - startX, ev.clientY - startY) > 6) {
        ghost = document.createElement('div');
        ghost.innerHTML = source.innerHTML;
        ghost.style.cssText = 'position:fixed;z-index:300;pointer-events:none;width:36px;height:36px;display:flex;align-items:center;justify-content:center;background:var(--card);border:1px solid var(--primary);border-radius:10px;box-shadow:0 4px 14px rgba(0,0,0,.18);opacity:.92;';
        document.body.appendChild(ghost);
      }
      if (ghost) { ghost.style.left = `${ev.clientX - 18}px`; ghost.style.top = `${ev.clientY - 18}px`; }
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const dragged = !!ghost;
      ghost?.remove();
      create(dragged ? { x: ev.clientX, y: ev.clientY } : null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }, []);

  const flowPosAt = useCallback((screen?: { x: number; y: number } | null) => {
    const at = rfInstance.current?.screenToFlowPosition(screen ?? { x: window.innerWidth / 2, y: window.innerHeight / 2 }) ?? { x: 140, y: 140 };
    return { x: at.x - 200, y: at.y - 60 };
  }, []);

  useEffect(() => {
    const onMove = (e: MouseEvent) => { lastMouse.current = { x: e.clientX, y: e.clientY }; };
    // Canvas paste: text → note, a lone URL → link snapshot, files → file
    // node with the image/document itself. Inputs keep their own paste.
    const onPaste = (e: ClipboardEvent) => {
      if (isViewerMode) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      const meta = useProjects.getState();
      const isPara = meta.projects.find((p) => p.id === meta.activeId)?.kind === 'paradigm';
      if (useStore.getState().nodes.length === 0 && !isPara) return; // the landing owns paste
      const dt = e.clipboardData;
      if (!dt) return;
      const pos = flowPosAt(lastMouse.current);
      const text = dt.getData('text/plain').trim();
      const files = Array.from(dt.files);
      // FILES WIN when a real document rides along: a Finder/Explorer copy
      // puts the file's PATH in text/plain and the file itself in files —
      // the user copied a file, not its path (regression fixed: the plain
      // text-wins rule ate these). TEXT wins only over image-only files:
      // Word/Excel selections carry text plus a bitmap rendering of it,
      // and there the user copied words, not a picture of words.
      const hasDocFile = files.some((f) => !f.type.startsWith('image/'));
      if (files.length > 0 && (hasDocFile || !text)) {
        e.preventDefault();
        const id = spawnContentNode('file', pos);
        void ingestFiles(id, files);
        return;
      }
      if (text) {
        e.preventDefault();
        if (/^https?:\/\/\S+$/.test(text)) {
          const id = spawnContentNode('link', pos, { linkUrl: text });
          void fetchLinkIntoNode(id, text);
        } else {
          spawnContentNode('note', pos, { question: clipboardTextToMarkdown(text) });
        }
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('paste', onPaste);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('paste', onPaste); };
  }, [flowPosAt]);

  const instantiate = useCallback(async () => {
    const st = useStore.getState();
    if (st.nodes.length === 0) return;
    const { nodes: cNodes, edges: cEdges } = instantiateParadigm(st.nodes, st.edges);
    const meta = useProjects.getState();
    const pname = meta.projects.find((p) => p.id === meta.activeId)?.name ?? 'Paradigm';
    const id = crypto.randomUUID();
    await idbSet(projectStorageKey(id), JSON.stringify({ state: { nodes: cNodes, edges: cEdges }, version: 1 }));
    await adoptImportedProject(id, `▶ ${pname}`, 'chat');
    await markInstantiatedFrom(id, pname); // provenance rides in the backup
    prevNodeCount.current = useStore.getState().nodes.length;
    setTimeout(() => rfInstance.current?.fitView({ duration: 400, padding: 0.15 }), 150);
  }, []);

  // First visit lands on the LANDING page — the example canvas is one
  // labeled click away there, not an ambush.
  useEffect(() => {
    // The seeded flag is write-only in app code; it stays as the hook
    // scripts/smoke.mjs uses to suppress the landing flow in tests.
    if (nodes.length === 0 && !isParadigm && !localStorage.getItem('thoughtdag.seeded')) {
      localStorage.setItem('thoughtdag.seeded', 'yes');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (nodes.length > prevNodeCount.current && rfInstance.current) {
      const newest = nodes[nodes.length - 1];
      if (newest) {
        setTimeout(() => centerNode(newest, { zoom: 1, duration: 400, offX: 220 }), 100);
      }
    }
    prevNodeCount.current = nodes.length;
  }, [nodes, centerNode]);

  // Apply React Flow changes against the LIVE store state, never the render
  // closure: a click that both mutates a node (e.g. submitting a human turn)
  // and emits a selection change in the same tick would otherwise clobber
  // the mutation with the stale pre-render snapshot.
  const onNodesChange: OnNodesChange = useCallback(
    (changes) => {
      const current = useStore.getState().nodes;
      setNodes(applyNodeChanges(changes, current) as typeof current);
    },
    [setNodes]
  );

  const onEdgesChange: OnEdgesChange = useCallback(
    (changes) => setEdges(applyEdgeChanges(changes, useStore.getState().edges)),
    [setEdges]
  );

  // Frame drag carries its contents: a frame is a region, so moving the
  // region moves what's inside it. Membership is decided ONCE at drag start
  // (node centers inside the frame box); positions then follow the frame's
  // delta from ITS start position, so there is no incremental drift.
  const frameDrag = useRef<{ frameId: string; start: { x: number; y: number }; members: { id: string; start: { x: number; y: number } }[] } | null>(null);
  const onNodeDragStart: OnNodeDrag<ThoughtNodeType> = useCallback((_e, node) => {
    // unlinked frames (frameCarry === false) move alone — the state while
    // the frame itself is still being adjusted over its nodes
    if (node.data.stepKind !== 'frame' || node.data.frameCarry === false) return;
    const st = useStore.getState();
    const frame = st.nodes.find((n) => n.id === node.id);
    if (!frame) return;
    // membership is the shared rule (lib/frames): nodes by centre, frames only
    // when fully inside — a partially overlapping frame stays behind with its
    // own members. Selected nodes are already moved by the multi-select drag.
    const members = frameMembers(frame, st.nodes)
      .filter((n) => !n.selected)
      .map((n) => ({ id: n.id, start: n.position }));
    if (members.length === 0) return;
    frameDrag.current = { frameId: frame.id, start: frame.position, members };
  }, []);
  const onNodeDrag: OnNodeDrag<ThoughtNodeType> = useCallback((_e, node) => {
    const drag = frameDrag.current;
    if (!drag || node.id !== drag.frameId) return;
    const dx = node.position.x - drag.start.x;
    const dy = node.position.y - drag.start.y;
    const moved = new Map(drag.members.map((m) => [m.id, { x: m.start.x + dx, y: m.start.y + dy }]));
    useStore.setState((st) => ({
      nodes: st.nodes.map((n) => {
        const pos = moved.get(n.id);
        return pos ? { ...n, position: pos } : n;
      }),
    }));
  }, []);
  const onNodeDragStop: OnNodeDrag<ThoughtNodeType> = useCallback(() => { frameDrag.current = null; }, []);

  // Edge right-click context menu
  const [edgeMenu, setEdgeMenu] = useState<{ x: number; y: number; edgeId: string } | null>(null);
  const [nodeMenu, setNodeMenu] = useState<{ x: number; y: number; nodeId: string } | null>(null);
  const onNodeContextMenu = useCallback((e: React.MouseEvent, node: { id: string }) => {
    if (isViewerMode) return; // read-only: keep the browser menu
    // Right-click on selected TEXT keeps the native menu (copy must work)
    if (window.getSelection()?.toString()) return;
    e.preventDefault();
    setNodeMenu({ x: e.clientX, y: e.clientY, nodeId: node.id });
  }, []);

  const onEdgeContextMenu = useCallback(
    (event: React.MouseEvent, edge: { id: string }) => {
      event.preventDefault();
      setEdgeMenu({ x: event.clientX, y: event.clientY, edgeId: edge.id });
    },
    []
  );

  // Close menu on click anywhere
  useEffect(() => {
    if (!edgeMenu) return;
    const handler = () => setEdgeMenu(null);
    window.addEventListener('click', handler);
    return () => window.removeEventListener('click', handler);
  }, [edgeMenu]);

  const deleteEdges = useStore((s) => s.deleteEdges);

  const deleteEdge = useCallback(
    (edgeId: string) => {
      deleteEdges([edgeId]);
      setEdgeMenu(null);
    },
    [deleteEdges]
  );

  const onConnect: OnConnect = useCallback(
    (connection) => {
      if (connection.source && connection.target) {
        addCrossLink(connection.source, connection.target);
      }
    },
    [addCrossLink]
  );

  // Wire-drag must never start a text selection in the cards it crosses
  const onConnectStart = useCallback(() => {
    window.getSelection()?.removeAllRanges();
    document.body.classList.add('tdag-connecting');
  }, []);
  // Dropping a wire on empty canvas = "continue from here": a fresh ask
  // node at the drop point, wired as a solid child (same as a follow-up).
  // Wiring to an EXISTING node stays a dashed reference — the distinction
  // is newborn vs. existing conversation, not which handle you aimed at.
  const onConnectEnd = useCallback<NonNullable<React.ComponentProps<typeof ReactFlow>['onConnectEnd']>>((event, connectionState) => {
    document.body.classList.remove('tdag-connecting');
    if (isParadigm) return;
    if (connectionState.isValid) return; // landed on a handle — onConnect owns it
    if (connectionState.fromHandle?.type !== 'source' || !connectionState.fromNode) return;
    const parentId = connectionState.fromNode.id;
    // Dropped on a card (not a handle): connect as a reference — aiming at
    // the card is enough. Materials and frames accept nothing (One Rule).
    const overNode = (event.target as HTMLElement)?.closest?.('.react-flow__node');
    if (overNode) {
      const targetId = overNode.getAttribute('data-id');
      if (targetId && targetId !== parentId) {
        const tgt = useStore.getState().nodes.find((n) => n.id === targetId);
        const kind = tgt?.data.stepKind ?? '';
        if (tgt && !['note', 'file', 'link', 'frame'].includes(kind)) {
          useStore.getState().addCrossLink(parentId, targetId);
        }
      }
      return;
    }
    const { clientX, clientY } = 'changedTouches' in event ? event.changedTouches[0] : event;
    const pos = flowPosAt({ x: clientX, y: clientY });
    const st = useStore.getState();
    if (st.nodes.find((n) => n.id === parentId)?.data.stepKind === 'frame') return;
    const newId = spawnAskNode(pos);
    st.setEdges([...useStore.getState().edges, {
      id: `edge-${parentId}-${newId}`,
      source: parentId,
      target: newId,
      sourceHandle: 'continue',
      targetHandle: 'top',
      type: 'smoothstep',
      style: { stroke: COLORS.accent, strokeWidth: 2 },
      animated: false,
      markerEnd: { type: 'arrowclosed' as const, color: COLORS.accent, width: 18, height: 18 },
      data: {},
    }]);
    useStore.getState().pushHistory();
  }, [isParadigm, flowPosAt, spawnAskNode]);

  const selectedNodeId = useStore((s) => s.selectedNodeId);
  const selectedNodeIds = useStore((s) => s.selectedNodeIds);
  // Content nodes and frames are edited in place on the canvas — no panel.
  // The panel is a MODE: double-click opens it, its X closes it; while on,
  // it follows the selection. Single clicks only select (no side effects).
  const panelMode = useUiStore((s) => s.panelOpen);
  const viewerLoadError = useUiStore((s) => s.viewerLoadError);
  const staleCount = useStore((s) => s.staleIds.length);
  const livePanelWidth = useUiStore((s) => s.panelWidth);
  const selectedKind = nodes.find((nd) => nd.id === selectedNodeId)?.data.stepKind;
  const selectedIsContent = isContentKind(selectedKind) || selectedKind === 'frame';
  const panelOpen = panelMode && !!selectedNodeId && !isParadigm && !selectedIsContent;
  const multiSelected = selectedNodeIds.length > 1;
  const batchDelete = useStore((s) => s.batchDelete);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // While the confirm dialog is open it owns the keyboard
      if (useUiStore.getState().confirmRequest) return;
      // Viewer: only Cmd+F search survives; every mutating shortcut is inert
      if (isViewerMode && !((e.metaKey || e.ctrlKey) && e.key === 'f')) return;
      if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
        if (e.shiftKey) { e.preventDefault(); redo(); }
        else { e.preventDefault(); undo(); }
      }
      // Cmd+F: node search (replaces browser find on the canvas)
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault();
        setSearchOpen(true);
        return;
      }
      {
        const target = e.target as HTMLElement;
        const inField = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;
        if (!inField && selectedNodeId && !isParadigm && !e.metaKey && !e.ctrlKey && !e.altKey) {
          const { nodes: ns, edges: es } = useStore.getState();
          // Space: collapse/expand the selected node
          if (e.key === ' ') {
            e.preventDefault();
            useStore.getState().toggleCollapse(selectedNodeId);
            return;
          }
          // R: regenerate in place (same semantic as the UI button)
          if (e.key === 'r' || e.key === 'R') {
            e.preventDefault();
            void useStore.getState().rerunNode(selectedNodeId, {});
            return;
          }
          // Arrow keys: walk the DAG (structural edges only)
          if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
            const structural = es.filter((ed) => !ed.data?.isCrossLink);
            let nextId: string | undefined;
            if (e.key === 'ArrowUp') {
              nextId = structural.find((ed) => ed.target === selectedNodeId)?.source;
            } else if (e.key === 'ArrowDown') {
              nextId = structural.find((ed) => ed.source === selectedNodeId)?.target;
            } else {
              const parentEdge = structural.find((ed) => ed.target === selectedNodeId);
              const siblings = parentEdge
                ? structural.filter((ed) => ed.source === parentEdge.source).map((ed) => ed.target)
                : ns.filter((n) => !structural.some((ed) => ed.target === n.id)).map((n) => n.id);
              const idx = siblings.indexOf(selectedNodeId);
              if (idx !== -1 && siblings.length > 1) {
                nextId = siblings[(idx + (e.key === 'ArrowRight' ? 1 : siblings.length - 1)) % siblings.length];
              }
            }
            if (nextId) {
              e.preventDefault();
              setSelectedNodeId(nextId);
              const target2 = ns.find((n) => n.id === nextId);
              if (target2) centerNode(target2, { zoom: 1, duration: 300 });
            }
            return;
          }
        }
      }
      // Esc: step out — clear multi-selection first, then close the panel
      if (e.key === 'Escape') {
        const target = e.target as HTMLElement;
        if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;
        if (selectedNodeIds.length > 1) {
          setSelectedNodeIds([]);
        } else if (selectedNodeId) {
          setSelectedNodeId(null);
        }
        return;
      }
      // Delete/Backspace: multi-selected nodes (confirm) or selected edges
      if (e.key === 'Delete' || e.key === 'Backspace') {
        const target = e.target as HTMLElement;
        if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;
        if (selectedNodeIds.length > 1) {
          e.preventDefault();
          void confirmDialog({
            title: ti('confirm.deleteNodesTitle'),
            message: fmt(ti('confirm.deleteNodes'), { n: selectedNodeIds.length }),
            confirmLabel: ti('common.delete'),
            danger: true,
          }).then((ok) => { if (ok) batchDelete(selectedNodeIds); });
        } else {
          const selectedEdgeIds = edges.filter((ed) => ed.selected).map((ed) => ed.id);
          if (selectedEdgeIds.length > 0) {
            e.preventDefault();
            deleteEdges(selectedEdgeIds);
          }
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [undo, redo, selectedNodeId, selectedNodeIds, setSelectedNodeId, setSelectedNodeIds, batchDelete, edges, deleteEdges, isParadigm, centerNode]);

  const handleSubmit = () => {
    if (!inputValue.trim()) return;
    addQuestion(inputValue.trim(), {
      rolePrompt: rootRole.trim() || undefined,
      initialAttachments: pendingAttachments.length > 0 ? pendingAttachments : undefined,
    });
    setInputValue('');
    setRootRole('');
    setShowRootRole(false);
    setPendingAttachments([]);
  };

  const handleFileUpload = async (files: FileList | File[]) => {
    for (const file of Array.from(files)) {
      await processFile(file, {
        add: (att) => setPendingAttachments((prev) => [...prev, att]),
        update: (attId, patch) => setPendingAttachments((prev) => prev.map((a) =>
          a.id === attId ? { ...a, ...patch } : a
        )),
      });
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !isImeComposing(e)) { e.preventDefault(); handleSubmit(); }
  };

  const onSelectionChange = useCallback(({ nodes: selectedNodes }: { nodes: { id: string }[] }) => {
    const ids = selectedNodes.map((n) => n.id);
    if (ids.length > 1) {
      setSelectedNodeIds(ids);
    } else if (ids.length === 1) {
      setSelectedNodeId(ids[0]);
    }
    // don't clear on 0 — paneClick handles that
  }, [setSelectedNodeId, setSelectedNodeIds]);

  // Highlight ancestor edges for selected node(s)
  // Frame navigator: named regions become a jumpable table of contents
  const frames = useMemo(() => nodes.filter((n) => n.data.stepKind === 'frame'), [nodes]);
  const [frameNavOpen, setFrameNavOpen] = useState(false);

  // Toolbar overflow menu: low-frequency actions live behind one ⋯ button
  // so the top-right row stays short in both languages and with the panel
  // dragged wide.
  const [moreOpen, setMoreOpen] = useState(false);
  const pluginUpdate = useUiStore((s) => s.pluginUpdate);
  const [diagPing, setDiagPing] = useState(0);
  const searching = useUiStore((s2) => s2.searchHitIds !== null);

  // Annotation view mode: hide frames + UNLINKED content nodes (linked
  // material stays — it's part of the reasoning record). A filter over the
  // render, not a layer system: the semantic layering already lives in edges.
  const searchHitIds = useUiStore((s2) => s2.searchHitIds);
  // Context Focus: single-selection lights up what the node actually
  // receives (mainline + materials + reference sources, via the same
  // partitionContext the prompt builder uses) and dims the rest. Read-only.
  const focusSets = useMemo(() => {
    if (!selectedNodeId || selectedNodeIds.length > 1) return null;
    if (!nodes.some((n) => n.id === selectedNodeId)) return null;
    const part = partitionContext(selectedNodeId, nodes, edges);
    const ctx = new Set<string>();
    for (const n of part.mainline) if (n.id !== selectedNodeId) ctx.add(n.id);
    for (const n of part.materials) ctx.add(n.id);
    for (const r of part.references) ctx.add(r.source.id);
    const structural = edges.filter((e) => !e.data?.isCrossLink);
    const pathEdgeIds = walkUpAncestors(selectedNodeId, nodes, structural).visitedEdgeIds;
    const refEdgeIds = new Set(part.references.map((r) => r.edge.id));
    const downOut = structural.filter((e) => e.source === selectedNodeId);
    return {
      ctx,
      down: new Set(downOut.map((e) => e.target)),
      pathEdgeIds, refEdgeIds,
      downEdgeIds: new Set(downOut.map((e) => e.id)),
    };
  }, [selectedNodeId, selectedNodeIds, nodes, edges]);

  const displayNodes = useMemo((): typeof nodes => {
    // Smaller frames represent more specific regions, so render them above
    // larger frames while keeping every frame below ordinary canvas nodes.
    // Equal-sized overlaps keep their existing array order.
    const stackedFrames = nodes
      .filter((n) => n.data.stepKind === 'frame')
      .map((n, order) => ({
        id: n.id,
        order,
        area: (n.measured?.width ?? n.width ?? 640) * (n.measured?.height ?? n.height ?? 420),
      }))
      .sort((a, b) => b.area - a.area || a.order - b.order);
    const frameZ = new Map(stackedFrames.map((frame, index) => [frame.id, index - stackedFrames.length]));
    let out = nodes.map((n) => (
      n.data.stepKind === 'frame' ? { ...n, zIndex: frameZ.get(n.id) ?? -1 } : n
    ));
    if (annotationsHidden) {
      out = out.map((n) => {
        const k = n.data.stepKind;
        const unlinkedContent = isContentKind(k) && !edges.some((e) => e.source === n.id || e.target === n.id);
        return (k === 'frame' || unlinkedContent) ? { ...n, hidden: true } : n;
      });
    }
    // The searchlight: hits stay lit, everything else dims (CSS does the
    // dimming via [data-searching]; frames stay out — they are the ground).
    if (searchHitIds !== null) {
      out = out.map((n) => (
        searchHitIds.has(n.id) || n.data.stepKind === 'frame'
          ? { ...n, className: 'search-hit' }
          : n.className === 'search-hit' ? { ...n, className: undefined } : n
      ));
    }
    if (focusSets) {
      out = out.map((n) => {
        const role = n.id === selectedNodeId ? 'target'
          : focusSets.ctx.has(n.id) ? 'ctx'
          : focusSets.down.has(n.id) ? 'down'
          : n.data.stepKind === 'frame' ? undefined : 'dim';
        if (!role) return n;
        return {
          ...n,
          className: [n.className, `focus-${role}`].filter(Boolean).join(' '),
          ...(role !== 'dim' ? { data: { ...n.data, focusRole: role as 'target' | 'ctx' | 'down' } } : {}),
        };
      });
    }
    return out;
  }, [nodes, edges, annotationsHidden, searchHitIds, focusSets, selectedNodeId]);

  const highlightedEdges = useMemo((): ThoughtEdge[] => {
    // Visual law: SOLID = structural (conversation, layout, cascade),
    // DASHED = bypass (references, watch). Explore branches are structural,
    // so legacy dashed-orange branch edges are normalized to solid here
    // (styles persist per edge; this fixes old canvases centrally).
    // Theme mapping happens here too: storage keeps the canonical light hex
    // as the edge's semantic identity, the render layer resolves it against
    // the active theme — old backups need no migration.
    const base = edges.map((raw) => {
      const e = raw.data?.isBranchFromSelection
        ? { ...raw, animated: false, style: { ...raw.style, strokeDasharray: undefined } }
        : raw;
      const strokeSlot = typeof e.style?.stroke === 'string' ? LEGACY_EDGE_HEX[e.style.stroke.toUpperCase()] : undefined;
      const marker = e.markerEnd && typeof e.markerEnd === 'object' ? e.markerEnd : undefined;
      const markerSlot = typeof marker?.color === 'string' ? LEGACY_EDGE_HEX[marker.color.toUpperCase()] : undefined;
      if (!strokeSlot && !markerSlot) return e;
      return {
        ...e,
        ...(strokeSlot ? { style: { ...e.style, stroke: themePalette[strokeSlot] } } : {}),
        ...(markerSlot && marker ? { markerEnd: { ...marker, color: themePalette[markerSlot] } } : {}),
      };
    });
    if (focusSets) {
      return base.map((e) => {
        if (focusSets.pathEdgeIds.has(e.id)) {
          return {
            ...e,
            className: 'focus-e-path',
            style: { ...e.style, stroke: themePalette.accent, strokeWidth: 3.5, opacity: 1 },
            markerEnd: { type: 'arrowclosed' as const, ...((e.markerEnd && typeof e.markerEnd === 'object') ? e.markerEnd : {}), color: themePalette.accent },
            zIndex: 10,
            data: { ...e.data, focusRole: 'path' as const },
          };
        }
        if (focusSets.refEdgeIds.has(e.id)) {
          // reference INTO the context: it feeds the model (as a fenced
          // block), so it stays visible — dashed identity untouched
          return { ...e, style: { ...e.style, opacity: 0.9 }, zIndex: 5, data: { ...e.data, focusRole: 'ref' as const } };
        }
        if (focusSets.downEdgeIds.has(e.id)) {
          return {
            ...e,
            className: 'focus-e-down',
            style: { ...e.style, strokeWidth: 2.5, opacity: 0.85 },
            markerEnd: { type: 'arrowclosed' as const, ...((e.markerEnd && typeof e.markerEnd === 'object') ? e.markerEnd : {}) },
            zIndex: 5,
            data: { ...e.data, focusRole: 'down' as const },
          };
        }
        return { ...e, style: { ...e.style, strokeWidth: 1.5, opacity: 0.2 }, zIndex: 0 };
      });
    }
    const activeIds = selectedNodeIds.length > 1 ? selectedNodeIds : [];
    if (activeIds.length === 0) return base;

    // Walk up from each selected node, collect all ancestor edge ids
    const { visitedEdgeIds: ancestorEdgeIds } = walkUpAncestors(activeIds, nodes, edges);

    return base.map((e) => {
      if (ancestorEdgeIds.has(e.id)) {
        return {
          ...e,
          style: { ...e.style, stroke: themePalette.trace, strokeWidth: 3.5, opacity: 1 },
          markerEnd: { type: 'arrowclosed' as const, ...((e.markerEnd && typeof e.markerEnd === 'object') ? e.markerEnd : {}), color: themePalette.trace },
          zIndex: 10,
        };
      }
      // Dim non-ancestor edges
      return {
        ...e,
        style: { ...e.style, strokeWidth: 1.5, opacity: 0.2 },
        zIndex: 0,
      };
    });
  }, [nodes, edges, selectedNodeIds, themePalette, focusSets]);

  // The panel is an overlay — the canvas never resizes. When it opens (or
  // the selection moves while it is open) and the selected node would be
  // hidden underneath it, the node re-centers in the space LEFT of the
  // panel — the visible half becomes the stage, not a peek-out sliver.
  useEffect(() => {
    if (!panelOpen || !selectedNodeId) return;
    const timer = setTimeout(() => {
      const rf = rfInstance.current;
      if (!rf) return;
      const node = useStore.getState().nodes.find((n) => n.id === selectedNodeId);
      if (!node) return;
      const vp = rf.getViewport();
      const w = node.measured?.width ?? node.width ?? 480;
      const nodeRight = (node.position.x + w) * vp.zoom + vp.x;
      const visibleRight = window.innerWidth - useUiStore.getState().panelWidth - PANEL_INSET - 24;
      if (nodeRight > visibleRight) {
        const nodeCenter = (node.position.x + w / 2) * vp.zoom + vp.x;
        rf.setViewport({ ...vp, x: vp.x - (nodeCenter - visibleRight / 2) }, { duration: 300 });
      }
    }, 60);
    return () => clearTimeout(timer);
  }, [panelOpen, selectedNodeId]);

  return (
    <div className="relative w-full h-full" data-searching={searching || undefined}>
      {/* Canvas — full width always; the focus panel floats on top of it */}
      <div
        className="relative h-full w-full"
        onDoubleClick={(e) => {
          // Double-click on empty canvas → drop an ask node right there
          // (same gesture family as double-click-on-node = open panel)
          if ((e.target as HTMLElement).classList.contains('react-flow__pane') && !isParadigm) {
            spawnAskNode(flowPosAt({ x: e.clientX, y: e.clientY }));
          }
        }}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('application/thoughtdag-content') || e.dataTransfer.types.includes('Files')) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
            if (!hasNodes && !isParadigm) setIsDraggingLanding(true);
          }
        }}
        onDrop={(e) => {
          if (isViewerMode) return;
          const el = e.target as HTMLElement;
          // Landing (empty canvas): dropping a document means "start from
          // this material" — file nodes + the reader, not attachments
          if (!hasNodes && !isParadigm && e.dataTransfer.files.length > 0) {
            e.preventDefault();
            setIsDraggingLanding(false);
            startFromDocuments(e.dataTransfer.files);
            return;
          }
          // Drops land on the empty pane OR inside a frame region (frames
          // cover large areas; a file dropped there should still land)
          const overNode = el.closest?.('.react-flow__node');
          const overFrame = overNode && useStore.getState().nodes.find((n) => n.id === overNode.getAttribute('data-id'))?.data.stepKind === 'frame';
          if (!el.classList?.contains('react-flow__pane') && !overFrame) return;
          const pos = flowPosAt({ x: e.clientX, y: e.clientY });
          const paletteKind = e.dataTransfer.getData('application/thoughtdag-content');
          if (paletteKind === 'ask') {
            e.preventDefault();
            spawnAskNode(pos);
            return;
          }
          if (paletteKind === 'frame') {
            e.preventDefault();
            spawnFrame(pos);
            return;
          }
          if (paletteKind === 'note' || paletteKind === 'file') {
            e.preventDefault();
            spawnContentNode(paletteKind, pos);
            return;
          }
          if (e.dataTransfer.files.length > 0) {
            e.preventDefault();
            const files = filterDroppedFiles(e.dataTransfer.files);
            if (files.length === 0) return;
            const id = spawnContentNode('file', pos);
            void ingestFiles(id, files);
          }
        }}
      >
      <ReactFlow
        onInit={(instance) => {
          rfInstance.current = instance;
          recapCamera.current = instance;
          // Debug: expose the flow instance for screenshot/e2e scripts (DEV only)
          if (import.meta.env.DEV) (window as unknown as { __rf?: typeof instance }).__rf = instance;
          // A freshly imported session arrives at its working tail, not a
          // bird's-eye column (one-shot, set by the importer)
          const focusId = useUiStore.getState().arrivalFocusNodeId;
          if (focusId) {
            useUiStore.getState().setArrivalFocusNodeId(null);
            const n = useStore.getState().nodes.find((x) => x.id === focusId);
            if (n) {
              window.setTimeout(() => {
                instance.setCenter(n.position.x + 260, n.position.y + 140, { zoom: 0.9, duration: 400 });
              }, 150);
            }
          }
        }}
        nodes={displayNodes}
        edges={highlightedEdges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStart={onNodeDragStart}
        onNodeDrag={onNodeDrag}
        onNodeDragStop={onNodeDragStop}
        onConnect={onConnect}
        onConnectStart={onConnectStart}
        onConnectEnd={onConnectEnd}
        onEdgeContextMenu={onEdgeContextMenu}
        onNodeContextMenu={onNodeContextMenu}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        deleteKeyCode={null}
        fitView
        // Cull off-viewport nodes: a content-heavy canvas keeps dozens of
        // full markdown/KaTeX card DOMs mounted otherwise, and zoom/pan
        // transforms all of them every frame.
        onlyRenderVisibleElements
        // 0.04, not 0.1: a canvas with a condensed copy beside the original
        // doubles in width — the overview must still fit in one screen for
        // whole-branch selection and cleanup.
        minZoom={0.04}
        maxZoom={2}
        defaultEdgeOptions={{
          type: 'smoothstep',
          animated: false,
          style: { stroke: themePalette.accent, strokeWidth: 2 },
          markerEnd: { type: 'arrowclosed' as const, color: themePalette.accent, width: 18, height: 18 },
        }}
        snapToGrid={paperTexture === 'grid'}
        snapGrid={[22, 22]}
        proOptions={{ hideAttribution: true }}
        nodeDragThreshold={5}
        connectionRadius={40}
        selectionMode={SelectionMode.Partial}
        selectionOnDrag={!isViewerMode}
        nodesDraggable={!isViewerMode}
        nodesConnectable={!isViewerMode}
        panOnDrag={isViewerMode ? true : [1, 2]}
        zoomOnDoubleClick={false}
        connectionLineStyle={{ stroke: themePalette.accent, strokeDasharray: '8 4', strokeWidth: 2 }}
        onSelectionChange={onSelectionChange}
        onPaneClick={() => { setSelectedNodeId(null); setSelectedNodeIds([]); setNodeMenu(null); }}
      >
        {paperTexture === 'grid' ? (
          <>
            {/* the drafting board: fine grid + a major line every 5 cells */}
            <Background id="grid-fine" variant={BackgroundVariant.Lines} gap={22} color="var(--canvas-grid-fine)" />
            <Background id="grid-major" variant={BackgroundVariant.Lines} gap={110} color="var(--canvas-grid-major)" />
          </>
        ) : (
          <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="var(--canvas-dot)" />
        )}
        <ZoomTierTag />
        <ThoughtMapPill panelShiftWidth={panelOpen ? livePanelWidth : 0} />
        <TimelineBar />
        <Controls position="bottom-left" />
        {nodes.length > 0 && <MiniMap
          nodeColor={(node) => {
            const data = node.data as Record<string, unknown>;
            // information density over decoration: type is color, archived
            // fades to paper, ordinary turns stay a readable mid-gray
            if (data.archived) return MINIMAP_COLORS.archived;
            const sk = data.stepKind as string | undefined;
            if (sk === 'note') return '#D97706';
            if (sk === 'file' || sk === 'link') return '#64748B';
            if (Array.isArray(data.condensedFrom) && data.condensedFrom.length) return '#8B7CF0';
            return data.isRoot ? themePalette.accent : data.isBranch ? themePalette.warm : MINIMAP_COLORS.ordinary;
          }}
          maskColor={MINIMAP_COLORS.mask}
          style={{ width: 200, height: 140 }}
          pannable
          zoomable
          position="bottom-right"
        />}
      </ReactFlow>

      {/* Initial input */}
      {!hasNodes && isParadigm && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="text-center pointer-events-auto">
            <p className="text-sm text-muted-foreground mb-1 font-medium">{t('paradigm.emptyTitle')}</p>
            <p className="text-xs text-muted-foreground mb-4 max-w-sm leading-relaxed">{t('paradigm.emptyHint')}</p>
            <div className="flex items-center justify-center gap-2">
              <Button variant="ghost"
                onClick={() => addStep('human')}
                className="text-sm border-2 border-dashed border-edge-explore/60 text-edge-explore hover:bg-edge-explore/10"
              >
                <MessageCircleQuestion size={15} strokeWidth={1.75} /> {t('paradigm.addHuman')}
              </Button>
              <Button variant="ghost"
                onClick={() => addStep('prompt')}
                className="text-sm border-2 border-dashed border-primary/50 text-primary hover:bg-primary/10"
              >
                <SquareTerminal size={15} strokeWidth={1.75} /> {t('paradigm.addPrompt')}
              </Button>
            </div>
          </div>
        </div>
      )}
      {isViewerMode && !hasNodes && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="text-center max-w-[420px] px-6">
            {viewerLoadError ? (
              <>
                <div className="text-3xl mb-3">🔗</div>
                <div className="text-sm font-semibold text-foreground mb-1.5">{t('viewer.loadError')}</div>
                <p className="text-xs text-muted-foreground leading-relaxed">{t('viewer.loadErrorHint')}</p>
              </>
            ) : (
              <div className="flex items-center gap-2 text-sm text-muted-foreground justify-center">
                <Loader2 size={16} strokeWidth={1.75} className="animate-spin text-primary" /> {t('viewer.loading')}
              </div>
            )}
          </div>
        </div>
      )}
      {!hasNodes && !isParadigm && !isViewerMode && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none overflow-hidden">
          {/* Watermark: faint DAG sketches anchoring the corners */}
          <svg className="absolute -left-10 top-[8%] w-[360px] h-[300px] opacity-[0.35] pointer-events-none" viewBox="0 0 360 300" aria-hidden>
            <path d="M80 40 C80 90 80 90 80 130 M80 170 C80 210 80 210 80 250" stroke="var(--border)" strokeWidth="2" fill="none" />
            <path d="M95 150 C150 150 150 90 205 88" stroke="var(--border)" strokeWidth="2" strokeDasharray="6 5" fill="none" />
            <circle cx="80" cy="30" r="7" fill="var(--border)" />
            <circle cx="80" cy="150" r="7" fill="none" stroke="var(--border)" strokeWidth="2.5" />
            <circle cx="80" cy="262" r="7" fill="var(--border)" />
            <circle cx="218" cy="88" r="7" fill="var(--border)" />
          </svg>
          <svg className="absolute right-[-30px] bottom-[10%] w-[320px] h-[280px] opacity-[0.35] pointer-events-none" viewBox="0 0 320 280" aria-hidden>
            <path d="M240 30 C240 80 240 80 240 120 M240 160 C240 200 240 200 240 240" stroke="var(--border)" strokeWidth="2" fill="none" />
            <path d="M225 140 C170 140 170 210 115 212" stroke="var(--border)" strokeWidth="2" strokeDasharray="6 5" fill="none" />
            <circle cx="240" cy="20" r="7" fill="var(--border)" />
            <circle cx="240" cy="140" r="7" fill="none" stroke="var(--border)" strokeWidth="2.5" />
            <circle cx="240" cy="252" r="7" fill="var(--border)" />
            <circle cx="102" cy="212" r="7" fill="var(--border)" />
          </svg>

          <div className="pointer-events-auto w-[560px] animate-fade-in relative">
            <div className="text-center mb-8">
              {/* Mark: a tiny DAG lighting up — main chain in accent, explore branch in warm */}
              <svg width="52" height="52" viewBox="0 0 44 44" className="mx-auto mb-4" aria-hidden>
                <circle className="dag-pop" style={{ animationDelay: '0.05s' }} cx="22" cy="7" r="3.5" fill="var(--primary)" />
                <line className="dag-pop" style={{ animationDelay: '0.2s' }} x1="22" y1="11" x2="22" y2="19" stroke="var(--primary)" strokeWidth="2" strokeLinecap="round" />
                <circle className="dag-pop" style={{ animationDelay: '0.35s' }} cx="22" cy="22" r="3.5" fill="none" stroke="var(--primary)" strokeWidth="2.5" />
                <line className="dag-pop" style={{ animationDelay: '0.5s' }} x1="22" y1="25" x2="22" y2="33" stroke="var(--primary)" strokeWidth="2" strokeLinecap="round" />
                <circle className="dag-pop" style={{ animationDelay: '0.65s' }} cx="22" cy="37" r="3.5" fill="var(--primary)" opacity="0.35" />
                <line className="dag-pop" style={{ animationDelay: '0.8s' }} x1="25.5" y1="23.5" x2="33" y2="28.5" stroke="var(--edge-explore)" strokeWidth="2" strokeLinecap="round" strokeDasharray="3 3" />
                <circle className="dag-pop" style={{ animationDelay: '0.95s' }} cx="36" cy="30" r="3.5" fill="var(--edge-explore)" />
              </svg>
              <h1 className="text-4xl font-semibold tracking-tight text-foreground mb-2.5">ThoughtDAG</h1>
              <p className="text-sm text-muted-foreground">{t('landing.tagline')}</p>
              <p className="text-xs text-muted-foreground mt-1.5 font-medium">{t('landing.mechanism')}</p>
            </div>
            <div
              className="bg-card border border-border rounded-xl px-5 py-4 shadow-lg transition-all focus-within:border-primary/50 focus-within:shadow-xl"
            >
              <textarea
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyDown={handleKeyDown}
                onPaste={(e) => {
                  if (e.clipboardData.getData('text/plain').trim()) return; // TEXT WINS, same rule as canvas paste
                  const files = Array.from(e.clipboardData.items).filter(i => i.kind === 'file').map(i => i.getAsFile()!).filter(Boolean);
                  if (files.length) handleFileUpload(files);
                }}
                placeholder={t('landing.placeholder')}
                className="w-full bg-transparent text-foreground text-sm leading-relaxed resize-none focus:outline-none placeholder-muted-foreground"
                rows={3}
                autoFocus
              />
              {/* Pending attachments preview */}
              {pendingAttachments.length > 0 && (
                <div className="flex flex-wrap gap-2 mt-2 pb-1">
                  {pendingAttachments.map((att) => (
                    <div key={att.id} className="flex items-center gap-1.5 bg-muted rounded-lg px-2.5 py-1.5 group">
                      {att.thumbnailUrl ? (
                        <img src={att.thumbnailUrl} className="w-6 h-6 rounded object-cover" alt={att.name} />
                      ) : (
                        <span className="text-xs"><FileText size={16} strokeWidth={1.75} /></span>
                      )}
                      <span className="text-xs text-muted-foreground max-w-[100px] truncate">{att.name}</span>
                      {att.isExtracting && <span className="text-2xs text-primary"><Loader2 className="animate-spin" size={12} strokeWidth={1.75} /></span>}
                      {att.numPages != null && <span className="text-2xs text-muted-foreground">{att.numPages}p</span>}
                      <Button variant="ghost" size="sm"
                        onClick={() => setPendingAttachments((p) => p.filter((a) => a.id !== att.id))}
                        className="text-muted-foreground hover:text-destructive/90 text-xs opacity-0 group-hover:opacity-100"
                      ><X size={14} strokeWidth={1.75} /></Button>
                    </div>
                  ))}
                </div>
              )}
              {/* Role area: opened from the tray icon — an ask-time option,
                  not a decision the landing asks you to make up front */}
              {showRootRole && (
                <div className="space-y-1 mt-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-muted-foreground font-medium">{t('landing.roleLabel')}</span>
                    <Button variant="ghost" size="sm" onClick={() => { setShowRootRole(false); setRootRole(''); }} className="text-xs text-muted-foreground hover:text-muted-foreground"><X size={14} strokeWidth={1.75} /></Button>
                  </div>
                  <Textarea
                    value={rootRole}
                    onChange={(e) => setRootRole(e.target.value)}
                    placeholder={t('landing.rolePlaceholder')}
                    className="w-full resize-none leading-relaxed"
                    rows={2}
                    autoFocus
                  />
                  <RoleTemplateChips onPick={setRootRole} />
                </div>
              )}
              <div className="flex items-center justify-end mt-2 gap-2">
                <SearchToggles />
                <Button variant="ghost"
                  onClick={() => setShowRootRole(!showRootRole)}
                  title={t('landing.roleTrayTitle')}
                  className={`rounded-full w-8 h-8 flex items-center justify-center transition-colors shrink-0 ${
                    showRootRole || rootRole ? 'text-primary bg-primary/10 hover:bg-primary/20' : 'text-muted-foreground hover:text-muted-foreground hover:bg-border'
                  }`}
                >
                  <Drama size={16} strokeWidth={1.75} />
                </Button>
                <Button variant="ghost"
                  onClick={() => landingFileRef.current?.click()}
                  className="text-muted-foreground hover:text-primary hover:bg-accent text-sm"
                  title={t('landing.attach')}
                >
                  <Paperclip size={16} strokeWidth={1.75} />
                </Button>
                <input
                  ref={landingFileRef}
                  type="file"
                  multiple
                  accept={FILE_INPUT_ACCEPT}
                  className="hidden"
                  onChange={(e) => { handleFileUpload(e.target.files || []); e.target.value = ''; }}
                />
                <Button
                  onClick={handleSubmit}
                  disabled={!inputValue.trim() || pendingAttachments.some(a => a.isExtracting)}>
                  {pendingAttachments.some(a => a.isExtracting) ? t('landing.extracting') : t('landing.send')}
                </Button>
              </div>
            </div>

            {/* Second entrance: start from a document (material-first). The
                whole landing is the drop target; this card names the gesture. */}
            <div
              onClick={() => docFileRef.current?.click()}
              className={`mt-3 border-2 border-dashed rounded-xl px-5 py-3.5 cursor-pointer transition-all text-center bg-card/60 backdrop-blur ${
                isDraggingLanding ? 'border-primary bg-primary/5 ring-2 ring-primary/20' : 'border-border hover:border-primary/40 hover:bg-primary/5'
              }`}
            >
              <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground font-medium">
                <BookOpen size={15} strokeWidth={1.75} className="text-primary" /> {t('landing.docStart')}
              </div>
              <p className="text-2xs text-muted-foreground mt-1.5">{t('landing.docFormats')}</p>
              <p className="text-2xs text-muted-foreground mt-0.5">{t('landing.docPrivacy')}</p>
            </div>
            {/* Agent conversations, desktop only — one click turns them
                into graphs, and LOOKING needs no model key: the one
                zero-config start. Dressed in the SAME uniform as the
                document card (shared ground, centered two-line layout);
                the one distinction left is the border — dashed means
                "drop here", solid means "click me". */}
            {!!window.desktopSessions && (
              <Button variant="outline"
                onClick={() => setLandingAtlas(true)}
                className="w-full mt-3 backdrop-blur hover:border-primary/40 text-center"
                data-landing-atlas
              >
                <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground font-medium">
                  <Bot size={15} strokeWidth={1.75} className="text-primary shrink-0" />
                  <span>{t('landing.atlasStart')}</span>
                  <ArrowRight size={13} strokeWidth={1.75} className="text-primary shrink-0" />
                </div>
                <p className="text-2xs text-muted-foreground mt-1.5">{t('landing.atlasDesc')}</p>
              </Button>
            )}
            <input
              ref={docFileRef}
              type="file"
              multiple
              accept={FILE_INPUT_ACCEPT}
              className="hidden"
              onChange={(e) => { startFromDocuments(e.target.files || []); e.target.value = ''; }}
            />
            {landingAtlas && (
              <SessionAtlas onClose={() => setLandingAtlas(false)} onSwitched={() => { setLandingAtlas(false); afterProjectSwitch(); }} />
            )}

            {/* Quick connect: the no-model landing offers the two free doors
                side by side — GLM's free tier (zh only) and the one-click
                OpenRouter OAuth (free-tier models included, key minted in
                this browser) — plus one quiet line for subscription owners.
                Gone once any model exists. */}
            {(!modelData || (modelData.models?.length ?? 0) === 0) && (
              <div className="mt-3 bg-card/60 backdrop-blur border border-border rounded-xl px-5 py-3.5 text-center" data-quick-connect>
                <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground font-medium">
                  <KeyRound size={15} strokeWidth={1.75} className="text-primary shrink-0" /> {t('landing.quickTitle')}
                </div>
                <p className="text-2xs text-muted-foreground mt-1.5">{t('landing.quickDesc')}</p>
                <div className="mt-2.5 flex items-center justify-center flex-wrap gap-2">
                  {lang === 'zh' && (
                    <Button variant="ghost" size="xs"
                      onClick={() => { useUiStore.getState().setApiKeyPresetHint('zhipu'); useUiStore.getState().setApiKeyModalOpen(true); }}
                      className="text-2xs bg-primary/10 text-primary hover:bg-primary/20 shrink-0"
                      data-quick-zhipu
                    >
                      {t('landing.quickZhipu')}
                    </Button>
                  )}
                  <Button variant="ghost" size="xs"
                    onClick={() => void startOpenRouterOAuth()}
                    className="text-2xs bg-primary/10 text-primary hover:bg-primary/20 shrink-0"
                    data-quick-primary
                  >
                    {t('landing.quickOpenRouter')}
                  </Button>
                  <Button variant="ghost" size="xs"
                    onClick={() => useUiStore.getState().setApiKeyModalOpen(true)}
                    className="text-2xs text-muted-foreground hover:text-foreground hover:bg-accent shrink-0"
                  >
                    {t('landing.quickOther')}
                  </Button>
                </div>
                <Button variant="ghost" size="xs"
                  onClick={() => useUiStore.getState().setApiKeyModalOpen(true)}
                  className="mt-2 mx-auto text-2xs text-muted-foreground hover:text-primary block"
                  data-quick-subs
                >
                  {t('landing.quickSubs')}
                </Button>
              </div>
            )}

            {/* What makes this different — three quiet cards */}
            <div className="grid grid-cols-3 gap-3 mt-6">
              {([
                { icon: GitBranch, title: 'landing.feature1.title', desc: 'landing.feature1.desc' },
                { icon: Workflow, title: 'landing.feature2.title', desc: 'landing.feature2.desc' },
                { icon: Scissors, title: 'landing.feature3.title', desc: 'landing.feature3.desc' },
              ] as const).map(({ icon: Icon, title, desc }) => (
                <div key={title} className="bg-card/60 backdrop-blur border border-border rounded-xl px-4 py-3.5">
                  <Icon size={16} strokeWidth={1.75} className="text-primary mb-2" />
                  <h3 className="text-xs font-semibold text-foreground mb-1">{t(title)}</h3>
                  <p className="text-2xs text-muted-foreground leading-relaxed">{t(desc)}</p>
                </div>
              ))}
            </div>

            <div className="text-center mt-6 flex items-center justify-center gap-5">
              <Button variant="ghost" size="sm"
                onClick={loadExample}
                className="text-xs text-primary hover:text-primary/90"
              >
                <Workflow size={14} strokeWidth={1.75} /> {t('landing.loadExample')}
              </Button>
              <Button variant="ghost" size="sm"
                onClick={() => setTutorialOpen(true)}
                className="text-xs text-muted-foreground hover:text-primary"
              >
                <CircleHelp size={14} strokeWidth={1.75} /> {t('landing.howItWorks')}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Project switcher */}
      {!isViewerMode && <ProjectSwitcher onSwitched={afterProjectSwitch} />}

      {/* Content palette — canvas material, both modes. Click drops at the
          viewport center; DRAG drops at the pointer. Paste works anywhere:
          text → note, a URL → link snapshot, image/files → file node. */}
      {(hasNodes || isParadigm) && !isViewerMode && (
        <div className="absolute top-[38%] -translate-y-1/2 left-4 z-10 flex flex-col gap-1.5 bg-card/90 backdrop-blur border border-border rounded-xl p-1.5 shadow-sm">
          {!isParadigm && (
            <Button variant="ghost" size="icon"
              onClick={() => spawnAskNode(flowPosAt(null))}
              draggable
              onDragStart={(e) => { e.dataTransfer.setData('application/thoughtdag-content', 'ask'); e.dataTransfer.effectAllowed = 'copy'; }}
              title={t('palette.askTitle')}
              className="text-primary hover:bg-primary/10 cursor-grab"
            >
              <MessageCircleQuestion size={15} strokeWidth={1.75} />
            </Button>
          )}
          <Button variant="ghost" size="icon"
            onPointerDown={(e) => paletteDrag(e, (screen) => spawnContentNode('note', flowPosAt(screen)))}
            title={t('palette.noteTitle')}
            className="text-warning hover:bg-warning/10"
          >
            <StickyNote size={15} strokeWidth={1.75} />
          </Button>
          <Button variant="ghost" size="icon"
            onPointerDown={(e) => paletteDrag(e, (screen) => spawnContentNode('file', flowPosAt(screen)))}
            title={t('palette.fileTitle')}
            className="text-muted-foreground hover:bg-accent"
          >
            <Paperclip size={15} strokeWidth={1.75} />
          </Button>
          <Button variant="ghost" size="icon"
            onPointerDown={(e) => paletteDrag(e, (screen) => spawnFrame(flowPosAt(screen)))}
            title={t('palette.frameTitle')}
            className="text-muted-foreground hover:bg-accent"
          >
            <Frame size={15} strokeWidth={1.75} />
          </Button>
        </div>
      )}

      {/* Viewer: the toolbar collapses to a read-only badge + download + brand
          link — every mutating control lives in the author toolbar below. */}
      {isViewerMode && (
        <div
          className="absolute top-4 z-10 flex gap-1.5 items-center transition-[right] duration-200"
          style={{ right: panelOpen ? livePanelWidth + PANEL_INSET + 12 : 16 }}
        >
          <span className="bg-card/90 backdrop-blur border border-border rounded-lg h-8 px-3 flex items-center gap-1.5 shadow-sm text-muted-foreground text-xs font-medium" data-viewer-badge>
            <Eye size={14} strokeWidth={1.75} /> {t('viewer.badge')}
          </span>
          <Button variant="outline" size="icon"
            onClick={() => setSearchOpen(true)}
            className="backdrop-blur"
            title={t('search.entryTitle')}
            data-search-entry
          >
            <Search size={15} strokeWidth={1.75} />
          </Button>
          <LangSwitch />
          <Button variant="outline" size="icon"
            onClick={() => exportActiveProjectJson()}
            className="backdrop-blur"
            title={t('viewer.downloadJson')}
          >
            <Download size={15} strokeWidth={1.75} />
          </Button>
          <a
            href="https://github.com/chenxiachan/thoughtdag"
            target="_blank"
            rel="noreferrer"
            className="bg-foreground text-white rounded-lg h-8 px-3 flex items-center gap-1.5 shadow-sm hover:bg-foreground/85 transition-colors text-xs font-medium"
          >
            {t('viewer.openApp')}
          </a>
        </div>
      )}

      {/* Toolbar: web search, language, tutorial, relayout, undo/redo.
          Positioned relative to the VISIBLE canvas: when the overlay panel
          is open it slides left instead of hiding underneath. */}
      {!isViewerMode && (
      <div
        className="absolute top-4 z-10 flex gap-1.5 items-center transition-[right] duration-200"
        style={{ right: panelOpen ? livePanelWidth + PANEL_INSET + 12 : 16 }}
      >
        {isParadigm && (
          <>
            <Button variant="ghost" size="sm"
              onClick={() => addStep('human')}
              className="bg-card/90 backdrop-blur border-edge-explore/40 hover:bg-edge-explore/10 text-edge-explore text-xs"
            >
              <MessageCircleQuestion size={14} strokeWidth={1.75} /> {t('paradigm.addHuman')}
            </Button>
            <Button variant="ghost" size="sm"
              onClick={() => addStep('prompt')}
              className="bg-card/90 backdrop-blur border-primary/40 hover:bg-primary/10 text-primary text-xs"
            >
              <SquareTerminal size={14} strokeWidth={1.75} /> {t('paradigm.addPrompt')}
            </Button>
            <Button variant="ghost" size="sm"
              onClick={() => void instantiate()}
              title={t('paradigm.instantiateTitle')}
              className="bg-foreground text-white hover:bg-foreground/85 text-xs"
            >
              ▶ {t('paradigm.instantiate')}
            </Button>
          </>
        )}
        {!isParadigm && <AgentCwdChip />}
        {!isParadigm && <ModelPicker />}
        {/* Landing convenience only: inside the canvas the picker's own
            empty state (Connect a model) is the door — no twin key icon */}
        {!hasNodes && (
          <Button variant="outline" size="icon"
            onClick={() => useUiStore.getState().setApiKeyModalOpen(true)}
            className="backdrop-blur"
            title={t('apikey.entryTitle')}
            data-apikey-entry
          >
            <KeyRound size={15} strokeWidth={1.75} />
          </Button>
        )}
        {/* Batch replay: visible only when something is stale. Price at the
            decision point — N generations is the one many-calls-per-click
            action in the app, so it confirms with a token estimate. */}
        {staleCount > 0 && !isParadigm && (
          <Button variant="ghost" size="sm"
            onClick={() => {
              const { nodes: ns, edges: es, staleIds } = useStore.getState();
              const estTok = staleIds.reduce((sum, sid) => {
                const blanked = ns.map((x) => x.id === sid ? { ...x, data: { ...x.data, question: '', response: '' } } : x);
                const { layerTokens } = buildContext(sid, blanked, es);
                const q = ns.find((x) => x.id === sid)?.data.question ?? '';
                return sum + layerTokens.material + layerTokens.reference + layerTokens.chain + countTokens(q);
              }, 0);
              void confirmDialog({
                title: t('replay.confirmTitle'),
                message: fmt(t('replay.confirmMsg'), { n: staleCount, tok: estTok.toLocaleString() }),
                confirmLabel: t('replay.confirmBtn'),
              }).then((ok) => { if (ok) void useStore.getState().replayStale(); });
            }}
            className="bg-warning/10 backdrop-blur border-warning/40 hover:bg-warning/20 text-warning text-xs"
            title={t('replay.chipTitle')}
          >
            <ListRestart size={14} strokeWidth={1.75} /> {staleCount}
          </Button>
        )}
        {hasNodes && frames.length > 0 && (
          <DropdownMenu open={frameNavOpen} onOpenChange={setFrameNavOpen}>
            <DropdownMenuTrigger
              className={`bg-card/90 backdrop-blur border rounded-lg w-8 h-8 flex items-center justify-center shadow-sm transition-colors ${
                frameNavOpen ? 'border-primary/40 text-primary' : 'border-border text-muted-foreground hover:bg-accent'
              }`}
              title={t('toolbar.frames')}
            >
              <Frame size={15} strokeWidth={1.75} />
            </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-[230px] max-h-[320px] overflow-y-auto">
                {frames.map((f) => (
                  <DropdownMenuItem
                    key={f.id}
                    onClick={() => {
                      rfInstance.current?.fitBounds(
                        { x: f.position.x, y: f.position.y, width: f.width ?? 640, height: f.height ?? 420 },
                        { duration: 400, padding: 0.15 },
                      );
                    }}
                  >
                    <span className={`w-2.5 h-2.5 rounded-sm shrink-0 ${(FRAME_COLORS[f.data.frameColor ?? 'gray'] ?? FRAME_COLORS.gray).dot}`} />
                    <span className="truncate">{f.data.question || t('frame.untitled')}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
          </DropdownMenu>
        )}
        {hasNodes && (
          <Button variant="outline" size="icon"
            onClick={() => setSearchOpen(true)}
            className="backdrop-blur"
            title={t('search.entryTitle')}
            data-search-entry
          >
            <Search size={15} strokeWidth={1.75} />
          </Button>
        )}
        <LangSwitch />
        {hasNodes && !isParadigm && (
          <DiagnosticsPanel showTrigger={false} openPing={diagPing} onLocate={(id) => {
            const n = useStore.getState().nodes.find((x) => x.id === id);
            if (n) {
              setSelectedNodeId(id);
              centerNode(n, { zoom: 1 });
            }
          }} />
        )}
        {/* Condense while RUNNING is a status badge (click reopens progress);
            the launch entry lives in the ⋯ menu with the other tools. */}
        {condenseBuilding && !isViewerMode && (
          <Button variant="ghost"
            onClick={() => useUiStore.getState().setCondenseDialogOpen(true)}
            className="bg-card/90 backdrop-blur border-primary/50 hover:bg-accent text-primary"
            title={fmt(t('condense.entryBuilding'), { i: String(condenseRunState.current), n: String(condenseRunState.total) })}
            data-condense-entry
          >
            <Loader2 size={14} strokeWidth={1.75} className="animate-spin" /><span className="text-2xs font-mono">{condenseRunState.current}/{condenseRunState.total}</span>
          </Button>
        )}
        {backupSupported && (
          <Button variant="outline" size="icon"
            onClick={() => useUiStore.getState().setBackupDialogOpen(true)}
            className="backdrop-blur"
            title={t('backup.dialogTitle')}
            data-backup-entry
          >
            <FolderSync size={15} strokeWidth={1.75} />
          </Button>
        )}
        {/* ⋯ overflow: share, memory, annotations, relayout, tutorial —
            one slot regardless of language or panel width. */}
        <DropdownMenu open={moreOpen} onOpenChange={setMoreOpen}>
          <DropdownMenuTrigger
            className={`bg-card/90 backdrop-blur border rounded-lg w-8 h-8 flex items-center justify-center shadow-sm transition-colors ${
              moreOpen ? 'border-primary/40 text-primary' : 'border-border text-muted-foreground hover:bg-accent'
            }`}
            title={t('toolbar.more')}
            data-toolbar-more
          >
            <MoreHorizontal size={15} strokeWidth={1.75} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-[220px]">
              {hasNodes && (
                <DropdownMenuItem
                  onClick={() => { setAnnotationsHidden(!annotationsHidden); }}
                  title={annotationsHidden ? t('toolbar.showAnnotations') : t('toolbar.hideAnnotations')}
                >
                  <StickyNote size={14} strokeWidth={1.75} className={`shrink-0 ${annotationsHidden ? 'text-primary' : 'text-muted-foreground'}`} /> {annotationsHidden ? t('toolbar.menuAnnotationsShow') : t('toolbar.menuAnnotationsHide')}
                </DropdownMenuItem>
              )}
              {hasNodes && (
                <DropdownMenuItem
                  onClick={() => {
                    void confirmDialog({
                      title: t('confirm.relayoutTitle'),
                      message: t('confirm.relayoutMsg'),
                      confirmLabel: t('toolbar.relayout'),
                    }).then((ok) => {
                      if (!ok) return;
                      relayout();
                      setTimeout(() => rfInstance.current?.fitView({ duration: 400, padding: 0.15 }), 50);
                    });
                  }}
                >
                  <LayoutGrid size={14} strokeWidth={1.75} className="text-muted-foreground shrink-0" /> {t('toolbar.relayout')}
                </DropdownMenuItem>
              )}
              {highlightCount > 0 && (
                <DropdownMenuItem
                  onClick={() => { useUiStore.getState().setHighlightsOverviewOpen(true); }}
                  title={t('hlov.entryTitle')}
                  data-hlov-entry
                >
                  <Highlighter size={14} strokeWidth={1.75} className="text-muted-foreground shrink-0" /> {fmt(t('hlov.entry'), { n: highlightCount })}
                </DropdownMenuItem>
              )}
              {materialCount > 0 && (
                <DropdownMenuItem
                  onClick={() => { useUiStore.getState().setMaterialsOverviewOpen(true); }}
                  title={t('matov.entryTitle')}
                  data-matov-entry
                >
                  <Paperclip size={14} strokeWidth={1.75} className="text-muted-foreground shrink-0" /> {fmt(t('matov.entry'), { n: materialCount })}
                </DropdownMenuItem>
              )}
              {hasNodes && <DropdownMenuSeparator />}
              {hasNodes && !isParadigm && !isViewerMode && (
                <DropdownMenuItem
                  onClick={() => { useUiStore.getState().setCondenseDialogOpen(true); }}
                  title={t('condense.entryTitle')}
                >
                  <Minimize2 size={14} strokeWidth={1.75} className="text-muted-foreground shrink-0" /> {t('condense.title')}…
                </DropdownMenuItem>
              )}
              {hasNodes && !isParadigm && (
                <DropdownMenuItem
                  onClick={() => { setDiagPing((v) => v + 1); }}
                  title={t('toolbar.diagnose')}
                  data-menu-diagnose
                >
                  <Stethoscope size={14} strokeWidth={1.75} className="text-muted-foreground shrink-0" /> {t('toolbar.menuDiagnose')}
                </DropdownMenuItem>
              )}
              {hasNodes && !isParadigm && (
                <DropdownMenuItem
                  onClick={() => {
                    void (async () => {
                      const { nodes: ns, edges: es } = useStore.getState();
                      // exit gate: a mirrored canvas can carry CLI tool
                      // output — keys, tokens — and a share link IS a copy
                      const { confirmIfSensitive } = await import('./lib/sensitive-scan');
                      if (!await confirmIfSensitive(ns)) return;
                      const url = await buildViewerLink(ns, es);
                      await navigator.clipboard.writeText(url).catch(() => {});
                      useUiStore.getState().setShareDialogUrl(url);
                    })();
                  }}
                  data-share-link
                  title={t('viewer.shareTitle')}
                >
                  <Share2 size={14} strokeWidth={1.75} className="text-muted-foreground shrink-0" /> {t('toolbar.menuShare')}
                </DropdownMenuItem>
              )}
              {hasNodes && (
                <DropdownMenuItem
                  onClick={() => { if (isParadigm) exportActiveParadigm(); else exportActiveProjectJson(); }}
                  data-menu-export
                >
                  <Download size={14} strokeWidth={1.75} className="text-muted-foreground shrink-0" /> {isParadigm ? t('paradigm.exportParadigm') : t('switcher.exportBackup')}
                </DropdownMenuItem>
              )}
              {hasEvents && (
                <DropdownMenuItem
                  onClick={() => { exportEventLogCsv(); }}
                  title={t('toolbar.exportEventsTitle')}
                >
                  <FileText size={14} strokeWidth={1.75} className="text-muted-foreground shrink-0" /> {t('toolbar.exportEvents')}
                </DropdownMenuItem>
              )}
              {hasNodes && <DropdownMenuSeparator />}
              {/* appearance: two independent axes — lighting remaps the
                  tokens, paper retextures the canvas (and arms snapping) */}
              <div className="px-3 pt-2 pb-1" data-appearance-lighting>
                <div className="text-2xs text-muted-foreground mb-1.5">{t('appearance.lighting')}</div>
                <div className="flex rounded-lg border border-border overflow-hidden text-2xs">
                  {([['light', t('appearance.light')], ['dark', t('appearance.dark')], ['system', t('appearance.system')]] as const).map(([v, label], i) => (
                    <Button variant="ghost"
                      key={v}
                      onClick={() => useAppearance.getState().setLighting(v)}
                      className={`flex-1 px-1 py-1.5 transition-colors ${i > 0 ? 'border-l border-border' : ''} ${lightingChoice === v ? 'bg-primary/10 text-primary font-medium' : 'text-muted-foreground hover:bg-accent'}`}
                    >
                      {label}
                    </Button>
                  ))}
                </div>
              </div>
              <div className="px-3 pt-1 pb-2" data-appearance-paper>
                <div className="text-2xs text-muted-foreground mb-1.5">{t('appearance.paper')}</div>
                <div className="flex rounded-lg border border-border overflow-hidden text-2xs">
                  {([['plain', t('appearance.plain')], ['grid', t('appearance.grid')]] as const).map(([v, label], i) => (
                    <Button variant="ghost"
                      key={v}
                      onClick={() => useAppearance.getState().setPaper(v)}
                      className={`flex-1 px-1 py-1.5 transition-colors ${i > 0 ? 'border-l border-border' : ''} ${paperTexture === v ? 'bg-primary/10 text-primary font-medium' : 'text-muted-foreground hover:bg-accent'}`}
                    >
                      {label}
                    </Button>
                  ))}
                </div>
              </div>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => { useUiStore.getState().setMemoryManagerOpen(true); }}
                title={t('memory.entryTitle')}
              >
                <Brain size={14} strokeWidth={1.75} className="text-muted-foreground shrink-0" /> {t('memory.managerTitle')}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => { setTutorialOpen(true); }}
              >
                <CircleHelp size={14} strokeWidth={1.75} className="text-muted-foreground shrink-0" /> {t('landing.howItWorks')}
              </DropdownMenuItem>
              {pluginUpdate && (
                <DropdownMenuItem
                  onClick={() => { void navigator.clipboard.writeText(pluginUpdateCommand(pluginUpdate.latest)).then(() => toast('success', t('plugin.updateCopied'), 6000)).catch(() => {}); }}
                  className="w-full text-left px-3 py-2 text-xs text-primary hover:bg-accent transition-colors flex items-center gap-2.5"
                  title={fmt(t('plugin.updateHint'), { cmd: pluginUpdateCommand(pluginUpdate.latest) })}
                  data-plugin-update
                >
                  <Download size={14} strokeWidth={1.75} className="shrink-0" /> {fmt(t('plugin.updateAvailable'), { v: pluginUpdate.latest })}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                onClick={() => { useUiStore.getState().setReleaseNotesOpen(true); }}
                data-open-release-notes
              >
                <HistoryIcon size={14} strokeWidth={1.75} className="text-muted-foreground shrink-0" /> {t('releaseNotes.entry')}
              </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button variant="outline" size="icon"
          onClick={undo}
          disabled={historyIndex <= 0}
          className="backdrop-blur"
          title={t('canvas.undo')}
        >
          <Undo2 size={16} strokeWidth={1.75} />
        </Button>
        <Button variant="outline" size="icon"
          onClick={redo}
          disabled={historyIndex >= history.length - 1}
          className="backdrop-blur"
          title={t('canvas.redo')}
        >
          <Redo2 size={16} strokeWidth={1.75} />
        </Button>
      </div>
      )}

      {/* Multi-select toolbar */}
      {multiSelected && !isViewerMode && <SelectionToolbar />}

      {/* Cmd+F node search */}
      <SearchBar
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        onLocate={(id) => {
          const n = useStore.getState().nodes.find((x) => x.id === id);
          if (n) {
            setSelectedNodeId(id);
            centerNode(n, { zoom: 1 });
          }
          // search stays open: the filter is a browsing mode, Esc ends it
        }}
      />

      {/* Edge context menu */}
      {nodeMenu && (
        <NodeContextMenu x={nodeMenu.x} y={nodeMenu.y} nodeId={nodeMenu.nodeId} onClose={() => setNodeMenu(null)} />
      )}
      <MaterialsOverviewModal onLocate={(nid) => {
        const n = useStore.getState().nodes.find((x) => x.id === nid);
        if (n) {
          setSelectedNodeId(nid);
          centerNode(n, { zoom: 1 });
        }
      }} />
      <TimelineOverviewModal onLocate={(nid) => {
        const n = useStore.getState().nodes.find((x) => x.id === nid);
        if (n) {
          setSelectedNodeId(nid);
          centerNode(n, { zoom: 1 });
        }
      }} />
      <HighlightsOverviewModal onLocate={(nid) => {
        const n = useStore.getState().nodes.find((x) => x.id === nid);
        if (n) {
          setSelectedNodeId(nid);
          centerNode(n, { zoom: 1 });
        }
      }} />
      {edgeMenu && (
        <div
          className="fixed z-50 bg-card border border-border rounded-xl shadow-lg py-1 min-w-[120px]"
          style={{ left: edgeMenu.x, top: edgeMenu.y }}
        >
          <Button variant="destructive"
            onClick={() => deleteEdge(edgeMenu.edgeId)}
            className="w-full text-left"
          >
            <Trash2 size={14} strokeWidth={1.75} />
            {t('canvas.deleteEdge')}
          </Button>
        </div>
      )}
      </div>

      {/* Focus Panel — floating overlay on the right; never for orchestration
          or content nodes, which are edited in place on the canvas */}
      <CondenseDialog onFocusSegment={(ids) => {
        const rf = rfInstance.current;
        // read fresh state: the condensed copy may have been created AFTER
        // this closure captured the render's nodes array
        const members = useStore.getState().nodes.filter((n) => ids.includes(n.id));
        if (!rf || members.length === 0) return;
        const xs = members.map((n) => n.position.x), ys = members.map((n) => n.position.y);
        const x = Math.min(...xs), y = Math.min(...ys);
        const w = Math.max(...xs) + 520 - x, h = Math.max(...ys) + 240 - y;
        // widen rightwards: the condense panel covers the right edge
        rf.fitBounds({ x, y, width: w + 700, height: h }, { duration: 350, padding: 0.15 });
      }} />
      {panelOpen && <FocusPanel onFocusNode={(id) => {
        const node = nodes.find(n => n.id === id);
        if (node) centerNode(node, { duration: 300 });
      }} />}

      {/* Material reading overlay: select a passage, ask, the node lands on
          the canvas immediately (a view onto the material, not a container) */}
      <MaterialReader onLocate={(id) => {
        const n = useStore.getState().nodes.find((x) => x.id === id);
        if (n) {
          setSelectedNodeId(id);
          centerNode(n, { zoom: 1 });
        }
      }} />
    </div>
  );
}


// Stamps the current semantic-zoom tier on the canvas element so CSS can
// restyle global layers, and streams the live zoom into a CSS variable so
// glyph seals and edges can counter-scale (POI style: world position,
// fixed screen size — the icon map stays dense however far you zoom out).
// The moment of looking at the shape IS the moment of wanting to share it:
// the pill exists only in the map/glyph tiers, the working tier stays
// silent. Must live inside <ReactFlow> to reach the flow store.
// panelShiftWidth comes from the App's COMPOSITE panel-visible signal —
// reading the raw ui-store panelOpen here desyncs the dock when the panel
// closes via a pane click (which clears the selection, not the flag).
function ThoughtMapPill({ panelShiftWidth }: { panelShiftWidth: number }) {
  const tier = useZoomTier();
  const t = useT();
  const rf = useReactFlow();
  const nodeCount = useStore((s) => s.nodes.length);
  const nodes = useStore((s) => s.nodes);

  // The flight destination: the thought node touched most recently.
  // Content nodes (notes, files, links, frames) never count as "work".
  const lastActive = useMemo(() => {
    let best: (typeof nodes)[number] | null = null;
    let bestAt = '';
    for (const n of nodes) {
      if (n.data.stepKind && n.data.stepKind !== 'human' && n.data.stepKind !== 'prompt') continue;
      const at = [n.data.lastGeneratedAt, n.data.askedAt, n.data.createdAt,
        ...(n.data.editedAts ?? [])].filter(Boolean).sort().pop() as string | undefined;
      if (at && at > bestAt) { bestAt = at; best = n; }
    }
    return best ? { node: best, at: bestAt } : null;
  }, [nodes]);

  if (isViewerMode || tier === 'work' || nodeCount < 2) return null;

  const flyBack = () => {
    if (!lastActive) return;
    useUiStore.getState().setBeaconNodeId(null);
    const { node } = lastActive;
    rf.setCenter(node.position.x + 260, node.position.y + 110, { zoom: 1, duration: 1100 });
    // three beats: flight → panel opens (recentered for its width) → recap toast
    window.setTimeout(() => {
      useStore.getState().setSelectedNodeId(node.id);
      useUiStore.getState().setPanelOpen(true);
      window.setTimeout(() => {
        rf.setCenter(node.position.x + 260 + panelShift(node.id) / 2, node.position.y + 110, { zoom: 1, duration: 300 });
      }, 60);
    }, 1150);
    window.setTimeout(() => {
      toast('success', t('continue.arrived'), 12000,
        { label: t('continue.summarize'), run: () => void recapToNote(node.id) });
    }, 1550);
  };

  return (
    <div
      className="absolute bottom-6 z-10 flex items-center gap-2 -translate-x-1/2 transition-[left] duration-300"
      style={{ left: `calc((100% - ${panelShiftWidth}px) / 2)` }}
      data-map-dock
    >
      <Button variant="ghost"
        onClick={() => useUiStore.getState().setThoughtMapOpen(true)}
        data-tmap-pill
        className="bg-card/95 backdrop-blur border-input text-sm text-foreground shadow-lg hover:border-primary/40 hover:text-primary"
      >
        <ImageDown size={16} strokeWidth={1.75} /> {t('tmap.export')}
      </Button>
      {lastActive && (
        <Button
          onClick={flyBack}
          onMouseEnter={() => useUiStore.getState().setBeaconNodeId(lastActive.node.id)}
          onMouseLeave={() => useUiStore.getState().setBeaconNodeId(null)}
          title={t('continue.buttonTitle')}
          data-continue-pill
          className="shadow-lg"
        >
          <Rewind size={16} strokeWidth={1.75} /> {t('continue.button')}
        </Button>
      )}
    </div>
  );
}

// Must live inside <ReactFlow> to reach the flow store.
function ZoomTierTag() {
  const tier = useZoomTier();
  const zoom = useRfStore((s) => s.transform[2]);
  useEffect(() => {
    document.querySelector('.react-flow')?.setAttribute('data-zoom-tier', tier);
  }, [tier]);
  useEffect(() => {
    (document.querySelector('.react-flow') as HTMLElement | null)?.style.setProperty('--tdag-zoom', String(zoom));
  }, [zoom]);
  return null;
}
