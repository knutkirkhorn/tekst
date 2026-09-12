import Editor, {type Monaco, type OnMount} from '@monaco-editor/react';
import {getVersion} from '@tauri-apps/api/app';
import {invoke} from '@tauri-apps/api/core';
import {listen} from '@tauri-apps/api/event';
import {join} from '@tauri-apps/api/path';
import {getCurrentWebview, type DragDropEvent} from '@tauri-apps/api/webview';
import {getCurrentWindow} from '@tauri-apps/api/window';
import {open, save} from '@tauri-apps/plugin-dialog';
import {readDir, readTextFile, writeTextFile} from '@tauri-apps/plugin-fs';
import {openUrl} from '@tauri-apps/plugin-opener';
import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import packageJson from '../package.json';
import FileTree, {type FileTreeNode} from './components/FileTree';
import QuickOpen, {type RecentFile} from './components/QuickOpen';
import './App.css';

type EditorTab = {
	id: string;
	modelPath: string;
	filePath: string | null;
	name: string;
	initialContent: string;
	content: string;
	language: string;
	dirty: boolean;
};

type SidebarMode = 'files' | 'search';

type SearchMatch = {
	tabId?: string;
	filePath?: string;
	fileName: string;
	line: number;
	preview: string;
};

type DirectorySearchMatch = {
	path: string;
	line: number;
	preview: string;
};

type TabContextMenu = {
	tabId: string;
	x: number;
	y: number;
};

type TabDropTarget = {
	tabId: string;
	position: 'before' | 'after';
};

type TabDrag = {
	id: string;
	pointerId: number;
	startX: number;
	hasMoved: boolean;
};

const APP_MENUS = ['file', 'view', 'help'] as const;

type AppMenu = (typeof APP_MENUS)[number];

type AppMenuSelection = {
	menu: AppMenu;
	index: number;
};

type PendingTabClose = {
	ids: string[];
	description: string;
};

type EditorInstance = Parameters<OnMount>[0];

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
	c: 'c',
	cc: 'cpp',
	cpp: 'cpp',
	cs: 'csharp',
	css: 'css',
	go: 'go',
	h: 'c',
	hpp: 'cpp',
	html: 'html',
	java: 'java',
	js: 'javascript',
	json: 'json',
	jsx: 'javascript',
	md: 'markdown',
	py: 'python',
	rs: 'rust',
	sh: 'shell',
	sql: 'sql',
	ts: 'typescript',
	tsx: 'typescript',
	xml: 'xml',
	yaml: 'yaml',
	yml: 'yaml',
};

const EMPTY_DOCUMENT = '';
const RELEASES_URL = 'https://github.com/knutkirkhorn/tekst/releases';
const PRIMARY_MODIFIER_LABEL = navigator.userAgent.includes('Macintosh')
	? '⌘'
	: 'Ctrl';

function fileNameFromPath(path: string) {
	return path.split(/[\\/]/).pop() || 'Untitled';
}

function languageFromPath(path: string) {
	const extension = path.split('.').pop()?.toLowerCase() ?? '';
	return LANGUAGE_BY_EXTENSION[extension] ?? 'plaintext';
}

function createUntitledTab(sequence: number): EditorTab {
	const name = sequence === 1 ? 'Untitled' : `Untitled ${sequence}`;
	return {
		id: crypto.randomUUID(),
		modelPath: `inmemory://tekst/${crypto.randomUUID()}.txt`,
		filePath: null,
		name,
		initialContent: EMPTY_DOCUMENT,
		content: EMPTY_DOCUMENT,
		language: 'plaintext',
		dirty: false,
	};
}

function searchOpenTabs(tabs: EditorTab[], query: string): SearchMatch[] {
	const normalizedQuery = query.trim().toLocaleLowerCase();
	if (!normalizedQuery) return [];

	const matches: SearchMatch[] = [];
	for (const tab of tabs) {
		const lines = tab.content.split(/\r?\n/);
		for (const [index, line] of lines.entries()) {
			// eslint-disable-next-line unicorn/no-break-in-nested-loop
			if (!line.toLocaleLowerCase().includes(normalizedQuery)) continue;
			matches.push({
				tabId: tab.id,
				filePath: tab.filePath ?? undefined,
				fileName: tab.name,
				line: index + 1,
				preview: line.trim() || 'Blank line',
			});
			if (matches.length === 100) return matches;
		}
	}
	return matches;
}

function nextUntitledSequence(tabs: EditorTab[]) {
	const usedSequences = new Set(
		tabs
			.filter(tab => tab.filePath === null)
			.map(tab => {
				if (tab.name === 'Untitled') return 1;
				const match = /^Untitled (\d+)$/.exec(tab.name);
				return match ? Number(match[1]) : 0;
			}),
	);

	let sequence = 1;
	while (usedSequences.has(sequence)) sequence += 1;
	return sequence;
}

async function readDirectoryNodes(path: string): Promise<FileTreeNode[]> {
	const entries = await readDir(path);
	const nodes = await Promise.all(
		entries.map(async entry => ({
			path: await join(path, entry.name),
			name: entry.name,
			isDirectory: entry.isDirectory,
			isExpanded: false,
			isLoading: false,
			children: null,
		})),
	);

	// Sorting this newly created local array in place avoids requiring ES2023.
	// eslint-disable-next-line unicorn/no-array-sort
	return nodes.sort(
		(left, right) =>
			Number(right.isDirectory) - Number(left.isDirectory) ||
			left.name.localeCompare(right.name, undefined, {sensitivity: 'base'}),
	);
}

function findTreeNode(
	nodes: FileTreeNode[],
	path: string,
): FileTreeNode | undefined {
	for (const node of nodes) {
		if (node.path === path) return node;
		if (node.children) {
			const match = findTreeNode(node.children, path);
			if (match) return match;
		}
	}
	return undefined;
}

function updateTreeNode(
	nodes: FileTreeNode[],
	path: string,
	update: (node: FileTreeNode) => FileTreeNode,
): FileTreeNode[] {
	return nodes.map(node => {
		if (node.path === path) return update(node);
		if (!node.children) return node;
		return {...node, children: updateTreeNode(node.children, path, update)};
	});
}

