import {memo} from 'react';

export type FileTreeNode = {
	path: string;
	name: string;
	isDirectory: boolean;
	isExpanded: boolean;
	isLoading: boolean;
	children: FileTreeNode[] | null;
};

type FileTreeProps = {
	nodes: FileTreeNode[];
	onOpenFile: (path: string) => void;
	onToggleDirectory: (path: string) => void;
	selectedPath: string | null;
};

type FileTreeItemProps = Omit<FileTreeProps, 'nodes'> & {
	node: FileTreeNode;
	depth: number;
};

const FileTreeItem = memo(function FileTreeItem({
	node,
	depth,
	onOpenFile,
	onToggleDirectory,
	selectedPath,
}: FileTreeItemProps) {
	const isSelected = node.isDirectory ? false : node.path === selectedPath;

	const handleClick = () => {
		if (node.isDirectory) {
			onToggleDirectory(node.path);
		} else {
			onOpenFile(node.path);
		}
	};

	return (
		<div
			role="treeitem"
			aria-expanded={node.isDirectory ? node.isExpanded : undefined}
			aria-selected={node.isDirectory ? undefined : isSelected}
		>
			<button
				className={`file-tree-item${isSelected ? ' selected' : ''}`}
				type="button"
				onClick={handleClick}
				title={node.path}
				style={{paddingLeft: 10 + depth * 14}}
			>
				<span className="file-tree-chevron" aria-hidden="true">
					{node.isDirectory
						? node.isLoading
							? '···'
							: node.isExpanded
								? '⌄'
								: '›'
						: ''}
				</span>
				<span
					className={`file-tree-icon ${node.isDirectory ? 'directory' : 'file'}`}
					aria-hidden="true"
				/>
				<span className="file-tree-name">{node.name}</span>
			</button>

			{node.isDirectory && node.isExpanded && node.children && (
				<div role="group">
					{node.children.map(child => (
						<FileTreeItem
							key={child.path}
							node={child}
							depth={depth + 1}
							onOpenFile={onOpenFile}
							onToggleDirectory={onToggleDirectory}
							selectedPath={selectedPath}
						/>
					))}
					{node.children.length === 0 && (
						<div
							className="file-tree-empty"
							style={{paddingLeft: 38 + depth * 14}}
						>
							Empty folder
						</div>
					)}
				</div>
			)}
		</div>
	);
});

function FileTree({
	nodes,
	onOpenFile,
	onToggleDirectory,
	selectedPath,
}: FileTreeProps) {
	return (
		<div className="file-tree" role="tree" aria-label="Directory files">
			{nodes.map(node => (
				<FileTreeItem
					key={node.path}
					node={node}
					depth={0}
					onOpenFile={onOpenFile}
					onToggleDirectory={onToggleDirectory}
					selectedPath={selectedPath}
				/>
			))}
		</div>
	);
}

export default memo(FileTree);
