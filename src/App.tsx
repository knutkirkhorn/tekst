import Editor, { type Monaco, type OnMount } from "@monaco-editor/react";
import {
  getCurrentWebview,
  type DragDropEvent,
} from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open, save } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./App.css";

type EditorTab = {
  id: string;
  modelPath: string;
  filePath: string | null;
  name: string;
  initialContent: string;
  language: string;
  dirty: boolean;
};

type TabContextMenu = {
  tabId: string;
  x: number;
  y: number;
};

type EditorInstance = Parameters<OnMount>[0];

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  c: "c",
  cc: "cpp",
  cpp: "cpp",
  cs: "csharp",
  css: "css",
  go: "go",
  h: "c",
  hpp: "cpp",
  html: "html",
  java: "java",
  js: "javascript",
  json: "json",
  jsx: "javascript",
  md: "markdown",
  py: "python",
  rs: "rust",
  sh: "shell",
  sql: "sql",
  ts: "typescript",
  tsx: "typescript",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
};

const EMPTY_DOCUMENT = "";

function fileNameFromPath(path: string) {
  return path.split(/[\\/]/).pop() || "Untitled";
}

function languageFromPath(path: string) {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  return LANGUAGE_BY_EXTENSION[extension] ?? "plaintext";
}

function createUntitledTab(sequence: number): EditorTab {
  const name = sequence === 1 ? "Untitled" : `Untitled ${sequence}`;
  return {
    id: crypto.randomUUID(),
    modelPath: `inmemory://tekst/${crypto.randomUUID()}.txt`,
    filePath: null,
    name,
    initialContent: EMPTY_DOCUMENT,
    language: "plaintext",
    dirty: false,
  };
}