function App() {
	const initialTab = useMemo(() => createUntitledTab(1), []);
	const [tabs, setTabs] = useState<EditorTab[]>([initialTab]);
	const [activeTabId, setActiveTabId] = useState(initialTab.id);
	const [status, setStatus] = useState('Ready');
	const [cursor, setCursor] = useState({line: 1, column: 1});
	const [isDraggingFiles, setIsDraggingFiles] = useState(false);
	const [tabContextMenu, setTabContextMenu] = useState<TabContextMenu | null>(
		null,
	);
	const [openAppMenu, setOpenAppMenu] = useState<AppMenu | null>(null);
	const [selectedAppMenuItem, setSelectedAppMenuItem] =
		useState<AppMenuSelection | null>(null);
	const [pendingTabClose, setPendingTabClose] =
		useState<PendingTabClose | null>(null);
	const [pendingWindowClose, setPendingWindowClose] = useState<string | null>(
		null,
	);
	const [isSavingBeforeClose, setIsSavingBeforeClose] = useState(false);
	const [draggedTabId, setDraggedTabId] = useState<string | null>(null);
	const [tabDropTarget, setTabDropTarget] = useState<TabDropTarget | null>(
		null,
	);
	const [isSidebarOpen, setIsSidebarOpen] = useState(true);
	const [sidebarMode, setSidebarMode] = useState<SidebarMode>('files');
	const [sidebarSearchQuery, setSidebarSearchQuery] = useState('');
	const [directorySearchMatches, setDirectorySearchMatches] = useState<
		DirectorySearchMatch[]
	>([]);
	const [directoryRoot, setDirectoryRoot] = useState<FileTreeNode | null>(null);
	const [recentFiles, setRecentFiles] = useState<RecentFile[]>([]);
	const [isQuickOpenOpen, setIsQuickOpenOpen] = useState(false);
	const [isAboutOpen, setIsAboutOpen] = useState(false);
	const [appVersion, setAppVersion] = useState(packageJson.version);
	const editorRef = useRef<EditorInstance | null>(null);
	const monacoRef = useRef<Monaco | null>(null);
	const appMenuRefs = useRef<Record<AppMenu, HTMLDivElement | null>>({
		file: null,
		view: null,
		help: null,
	});
	const tabDragRef = useRef<TabDrag | null>(null);
	const tabDropTargetRef = useRef<TabDropTarget | null>(null);
	const ignoreTabClickRef = useRef(false);
	const tabsRef = useRef(tabs);
	tabsRef.current = tabs;

	const activeTab = tabs.find(tab => tab.id === activeTabId) ?? tabs[0];
	const sidebarSearchMatches = useMemo(() => {
		const openFilePaths = new Set(
			tabs.flatMap(tab => (tab.filePath ? [tab.filePath] : [])),
		);
		const folderMatches = directorySearchMatches
			.filter(match => !openFilePaths.has(match.path))
			.map(match => ({
				filePath: match.path,
				fileName: fileNameFromPath(match.path),
				line: match.line,
				preview: match.preview || 'Blank line',
			}));
		return [
			...searchOpenTabs(tabs, sidebarSearchQuery),
			...folderMatches,
		].slice(0, 100);
	}, [tabs, sidebarSearchQuery, directorySearchMatches]);

	const updateTabDirty = useCallback((id: string, content: string) => {
		setTabs(currentTabs =>
			currentTabs.map(tab =>
				tab.id === id
					? {...tab, content, dirty: content !== tab.initialContent}
					: tab,
			),
		);
	}, []);

	const createNewFile = useCallback(() => {
		const tab = createUntitledTab(nextUntitledSequence(tabs));
		setTabs(currentTabs => [...currentTabs, tab]);
		setActiveTabId(tab.id);
		setStatus('New file');
	}, [tabs]);

	const rememberRecentFile = useCallback((path: string) => {
		setRecentFiles(files =>
			[
				{path, name: fileNameFromPath(path)},
				...files.filter(file => file.path !== path),
			].slice(0, 30),
		);
	}, []);

	const removeRecentFile = useCallback((path: string) => {
		setRecentFiles(files => files.filter(file => file.path !== path));
	}, []);

	const openPaths = useCallback(
		async (paths: string[]) => {
			try {
				const existingPath = new Map(
					tabs
						.filter(tab => tab.filePath)
						.map(tab => [tab.filePath as string, tab.id]),
				);
				const newTabs: EditorTab[] = [];

				for (const filePath of paths) {
					const existingId = existingPath.get(filePath);
					if (existingId) {
						setActiveTabId(existingId);
						rememberRecentFile(filePath);
						continue;
					}

					const content = await readTextFile(filePath);
					const tab: EditorTab = {
						id: crypto.randomUUID(),
						modelPath: `file://${filePath.replaceAll('\\', '/')}`,
						filePath,
						name: fileNameFromPath(filePath),
						initialContent: content,
						content,
						language: languageFromPath(filePath),
						dirty: false,
					};
					newTabs.push(tab);
					existingPath.set(filePath, tab.id);
					rememberRecentFile(filePath);
				}

				if (newTabs.length > 0) {
					setTabs(currentTabs => {
						const canReplaceEmpty =
							currentTabs.length === 1 &&
							currentTabs[0].filePath === null &&
							!currentTabs[0].dirty &&
							currentTabs[0].initialContent === EMPTY_DOCUMENT;
						return canReplaceEmpty ? newTabs : [...currentTabs, ...newTabs];
					});
					const lastNewTab = newTabs.at(-1);
					if (lastNewTab) setActiveTabId(lastNewTab.id);
				}
				setStatus(
					`${paths.length} file${paths.length === 1 ? '' : 's'} opened`,
				);
			} catch (error) {
				setStatus(`Open failed: ${String(error)}`);
			}
		},
		[rememberRecentFile, tabs],
	);

	const openFiles = useCallback(async () => {
		try {
			const selected = await open({
				multiple: true,
				directory: false,
				title: 'Open files',
			});

			if (!selected) return;
			await openPaths(Array.isArray(selected) ? selected : [selected]);
		} catch (error) {
			setStatus(`Open failed: ${String(error)}`);
		}
	}, [openPaths]);

	const loadDirectory = useCallback(async (path: string) => {
		try {
			setIsSidebarOpen(true);
			setStatus(`Loading ${fileNameFromPath(path)}…`);
			const children = await readDirectoryNodes(path);
			setDirectoryRoot({
				path,
				name: fileNameFromPath(path),
				isDirectory: true,
				isExpanded: true,
				isLoading: false,
				children,
			});
			setStatus(`Opened folder ${fileNameFromPath(path)}`);
		} catch (error) {
			setStatus(`Open folder failed: ${String(error)}`);
		}
	}, []);

	const openDirectory = useCallback(async () => {
		try {
			const selected = await open({
				multiple: false,
				directory: true,
				title: 'Open folder',
			});
			if (typeof selected !== 'string') return;
			await loadDirectory(selected);
		} catch (error) {
			setStatus(`Open folder failed: ${String(error)}`);
		}
	}, [loadDirectory]);

	const openDroppedPaths = useCallback(
		async (paths: string[]) => {
			try {
				setStatus('Opening dropped items…');
				const classifiedPaths = await Promise.all(
					paths.map(async path => {
						try {
							await readDir(path);
							return {path, isDirectory: true};
						} catch {
							return {path, isDirectory: false};
						}
					}),
				);
				const directories = classifiedPaths.filter(entry => entry.isDirectory);
				const files = classifiedPaths
					.filter(entry => !entry.isDirectory)
					.map(entry => entry.path);

				if (directories.length > 0) {
					await loadDirectory(directories[0].path);
				}
				if (files.length > 0) {
					await openPaths(files);
				}
			} catch (error) {
				setStatus(`Drop failed: ${String(error)}`);
			}
		},
		[loadDirectory, openPaths],
	);

	const toggleDirectory = useCallback(
		async (path: string) => {
			if (!directoryRoot?.children) return;
			const node = findTreeNode(directoryRoot.children, path);
			if (!node?.isDirectory || node.isLoading) return;

			if (node.children !== null) {
				setDirectoryRoot(root =>
					root?.children
						? {
								...root,
								children: updateTreeNode(root.children, path, current => ({
									...current,
									isExpanded: !current.isExpanded,
								})),
							}
						: root,
				);
				return;
			}

			setDirectoryRoot(root =>
				root?.children
					? {
							...root,
							children: updateTreeNode(root.children, path, current => ({
								...current,
								isLoading: true,
							})),
						}
					: root,
			);

			try {
				const children = await readDirectoryNodes(path);
				setDirectoryRoot(root =>
					root?.children
						? {
								...root,
								children: updateTreeNode(root.children, path, current => ({
									...current,
									isExpanded: true,
									isLoading: false,
									children,
								})),
							}
						: root,
				);
			} catch (error) {
				setDirectoryRoot(root =>
					root?.children
						? {
								...root,
								children: updateTreeNode(root.children, path, current => ({
									...current,
									isLoading: false,
								})),
							}
						: root,
				);
				setStatus(`Could not read folder: ${String(error)}`);
			}
		},
		[directoryRoot],
	);

	const getTabContent = useCallback((tab: EditorTab) => {
		const model = monacoRef.current?.editor.getModel(
			monacoRef.current.Uri.parse(tab.modelPath),
		);
		return model?.getValue() ?? tab.content;
	}, []);

	const openSearchMatch = useCallback(
		(match: SearchMatch) => {
			const revealMatch = () =>
				requestAnimationFrame(() => {
					const editor = editorRef.current;
					if (!editor) return;
					editor.revealLineInCenter(match.line);
					editor.setPosition({lineNumber: match.line, column: 1});
					editor.focus();
				});

			if (match.tabId) {
				setActiveTabId(match.tabId);
				revealMatch();
			} else if (match.filePath) {
				void openPaths([match.filePath]).then(revealMatch);
			}
		},
		[openPaths],
	);

	const saveTab = useCallback(
		async (tab: EditorTab, isSaveAs = false) => {
			try {
				let targetPath = tab.filePath;
				if (!targetPath || isSaveAs) {
					targetPath = await save({
						title: 'Save file',
						defaultPath: tab.filePath ?? tab.name,
					});
				}
				if (!targetPath) return false;

				const savedContent = getTabContent(tab);
				await writeTextFile(targetPath, savedContent);
				const newName = fileNameFromPath(targetPath);
				const currentContent = getTabContent(tab);
				setTabs(currentTabs =>
					currentTabs.map(currentTab =>
						currentTab.id === tab.id
							? {
									...currentTab,
									filePath: targetPath,
									name: newName,
									initialContent: savedContent,
									content: savedContent,
									language: languageFromPath(targetPath),
									dirty: currentContent !== savedContent,
								}
							: currentTab,
					),
				);
				if (!tab.filePath) rememberRecentFile(targetPath);
				setStatus(`Saved ${newName}`);
				return true;
			} catch (error) {
				setStatus(`Save failed: ${String(error)}`);
				return false;
			}
		},
		[getTabContent, rememberRecentFile],
	);

	const saveAllAndCloseWindow = useCallback(async () => {
		setIsSavingBeforeClose(true);
		const dirtyTabs = tabs.filter(tab => tab.dirty);

		for (const tab of dirtyTabs) {
			const didSave = await saveTab(tab);
			if (!didSave) {
				setIsSavingBeforeClose(false);
				return;
			}
		}

		try {
			await getCurrentWindow().destroy();
		} catch (error) {
			setIsSavingBeforeClose(false);
			setStatus(`Close failed: ${String(error)}`);
		}
	}, [saveTab, tabs]);

	const performCloseTabs = useCallback(
		(ids: string[]) => {
			const idSet = new Set(ids);
			const tabsToClose = tabs.filter(tab => idSet.has(tab.id));
			if (tabsToClose.length === 0) return;

			const firstClosedIndex = tabs.findIndex(tab => idSet.has(tab.id));
			const remainingTabs = tabs.filter(tab => !idSet.has(tab.id));

			for (const tab of tabsToClose) {
				monacoRef.current?.editor
					.getModel(monacoRef.current.Uri.parse(tab.modelPath))
					?.dispose();
			}

			if (remainingTabs.length === 0) {
				const replacement = createUntitledTab(1);
				setTabs([replacement]);
				setActiveTabId(replacement.id);
			} else {
				setTabs(remainingTabs);
				if (idSet.has(activeTabId)) {
					const nextIndex = Math.min(
						firstClosedIndex,
						remainingTabs.length - 1,
					);
					setActiveTabId(remainingTabs[Math.max(0, nextIndex)].id);
				}
			}

			setTabContextMenu(null);
			setStatus(
				`Closed ${tabsToClose.length} file${tabsToClose.length === 1 ? '' : 's'}`,
			);
		},
		[activeTabId, tabs],
	);

	const savePendingTabsAndClose = useCallback(async () => {
		if (!pendingTabClose) return;

		setIsSavingBeforeClose(true);
		const dirtyTabs = tabs.filter(
			tab => pendingTabClose.ids.includes(tab.id) && tab.dirty,
		);

		for (const tab of dirtyTabs) {
			const didSave = await saveTab(tab);
			if (!didSave) {
				setIsSavingBeforeClose(false);
				return;
			}
		}

		performCloseTabs(pendingTabClose.ids);
		setPendingTabClose(null);
		setIsSavingBeforeClose(false);
	}, [pendingTabClose, performCloseTabs, saveTab, tabs]);

	const closeTabs = useCallback(
		(ids: string[]) => {
			const tabsToClose = tabs.filter(tab => ids.includes(tab.id));
			const dirtyTabs = tabsToClose.filter(tab => tab.dirty);

			if (dirtyTabs.length > 0) {
				setPendingTabClose({
					ids,
					description:
						dirtyTabs.length === 1
							? `"${dirtyTabs[0].name}" has unsaved changes.`
							: `${dirtyTabs.length} files have unsaved changes.`,
				});
				return;
			}

			performCloseTabs(ids);
		},
		[performCloseTabs, tabs],
	);

	const focusAppMenuItem = useCallback((menu: AppMenu, index: number) => {
		requestAnimationFrame(() => {
			const items = [
				...(appMenuRefs.current[menu]?.querySelectorAll<HTMLButtonElement>(
					'button:not(:disabled)',
				) ?? []),
			];
			if (items.length === 0) return;

			const selectedIndex =
				((index % items.length) + items.length) % items.length;
			setSelectedAppMenuItem({menu, index: selectedIndex});
			items[selectedIndex].focus();
		});
	}, []);

	const moveAppMenuFocus = useCallback(
		(menu: AppMenu, direction: 1 | -1) => {
			const items = [
				...(appMenuRefs.current[menu]?.querySelectorAll<HTMLButtonElement>(
					'button:not(:disabled)',
				) ?? []),
			];
			const selectedIndex =
				selectedAppMenuItem?.menu === menu
					? selectedAppMenuItem.index
					: items.indexOf(document.activeElement as HTMLButtonElement);
			focusAppMenuItem(
				menu,
				selectedIndex === -1
					? direction === 1
						? 0
						: -1
					: selectedIndex + direction,
			);
		},
		[focusAppMenuItem, selectedAppMenuItem],
	);

	const switchAppMenu = useCallback(
		(menu: AppMenu, direction: 1 | -1) => {
			const currentIndex = APP_MENUS.indexOf(menu);
			const nextMenu =
				APP_MENUS[
					(currentIndex + direction + APP_MENUS.length) % APP_MENUS.length
				];
			setOpenAppMenu(nextMenu);
			focusAppMenuItem(nextMenu, 0);
		},
		[focusAppMenuItem],
	);

	const selectAdjacentTab = useCallback(
		(direction: 1 | -1) => {
			const currentIndex = tabs.findIndex(tab => tab.id === activeTabId);
			const nextIndex = (currentIndex + direction + tabs.length) % tabs.length;
			setActiveTabId(tabs[nextIndex].id);
		},
		[activeTabId, tabs],
	);

	const reorderTabs = useCallback(
		(
			sourceId: string,
			targetId: string,
			position: TabDropTarget['position'],
		) => {
			if (sourceId === targetId) return;

			setTabs(currentTabs => {
				const sourceTab = currentTabs.find(tab => tab.id === sourceId);
				if (!sourceTab) return currentTabs;

				const remainingTabs = currentTabs.filter(tab => tab.id !== sourceId);
				const targetIndex = remainingTabs.findIndex(tab => tab.id === targetId);
				if (targetIndex === -1) return currentTabs;

				const insertionIndex = targetIndex + (position === 'after' ? 1 : 0);
				return [
					...remainingTabs.slice(0, insertionIndex),
					sourceTab,
					...remainingTabs.slice(insertionIndex),
				];
			});
		},
		[],
	);

	const updateTabDropTarget = useCallback(
		(sourceId: string, clientX: number, clientY: number) => {
			const target = document
				.elementFromPoint(clientX, clientY)
				?.closest<HTMLDivElement>('.tab[data-tab-id]');
			if (!target || target.dataset.tabId === sourceId) {
				tabDropTargetRef.current = null;
				setTabDropTarget(null);
				return;
			}

			const bounds = target.getBoundingClientRect();
			const dropTarget: TabDropTarget = {
				tabId: target.dataset.tabId as string,
				position: clientX < bounds.left + bounds.width / 2 ? 'before' : 'after',
			};
			tabDropTargetRef.current = dropTarget;
			setTabDropTarget(dropTarget);
		},
		[],
	);

	useEffect(() => {
		const handleKeyDown = (event: KeyboardEvent) => {
			if (openAppMenu) {
				if (event.key === 'ArrowDown') {
					event.preventDefault();
					moveAppMenuFocus(openAppMenu, 1);
					return;
				}
				if (event.key === 'ArrowUp') {
					event.preventDefault();
					moveAppMenuFocus(openAppMenu, -1);
					return;
				}
				if (event.key === 'ArrowRight') {
					event.preventDefault();
					switchAppMenu(openAppMenu, 1);
					return;
				}
				if (event.key === 'ArrowLeft') {
					event.preventDefault();
					switchAppMenu(openAppMenu, -1);
					return;
				}
			}
			if (event.key === 'Escape') {
				setTabContextMenu(null);
				setOpenAppMenu(null);
				setSelectedAppMenuItem(null);
				setIsQuickOpenOpen(false);
				setIsAboutOpen(false);
				return;
			}
			if (event.ctrlKey && event.key === 'Tab') {
				event.preventDefault();
				selectAdjacentTab(event.shiftKey ? -1 : 1);
				return;
			}
			if (!event.ctrlKey && !event.metaKey) return;

			const key = event.key.toLowerCase();
			if (key === 'r' && event.ctrlKey) {
				event.preventDefault();
			} else
				switch (key) {
					case 'p': {
						event.preventDefault();
						setTabContextMenu(null);
						setIsQuickOpenOpen(isOpen => !isOpen);
						break;
					}
					case 'b': {
						event.preventDefault();
						setIsSidebarOpen(isOpen => !isOpen);
						break;
					}
					case 'n': {
						event.preventDefault();
						createNewFile();
						break;
					}
					case 'o': {
						event.preventDefault();
						void openFiles();
						break;
					}
					default: {
						if (key === 's' && activeTab) {
							event.preventDefault();
							void saveTab(activeTab, event.shiftKey);
						} else if (key === 'w' && activeTab) {
							event.preventDefault();
							closeTabs([activeTab.id]);
						}
						break;
					}
				}
		};

		globalThis.addEventListener('keydown', handleKeyDown);
		return () => globalThis.removeEventListener('keydown', handleKeyDown);
	}, [
		activeTab,
		closeTabs,
		createNewFile,
		moveAppMenuFocus,
		openAppMenu,
		openFiles,
		saveTab,
		selectAdjacentTab,
		switchAppMenu,
	]);

	useEffect(() => {
		if (!('__TAURI_INTERNALS__' in globalThis)) return;

		let isDisposed = false;
		let unlisten: (() => void) | undefined;

		void listen('close-tab', () => {
			if (activeTab) closeTabs([activeTab.id]);
		}).then(stopListening => {
			if (isDisposed) {
				stopListening();
			} else {
				unlisten = stopListening;
			}
		});

		// eslint-disable-next-line consistent-return
		return () => {
			isDisposed = true;
			unlisten?.();
		};
	}, [activeTab, closeTabs]);

	useEffect(() => {
		if (!tabContextMenu) return;

		const dismissMenu = () => setTabContextMenu(null);
		globalThis.addEventListener('pointerdown', dismissMenu);
		window.addEventListener('blur', dismissMenu);
		window.addEventListener('resize', dismissMenu);
		window.addEventListener('scroll', dismissMenu, {capture: true});
		// eslint-disable-next-line consistent-return
		return () => {
			globalThis.removeEventListener('pointerdown', dismissMenu);
			window.removeEventListener('blur', dismissMenu);
			window.removeEventListener('resize', dismissMenu);
			window.removeEventListener('scroll', dismissMenu, {capture: true});
		};
	}, [tabContextMenu]);

	useEffect(() => {
		if (!openAppMenu) return;

		const dismissMenu = () => {
			setOpenAppMenu(null);
			setSelectedAppMenuItem(null);
		};
		globalThis.addEventListener('pointerdown', dismissMenu);
		window.addEventListener('blur', dismissMenu);
		window.addEventListener('resize', dismissMenu);
		// eslint-disable-next-line consistent-return
		return () => {
			globalThis.removeEventListener('pointerdown', dismissMenu);
			window.removeEventListener('blur', dismissMenu);
			window.removeEventListener('resize', dismissMenu);
		};
	}, [openAppMenu]);

	useEffect(() => {
		const query = sidebarSearchQuery.trim();
		if (!query || !directoryRoot || !('__TAURI_INTERNALS__' in globalThis)) {
			setDirectorySearchMatches([]);
			return;
		}

		let isCurrent = true;
		setDirectorySearchMatches([]);
		// eslint-disable-next-line unicorn/no-unnecessary-global-this
		const timer = globalThis.setTimeout(() => {
			void invoke<DirectorySearchMatch[]>('search_directory', {
				root: directoryRoot.path,
				query,
			})
				.then(matches => {
					if (isCurrent) setDirectorySearchMatches(matches);
				})
				.catch(error => {
					if (!isCurrent) {
						return;
					}

					setDirectorySearchMatches([]);
					setStatus(`Folder search failed: ${String(error)}`);
				});
		}, 150);

		// eslint-disable-next-line consistent-return
		return () => {
			isCurrent = false;
			// eslint-disable-next-line unicorn/no-unnecessary-global-this
			globalThis.clearTimeout(timer);
		};
	}, [directoryRoot, sidebarSearchQuery]);

	useEffect(() => {
		const title = activeTab
			? `${activeTab.dirty ? '● ' : ''}${activeTab.name} — tekst`
			: 'tekst';
		document.title = title;
		if ('__TAURI_INTERNALS__' in globalThis) {
			void getCurrentWindow().setTitle(title);
		}
	}, [activeTab]);

	useEffect(() => {
		if (!('__TAURI_INTERNALS__' in globalThis)) return;

		let isDisposed = false;
		let unlisten: (() => void) | undefined;

		void getCurrentWindow()
			.onCloseRequested(event => {
				const dirtyTabs = tabsRef.current.filter(tab => tab.dirty);
				if (dirtyTabs.length === 0) return;

				event.preventDefault();
				setPendingWindowClose(
					dirtyTabs.length === 1
						? `"${dirtyTabs[0].name}" has unsaved changes.`
						: `${dirtyTabs.length} files have unsaved changes.`,
				);
			})
			.then(stopListening => {
				if (isDisposed) {
					stopListening();
				} else {
					unlisten = stopListening;
				}
			})
			.catch(error => {
				setStatus(`Close protection unavailable: ${String(error)}`);
			});

		// eslint-disable-next-line consistent-return
		return () => {
			isDisposed = true;
			unlisten?.();
		};
	}, []);

	useEffect(() => {
		if (!('__TAURI_INTERNALS__' in globalThis)) return;

		let isDisposed = false;
		let unlisten: (() => void) | undefined;

		void getCurrentWebview()
			// eslint-disable-next-line consistent-return
			.onDragDropEvent(({payload}: {payload: DragDropEvent}) => {
				switch (payload.type) {
					case 'enter':
					case 'over': {
						setIsDraggingFiles(true);
						break;
					}
					case 'drop': {
						setIsDraggingFiles(false);
						void openDroppedPaths(payload.paths);
						break;
					}
					case 'leave': {
						setIsDraggingFiles(false);
						break;
					}
					default: {
						const exhaustiveCheck: never = payload;
						return exhaustiveCheck;
					}
				}
			})
			.then(stopListening => {
				if (isDisposed) {
					stopListening();
				} else {
					unlisten = stopListening;
				}
			})
			.catch(error => {
				setStatus(`Drag and drop unavailable: ${String(error)}`);
			});

		// eslint-disable-next-line consistent-return
		return () => {
			isDisposed = true;
			unlisten?.();
		};
	}, [openDroppedPaths]);

	useEffect(() => {
		if (!('__TAURI_INTERNALS__' in globalThis)) return;

		void getVersion()
			.then(setAppVersion)
			.catch(() => {
				// Keep the package version as a fallback.
			});
	}, []);

	const handleEditorMount: OnMount = (editor, monaco) => {
		editorRef.current = editor;
		monacoRef.current = monaco;
		editor.focus();
		editor.onDidChangeCursorPosition(({position}) => {
			setCursor({line: position.lineNumber, column: position.column});
		});
	};

	return (
		<main className="app-shell">
			{isDraggingFiles && (
				<div className="drop-overlay" role="status">
					Drop files or a folder to open
				</div>
			)}
			<QuickOpen
				isOpen={isQuickOpenOpen}
				recentFiles={recentFiles}
				onClose={() => setIsQuickOpenOpen(false)}
				onRemove={removeRecentFile}
				onSelect={path => void openPaths([path])}
			/>
			{isAboutOpen && (
				<div className="confirm-dialog-backdrop" role="presentation">
					<section
						className="confirm-dialog"
						role="dialog"
						aria-modal="true"
						aria-labelledby="about-dialog-title"
						aria-describedby="about-dialog-version"
					>
						<h2 id="about-dialog-title">About tekst</h2>
						<p id="about-dialog-version">Version {appVersion}</p>
						<div className="confirm-dialog-actions">
							<button type="button" onClick={() => setIsAboutOpen(false)}>
								Close
							</button>
						</div>
					</section>
				</div>
			)}
			{pendingTabClose && (
				<div className="confirm-dialog-backdrop" role="presentation">
					<section
						className="confirm-dialog"
						role="dialog"
						aria-modal="true"
						aria-labelledby="close-tab-dialog-title"
						aria-describedby="close-tab-dialog-description"
					>
						<h2 id="close-tab-dialog-title">Save changes before closing?</h2>
						<p id="close-tab-dialog-description">
							{pendingTabClose.description}
						</p>
						<div className="confirm-dialog-actions">
							<button
								type="button"
								disabled={isSavingBeforeClose}
								onClick={() => setPendingTabClose(null)}
							>
								Cancel
							</button>
							<button
								className="danger"
								type="button"
								disabled={isSavingBeforeClose}
								onClick={() => {
									performCloseTabs(pendingTabClose.ids);
									setPendingTabClose(null);
								}}
							>
								Close without saving
							</button>
							<button
								type="button"
								disabled={isSavingBeforeClose}
								onClick={() => void savePendingTabsAndClose()}
							>
								{isSavingBeforeClose ? 'Saving…' : 'Save'}
							</button>
						</div>
					</section>
				</div>
			)}
			{pendingWindowClose && (
				<div className="confirm-dialog-backdrop" role="presentation">
					<section
						className="confirm-dialog"
						role="dialog"
						aria-modal="true"
						aria-labelledby="close-window-dialog-title"
						aria-describedby="close-window-dialog-description"
					>
						<h2 id="close-window-dialog-title">Save changes before closing?</h2>
						<p id="close-window-dialog-description">{pendingWindowClose}</p>
						<div className="confirm-dialog-actions">
							<button
								type="button"
								disabled={isSavingBeforeClose}
								onClick={() => setPendingWindowClose(null)}
							>
								Cancel
							</button>
							<button
								className="danger"
								type="button"
								disabled={isSavingBeforeClose}
								onClick={() => void getCurrentWindow().destroy()}
							>
								Discard
							</button>
							<button
								type="button"
								disabled={isSavingBeforeClose}
								onClick={() => void saveAllAndCloseWindow()}
							>
								{isSavingBeforeClose ? 'Saving…' : 'Save'}
							</button>
						</div>
					</section>
				</div>
			)}
			<header className="toolbar">
				<span className="brand">tekst</span>
				<div className="app-menus">
					<div className="app-menu">
						<button
							className="app-menu-trigger"
							type="button"
							aria-expanded={openAppMenu === 'file'}
							aria-haspopup="menu"
							onPointerDown={event => event.stopPropagation()}
							onClick={() => {
								const isOpen = openAppMenu === 'file';
								setOpenAppMenu(isOpen ? null : 'file');
								setSelectedAppMenuItem(
									isOpen ? null : {menu: 'file', index: 0},
								);
							}}
						>
							File
						</button>
						{openAppMenu === 'file' && (
							<div
								className="app-menu-dropdown"
								role="menu"
								aria-label="File"
								ref={menu => {
									appMenuRefs.current.file = menu;
								}}
								onPointerDown={event => event.stopPropagation()}
							>
								<button
									type="button"
									role="menuitem"
									className={
										selectedAppMenuItem?.menu === 'file' &&
										selectedAppMenuItem.index === 0
											? 'selected'
											: undefined
									}
									onMouseEnter={() =>
										setSelectedAppMenuItem({menu: 'file', index: 0})
									}
									onClick={() => {
										setOpenAppMenu(null);
										createNewFile();
									}}
								>
									<span>New file</span>
									<kbd>{PRIMARY_MODIFIER_LABEL} + N</kbd>
								</button>
								<button
									type="button"
									role="menuitem"
									className={
										selectedAppMenuItem?.menu === 'file' &&
										selectedAppMenuItem.index === 1
											? 'selected'
											: undefined
									}
									onMouseEnter={() =>
										setSelectedAppMenuItem({menu: 'file', index: 1})
									}
									onClick={() => {
										setOpenAppMenu(null);
										void openFiles();
									}}
								>
									<span>Open files…</span>
									<kbd>{PRIMARY_MODIFIER_LABEL} + O</kbd>
								</button>
								<button
									type="button"
									role="menuitem"
									className={
										selectedAppMenuItem?.menu === 'file' &&
										selectedAppMenuItem.index === 2
											? 'selected'
											: undefined
									}
									onMouseEnter={() =>
										setSelectedAppMenuItem({menu: 'file', index: 2})
									}
									onClick={() => {
										setOpenAppMenu(null);
										void openDirectory();
									}}
								>
									<span>Open folder…</span>
								</button>
								<div className="app-menu-separator" role="separator" />
								<button
									type="button"
									role="menuitem"
									disabled={!activeTab}
									className={
										selectedAppMenuItem?.menu === 'file' &&
										selectedAppMenuItem.index === 3
											? 'selected'
											: undefined
									}
									onMouseEnter={() =>
										setSelectedAppMenuItem({menu: 'file', index: 3})
									}
									onClick={() => {
										setOpenAppMenu(null);
										if (activeTab) void saveTab(activeTab);
									}}
								>
									<span>Save</span>
									<kbd>{PRIMARY_MODIFIER_LABEL} + S</kbd>
								</button>
								<button
									type="button"
									role="menuitem"
									disabled={!activeTab}
									className={
										selectedAppMenuItem?.menu === 'file' &&
										selectedAppMenuItem.index === 4
											? 'selected'
											: undefined
									}
									onMouseEnter={() =>
										setSelectedAppMenuItem({menu: 'file', index: 4})
									}
									onClick={() => {
										setOpenAppMenu(null);
										if (activeTab) void saveTab(activeTab, true);
									}}
								>
									<span>Save as…</span>
									<kbd>{PRIMARY_MODIFIER_LABEL} + Shift + S</kbd>
								</button>
								<div className="app-menu-separator" role="separator" />
								<button
									type="button"
									role="menuitem"
									disabled={!activeTab}
									className={
										selectedAppMenuItem?.menu === 'file' &&
										selectedAppMenuItem.index === 5
											? 'selected'
											: undefined
									}
									onMouseEnter={() =>
										setSelectedAppMenuItem({menu: 'file', index: 5})
									}
									onClick={() => {
										setOpenAppMenu(null);
										if (activeTab) closeTabs([activeTab.id]);
									}}
								>
									<span>Close tab</span>
									<kbd>{PRIMARY_MODIFIER_LABEL} + W</kbd>
								</button>
							</div>
						)}
					</div>

					<div className="app-menu">
						<button
							className="app-menu-trigger"
							type="button"
							aria-expanded={openAppMenu === 'view'}
							aria-haspopup="menu"
							onPointerDown={event => event.stopPropagation()}
							onClick={() => {
								const isOpen = openAppMenu === 'view';
								setOpenAppMenu(isOpen ? null : 'view');
								setSelectedAppMenuItem(
									isOpen ? null : {menu: 'view', index: 0},
								);
							}}
						>
							View
						</button>
						{openAppMenu === 'view' && (
							<div
								className="app-menu-dropdown"
								role="menu"
								aria-label="View"
								ref={menu => {
									appMenuRefs.current.view = menu;
								}}
								onPointerDown={event => event.stopPropagation()}
							>
								<button
									type="button"
									role="menuitem"
									className={
										selectedAppMenuItem?.menu === 'view' &&
										selectedAppMenuItem.index === 0
											? 'selected'
											: undefined
									}
									onMouseEnter={() =>
										setSelectedAppMenuItem({menu: 'view', index: 0})
									}
									onClick={() => {
										setOpenAppMenu(null);
										setIsSidebarOpen(isOpen => !isOpen);
									}}
								>
									<span>{isSidebarOpen ? 'Hide sidebar' : 'Show sidebar'}</span>
									<kbd>{PRIMARY_MODIFIER_LABEL} + B</kbd>
								</button>
								<button
									type="button"
									role="menuitem"
									className={
										selectedAppMenuItem?.menu === 'view' &&
										selectedAppMenuItem.index === 1
											? 'selected'
											: undefined
									}
									onMouseEnter={() =>
										setSelectedAppMenuItem({menu: 'view', index: 1})
									}
									onClick={() => {
										setOpenAppMenu(null);
										setIsQuickOpenOpen(true);
									}}
								>
									<span>Quick open</span>
									<kbd>{PRIMARY_MODIFIER_LABEL} + P</kbd>
								</button>
							</div>
						)}
					</div>

					<div className="app-menu">
						<button
							className="app-menu-trigger"
							type="button"
							aria-expanded={openAppMenu === 'help'}
							aria-haspopup="menu"
							onPointerDown={event => event.stopPropagation()}
							onClick={() => {
								const isOpen = openAppMenu === 'help';
								setOpenAppMenu(isOpen ? null : 'help');
								setSelectedAppMenuItem(
									isOpen ? null : {menu: 'help', index: 0},
								);
							}}
						>
							Help
						</button>
						{openAppMenu === 'help' && (
							<div
								className="app-menu-dropdown"
								role="menu"
								aria-label="Help"
								ref={menu => {
									appMenuRefs.current.help = menu;
								}}
								onPointerDown={event => event.stopPropagation()}
							>
								<button
									type="button"
									role="menuitem"
									className={
										selectedAppMenuItem?.menu === 'help' &&
										selectedAppMenuItem.index === 0
											? 'selected'
											: undefined
									}
									onMouseEnter={() =>
										setSelectedAppMenuItem({menu: 'help', index: 0})
									}
									onClick={() => {
										setOpenAppMenu(null);
										setSelectedAppMenuItem(null);
										void openUrl(RELEASES_URL);
									}}
								>
									<span>See latest releases on GitHub</span>
								</button>
								<div className="app-menu-separator" role="separator" />
								<button
									type="button"
									role="menuitem"
									className={
										selectedAppMenuItem?.menu === 'help' &&
										selectedAppMenuItem.index === 1
											? 'selected'
											: undefined
									}
									onMouseEnter={() =>
										setSelectedAppMenuItem({menu: 'help', index: 1})
									}
									onClick={() => {
										setOpenAppMenu(null);
										setSelectedAppMenuItem(null);
										setIsAboutOpen(true);
									}}
								>
									<span>About tekst</span>
								</button>
							</div>
						)}
					</div>
				</div>
			</header>

			<div className="workspace">
				{isSidebarOpen && (
					<aside
						className="sidebar"
						aria-label={
							sidebarMode === 'files' ? 'File explorer' : 'Search open files'
						}
					>
						<div className="sidebar-header">
							<span title={directoryRoot?.path}>
								{sidebarMode === 'files'
									? (directoryRoot?.name ?? 'Explorer')
									: 'Search'}
							</span>
							<button
								className="sidebar-mode-toggle"
								type="button"
								onClick={() =>
									setSidebarMode(mode =>
										mode === 'files' ? 'search' : 'files',
									)
								}
								title={
									sidebarMode === 'files'
										? 'Search open files'
										: 'Show file explorer'
								}
								aria-label={
									sidebarMode === 'files'
										? 'Search open files'
										: 'Show file explorer'
								}
							>
								{sidebarMode === 'files' ? '⌕' : '←'}
							</button>
							{sidebarMode === 'files' && (
								<button
									type="button"
									onClick={() => void openDirectory()}
									title="Open folder"
									aria-label="Open folder"
								>
									+
								</button>
							)}
						</div>
						{sidebarMode === 'search' ? (
							<div className="sidebar-search">
								<input
									autoFocus
									type="search"
									value={sidebarSearchQuery}
									onChange={event => setSidebarSearchQuery(event.target.value)}
									placeholder="Search open files"
									aria-label="Search content in open files"
								/>
								{sidebarSearchQuery.trim() ? (
									sidebarSearchMatches.length > 0 ? (
										<div className="sidebar-search-results" role="list">
											{sidebarSearchMatches.map(match => (
												<button
													key={`${match.tabId ?? match.filePath}-${match.line}`}
													type="button"
													className="sidebar-search-result"
													onClick={() => openSearchMatch(match)}
												>
													<span>
														{match.fileName} : {match.line}
													</span>
													<small>{match.preview}</small>
												</button>
											))}
										</div>
									) : (
										<div className="sidebar-empty">
											No matches in open files
										</div>
									)
								) : (
									<div className="sidebar-empty">
										Search the contents of your open files
									</div>
								)}
							</div>
						) : directoryRoot?.children ? (
							<FileTree
								nodes={directoryRoot.children}
								onOpenFile={path => void openPaths([path])}
								onToggleDirectory={path => void toggleDirectory(path)}
								selectedPath={activeTab?.filePath ?? null}
							/>
						) : (
							<div className="sidebar-empty">
								<span>No folder open</span>
								<button type="button" onClick={() => void openDirectory()}>
									Open folder
								</button>
							</div>
						)}
					</aside>
				)}

				<div className="editor-workspace">
					<nav className="tab-bar" aria-label="Open files">
						{tabs.map(tab => (
							<div
								className={`tab ${tab.id === activeTabId ? 'active' : ''} ${
									tab.id === draggedTabId ? 'dragging' : ''
								} ${
									tabDropTarget?.tabId === tab.id
										? `drop-${tabDropTarget.position}`
										: ''
								}`}
								key={tab.id}
								data-tab-id={tab.id}
								onPointerDown={event => {
									if (
										event.button !== 0 ||
										(event.target instanceof HTMLElement &&
											event.target.closest('.tab-close'))
									) {
										return;
									}
									event.currentTarget.setPointerCapture(event.pointerId);
									tabDragRef.current = {
										id: tab.id,
										pointerId: event.pointerId,
										startX: event.clientX,
										hasMoved: false,
									};
								}}
								onPointerMove={event => {
									const tabDrag = tabDragRef.current;
									if (!tabDrag || tabDrag.pointerId !== event.pointerId) return;
									if (
										!tabDrag.hasMoved &&
										Math.abs(event.clientX - tabDrag.startX) < 4
									) {
										return;
									}

									tabDrag.hasMoved = true;
									ignoreTabClickRef.current = true;
									setDraggedTabId(tabDrag.id);
									updateTabDropTarget(tabDrag.id, event.clientX, event.clientY);
								}}
								onPointerUp={event => {
									const tabDrag = tabDragRef.current;
									if (!tabDrag || tabDrag.pointerId !== event.pointerId) return;
									if (tabDrag.hasMoved && tabDropTargetRef.current) {
										reorderTabs(
											tabDrag.id,
											tabDropTargetRef.current.tabId,
											tabDropTargetRef.current.position,
										);
									}
									if (tabDrag.hasMoved) {
										setTimeout(() => {
											ignoreTabClickRef.current = false;
										}, 0);
									}
									tabDragRef.current = null;
									tabDropTargetRef.current = null;
									setDraggedTabId(null);
									setTabDropTarget(null);
								}}
								onPointerCancel={() => {
									tabDragRef.current = null;
									tabDropTargetRef.current = null;
									setDraggedTabId(null);
									setTabDropTarget(null);
								}}
								onClick={event => {
									if (
										event.target instanceof HTMLElement &&
										event.target.closest('.tab-close')
									) {
										return;
									}
									if (ignoreTabClickRef.current) {
										ignoreTabClickRef.current = false;
										return;
									}
									setActiveTabId(tab.id);
								}}
								onContextMenu={event => {
									event.preventDefault();
									event.stopPropagation();
									setActiveTabId(tab.id);
									setTabContextMenu({
										tabId: tab.id,
										x: Math.max(
											4,
											Math.min(event.clientX, window.innerWidth - 180),
										),
										y: Math.max(
											4,
											Math.min(event.clientY, window.innerHeight - 150),
										),
									});
								}}
							>
								<button
									className="tab-select"
									type="button"
									title={tab.filePath ?? tab.name}
								>
									{tab.dirty && (
										<span className="dirty-dot" aria-label="Unsaved">
											●
										</span>
									)}
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
							style={{left: tabContextMenu.x, top: tabContextMenu.y}}
							onPointerDown={event => event.stopPropagation()}
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
								onClick={() => closeTabs(tabs.map(tab => tab.id))}
							>
								Close all
							</button>
							<button
								type="button"
								role="menuitem"
								disabled={tabs.every(tab => tab.dirty)}
								onClick={() =>
									closeTabs(tabs.filter(tab => !tab.dirty).map(tab => tab.id))
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
											.filter(tab => tab.id !== tabContextMenu.tabId)
											.map(tab => tab.id),
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
								onChange={value =>
									updateTabDirty(activeTab.id, value ?? EMPTY_DOCUMENT)
								}
								beforeMount={monaco => {
									monaco.editor.defineTheme('tekst-dark', {
										base: 'vs-dark',
										inherit: true,
										rules: [],
										colors: {
											'editor.background': '#111315',
											'editorGutter.background': '#111315',
											'editorLineNumber.foreground': '#555c64',
											'editorLineNumber.activeForeground': '#c3c8ce',
											'editor.lineHighlightBackground': '#171a1d',
										},
									});
								}}
								options={{
									automaticLayout: true,
									lineNumbers: 'on',
									lineNumbersMinChars: 3,
									minimap: {enabled: false},
									glyphMargin: false,
									folding: false,
									scrollBeyondLastLine: false,
									smoothScrolling: false,
									renderWhitespace: 'selection',
									renderLineHighlight: 'line',
									overviewRulerLanes: 0,
									hideCursorInOverviewRuler: true,
									wordWrap: 'off',
									fontFamily:
										"'Cascadia Code', 'Segoe UI Mono', Consolas, monospace",
									fontSize: 14,
									lineHeight: 22,
									padding: {top: 10, bottom: 10},
									tabSize: 2,
									insertSpaces: true,
									cursorBlinking: 'smooth',
									cursorSmoothCaretAnimation: 'off',
									bracketPairColorization: {enabled: false},
									stickyScroll: {enabled: false},
									guides: {indentation: false, bracketPairs: false},
									quickSuggestions: false,
									suggestOnTriggerCharacters: false,
								}}
							/>
						)}
					</section>
				</div>
			</div>

			<footer className="status-bar">
				<span className="status-message" title={status}>
					{status}
				</span>
				<span>
					Ln {cursor.line}, Col {cursor.column}
				</span>
				<span>{activeTab?.language ?? 'plaintext'}</span>
				<span>UTF-8</span>
			</footer>
		</main>
	);
}

export default App;