function App() {
  const initialTab = useMemo(() => createUntitledTab(1), []);
  const [tabs, setTabs] = useState<EditorTab[]>([initialTab]);
  const [activeTabId, setActiveTabId] = useState(initialTab.id);
  const [status, setStatus] = useState("Ready");
  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const [tabContextMenu, setTabContextMenu] =
    useState<TabContextMenu | null>(null);
  const editorRef = useRef<EditorInstance | null>(null);
  const monacoRef = useRef<Monaco | null>(null);
  const untitledSequence = useRef(1);

  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0];

  const setTabDirty = useCallback((id: string) => {
    setTabs((currentTabs) =>
      currentTabs.map((tab) =>
        tab.id === id && !tab.dirty ? { ...tab, dirty: true } : tab,
      ),
    );
  }, []);

  const createNewFile = useCallback(() => {
    untitledSequence.current += 1;
    const tab = createUntitledTab(untitledSequence.current);
    setTabs((currentTabs) => [...currentTabs, tab]);
    setActiveTabId(tab.id);
    setStatus("New file");
  }, []);

  const openPaths = useCallback(async (paths: string[]) => {
    try {
      const existingPath = new Map(
        tabs
          .filter((tab) => tab.filePath)
          .map((tab) => [tab.filePath as string, tab.id]),
      );
      const newTabs: EditorTab[] = [];

      for (const filePath of paths) {
        const existingId = existingPath.get(filePath);
        if (existingId) {
          setActiveTabId(existingId);
          continue;
        }

        const content = await readTextFile(filePath);
        const tab: EditorTab = {
          id: crypto.randomUUID(),
          modelPath: `file://${filePath.replace(/\\/g, "/")}`,
          filePath,
          name: fileNameFromPath(filePath),
          initialContent: content,
          language: languageFromPath(filePath),
          dirty: false,
        };
        newTabs.push(tab);
        existingPath.set(filePath, tab.id);
      }

      if (newTabs.length > 0) {
        setTabs((currentTabs) => {
          const canReplaceEmpty =
            currentTabs.length === 1 &&
            currentTabs[0].filePath === null &&
            !currentTabs[0].dirty &&
            currentTabs[0].initialContent === EMPTY_DOCUMENT;
          return canReplaceEmpty ? newTabs : [...currentTabs, ...newTabs];
        });
        setActiveTabId(newTabs[newTabs.length - 1].id);
      }
      setStatus(`${paths.length} file${paths.length === 1 ? "" : "s"} opened`);
    } catch (error) {
      setStatus(`Open failed: ${String(error)}`);
    }
  }, [tabs]);

  const openFiles = useCallback(async () => {
    try {
      const selected = await open({
        multiple: true,
        directory: false,
        title: "Open files",
      });

      if (!selected) return;
      await openPaths(Array.isArray(selected) ? selected : [selected]);
    } catch (error) {
      setStatus(`Open failed: ${String(error)}`);
    }
  }, [openPaths]);

  const getTabContent = useCallback((tab: EditorTab) => {
    const model = monacoRef.current?.editor.getModel(
      monacoRef.current.Uri.parse(tab.modelPath),
    );
    return model?.getValue() ?? tab.initialContent;
  }, []);

  const saveTab = useCallback(
    async (tab: EditorTab, saveAs = false) => {
      try {
        let targetPath = tab.filePath;
        if (!targetPath || saveAs) {
          targetPath = await save({
            title: "Save file",
            defaultPath: tab.filePath ?? tab.name,
          });
        }
        if (!targetPath) return;

        await writeTextFile(targetPath, getTabContent(tab));
        const newName = fileNameFromPath(targetPath);
        setTabs((currentTabs) =>
          currentTabs.map((currentTab) =>
            currentTab.id === tab.id
              ? {
                  ...currentTab,
                  filePath: targetPath,
                  name: newName,
                  language: languageFromPath(targetPath),
                  dirty: false,
                }
              : currentTab,
          ),
        );
        setStatus(`Saved ${newName}`);
      } catch (error) {
        setStatus(`Save failed: ${String(error)}`);
      }
    },
    [getTabContent],
  );

  const closeTabs = useCallback(
    (ids: string[]) => {
      const idSet = new Set(ids);
      const tabsToClose = tabs.filter((tab) => idSet.has(tab.id));
      if (tabsToClose.length === 0) return;

      const dirtyTabs = tabsToClose.filter((tab) => tab.dirty);
      if (dirtyTabs.length > 0) {
        const description =
          dirtyTabs.length === 1
            ? `"${dirtyTabs[0].name}" has unsaved changes.`
            : `${dirtyTabs.length} files have unsaved changes.`;
        if (!window.confirm(`${description} Close without saving?`)) return;
      }

      const firstClosedIndex = tabs.findIndex((tab) => idSet.has(tab.id));
      const remainingTabs = tabs.filter((tab) => !idSet.has(tab.id));

      for (const tab of tabsToClose) {
        monacoRef.current?.editor
          .getModel(monacoRef.current.Uri.parse(tab.modelPath))
          ?.dispose();
      }

      if (remainingTabs.length === 0) {
        untitledSequence.current += 1;
        const replacement = createUntitledTab(untitledSequence.current);
        setTabs([replacement]);
        setActiveTabId(replacement.id);
      } else {
        setTabs(remainingTabs);
        if (idSet.has(activeTabId)) {
          const nextIndex = Math.min(firstClosedIndex, remainingTabs.length - 1);
          setActiveTabId(remainingTabs[Math.max(0, nextIndex)].id);
        }
      }

      setTabContextMenu(null);
      setStatus(
        `Closed ${tabsToClose.length} file${tabsToClose.length === 1 ? "" : "s"}`,
      );
    },
    [activeTabId, tabs],
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setTabContextMenu(null);
        return;
      }
      if (!event.ctrlKey) return;

      const key = event.key.toLowerCase();
      if (key === "n") {
        event.preventDefault();
        createNewFile();
      } else if (key === "o") {
        event.preventDefault();
        void openFiles();
      } else if (key === "s" && activeTab) {
        event.preventDefault();
        void saveTab(activeTab, event.shiftKey);
      } else if (key === "w" && activeTab) {
        event.preventDefault();
        closeTabs([activeTab.id]);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activeTab, closeTabs, createNewFile, openFiles, saveTab]);

  useEffect(() => {
    if (!tabContextMenu) return;

    const dismissMenu = () => setTabContextMenu(null);
    window.addEventListener("pointerdown", dismissMenu);
    window.addEventListener("blur", dismissMenu);
    window.addEventListener("resize", dismissMenu);
    window.addEventListener("scroll", dismissMenu, true);
    return () => {
      window.removeEventListener("pointerdown", dismissMenu);
      window.removeEventListener("blur", dismissMenu);
      window.removeEventListener("resize", dismissMenu);
      window.removeEventListener("scroll", dismissMenu, true);
    };
  }, [tabContextMenu]);

  useEffect(() => {
    const title = activeTab
      ? `${activeTab.dirty ? "● " : ""}${activeTab.name} — tekst`
      : "tekst";
    document.title = title;
    if ("__TAURI_INTERNALS__" in window) {
      void getCurrentWindow().setTitle(title);
    }
  }, [activeTab]);

  useEffect(() => {
    const warnBeforeClose = (event: BeforeUnloadEvent) => {
      if (tabs.some((tab) => tab.dirty)) {
        event.preventDefault();
      }
    };
    window.addEventListener("beforeunload", warnBeforeClose);
    return () => window.removeEventListener("beforeunload", warnBeforeClose);
  }, [tabs]);

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;

    let disposed = false;
    let unlisten: (() => void) | undefined;

    void getCurrentWebview()
      .onDragDropEvent(({ payload }: { payload: DragDropEvent }) => {
        switch (payload.type) {
          case "enter":
          case "over":
            setIsDraggingFiles(true);
            break;
          case "drop":
            setIsDraggingFiles(false);
            void openPaths(payload.paths);
            break;
          case "leave":
            setIsDraggingFiles(false);
            break;
          default: {
            const exhaustiveCheck: never = payload;
            return exhaustiveCheck;
          }
        }
      })
      .then((stopListening) => {
        if (disposed) {
          stopListening();
        } else {
          unlisten = stopListening;
        }
      })
      .catch((error) => {
        setStatus(`Drag and drop unavailable: ${String(error)}`);
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [openPaths]);

  const handleEditorMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
    editor.focus();
    editor.onDidChangeCursorPosition(({ position }) => {
      setCursor({ line: position.lineNumber, column: position.column });
    });
  };

  return (
    <main className="app-shell">
      {isDraggingFiles && (
        <div className="drop-overlay" role="status">
          Drop files to open
        </div>
      )}
      <header className="toolbar">
        <span className="brand">tekst</span>
        <div className="toolbar-actions">
          <button type="button" onClick={createNewFile} title="New (Ctrl+N)">
            New
          </button>
          <button type="button" onClick={() => void openFiles()} title="Open (Ctrl+O)">
            Open
          </button>
          <button
            type="button"
            onClick={() => activeTab && void saveTab(activeTab)}
            title="Save (Ctrl+S)"
          >
            Save
          </button>
          <button
            type="button"
            onClick={() => activeTab && void saveTab(activeTab, true)}
            title="Save as (Ctrl+Shift+S)"
          >
            Save as
          </button>
        </div>
      </header>

      <nav className="tab-bar" aria-label="Open files">
        {tabs.map((tab) => (
          <div
            className={`tab ${tab.id === activeTabId ? "active" : ""}`}
            key={tab.id}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setActiveTabId(tab.id);
              setTabContextMenu({
                tabId: tab.id,
                x: Math.max(4, Math.min(event.clientX, window.innerWidth - 180)),
                y: Math.max(4, Math.min(event.clientY, window.innerHeight - 150)),
              });
            }}
          >
            <button
              className="tab-select"
              type="button"
              onClick={() => setActiveTabId(tab.id)}
              title={tab.filePath ?? tab.name}
            >
              {tab.dirty && <span className="dirty-dot" aria-label="Unsaved">●</span>}
              <span className="tab-name">{tab.name}</span>
            </button>
            <button
              className="tab-close"
              type="button"
              onClick={() => closeTabs([tab.id])}
              title={`Close ${tab.name}`}
              aria-label={`Close ${tab.name}`}
            >
              ×
            </button>
          </div>
        ))}
        <button
          className="new-tab"
          type="button"
          onClick={createNewFile}
          title="New file"
          aria-label="New file"
        >
          +
        </button>
      </nav>

      {tabContextMenu && (
        <div
          className="tab-context-menu"
          role="menu"
          aria-label="Tab actions"
          style={{ left: tabContextMenu.x, top: tabContextMenu.y }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => closeTabs([tabContextMenu.tabId])}
          >
            Close
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => closeTabs(tabs.map((tab) => tab.id))}
          >
            Close all
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!tabs.some((tab) => !tab.dirty)}
            onClick={() =>
              closeTabs(tabs.filter((tab) => !tab.dirty).map((tab) => tab.id))
            }
          >
            Close saved
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={tabs.length === 1}
            onClick={() =>
              closeTabs(
                tabs
                  .filter((tab) => tab.id !== tabContextMenu.tabId)
                  .map((tab) => tab.id),
              )
            }
          >
            Close other
          </button>
        </div>
      )}

      <section className="editor-pane">
        {activeTab && (
          <Editor
            path={activeTab.modelPath}
            defaultValue={activeTab.initialContent}
            defaultLanguage={activeTab.language}
            language={activeTab.language}
            theme="tekst-dark"
            saveViewState
            onMount={handleEditorMount}
            onChange={() => setTabDirty(activeTab.id)}
            beforeMount={(monaco) => {
              monaco.editor.defineTheme("tekst-dark", {
                base: "vs-dark",
                inherit: true,
                rules: [],
                colors: {
                  "editor.background": "#111315",
                  "editorGutter.background": "#111315",
                  "editorLineNumber.foreground": "#555c64",
                  "editorLineNumber.activeForeground": "#c3c8ce",
                  "editor.lineHighlightBackground": "#171a1d",
                },
              });
            }}
            options={{
              automaticLayout: true,
              lineNumbers: "on",
              lineNumbersMinChars: 3,
              minimap: { enabled: false },
              glyphMargin: false,
              folding: false,
              scrollBeyondLastLine: false,
              smoothScrolling: false,
              renderWhitespace: "selection",
              renderLineHighlight: "line",
              overviewRulerLanes: 0,
              hideCursorInOverviewRuler: true,
              wordWrap: "off",
              fontFamily:
                "'Cascadia Code', 'Segoe UI Mono', Consolas, monospace",
              fontSize: 14,
              lineHeight: 22,
              padding: { top: 10, bottom: 10 },
              tabSize: 2,
              insertSpaces: true,
              cursorBlinking: "smooth",
              cursorSmoothCaretAnimation: "off",
              bracketPairColorization: { enabled: false },
              stickyScroll: { enabled: false },
              guides: { indentation: false, bracketPairs: false },
              quickSuggestions: false,
              suggestOnTriggerCharacters: false,
            }}
          />
        )}
      </section>

      <footer className="status-bar">
        <span className="status-message" title={status}>
          {status}
        </span>
        <span>
          Ln {cursor.line}, Col {cursor.column}
        </span>
        <span>{activeTab?.language ?? "plaintext"}</span>
        <span>UTF-8</span>
      </footer>
    </main>
  );
}

export default App;
