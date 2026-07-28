import {useEffect, useMemo, useRef, useState} from 'react';

export type RecentFile = {
	path: string;
	name: string;
};

type QuickOpenProps = {
	isOpen: boolean;
	recentFiles: RecentFile[];
	onClose: () => void;
	onSelect: (path: string) => void;
};

function QuickOpen({isOpen, recentFiles, onClose, onSelect}: QuickOpenProps) {
	const [query, setQuery] = useState('');
	const [selectedIndex, setSelectedIndex] = useState(0);
	const inputRef = useRef<HTMLInputElement | null>(null);

	const filteredFiles = useMemo(() => {
		const normalizedQuery = query.trim().toLowerCase();
		if (!normalizedQuery) return recentFiles;
		return recentFiles.filter(
			file =>
				file.name.toLowerCase().includes(normalizedQuery) ||
				file.path.toLowerCase().includes(normalizedQuery),
		);
	}, [query, recentFiles]);

	useEffect(() => {
		if (!isOpen) return;
		setQuery('');
		setSelectedIndex(0);
		inputRef.current?.focus();
	}, [isOpen]);

	useEffect(() => {
		setSelectedIndex(0);
	}, [query]);

	if (!isOpen) return null;

	const selectFile = (path: string) => {
		onSelect(path);
		onClose();
	};

	return (
		<div className="quick-open-backdrop" onPointerDown={onClose}>
			<section
				className="quick-open"
				role="dialog"
				aria-modal="true"
				aria-label="Open recent file"
				onPointerDown={event => event.stopPropagation()}
			>
				<input
					ref={inputRef}
					type="text"
					value={query}
					placeholder="Search recently opened files"
					aria-label="Search recently opened files"
					onChange={event => setQuery(event.currentTarget.value)}
					onKeyDown={event => {
						switch (event.key) {
							case 'Escape': {
								event.preventDefault();
								onClose();

								break;
							}
							case 'ArrowDown': {
								event.preventDefault();
								if (filteredFiles.length > 0) {
									setSelectedIndex(index =>
										Math.min(index + 1, filteredFiles.length - 1),
									);
								}

								break;
							}
							case 'ArrowUp': {
								event.preventDefault();
								setSelectedIndex(index => Math.max(index - 1, 0));

								break;
							}
							case 'Enter': {
								event.preventDefault();
								const selectedFile = filteredFiles[selectedIndex];
								if (selectedFile) selectFile(selectedFile.path);

								break;
							}
						}
					}}
				/>

				<div className="quick-open-results" role="listbox">
					{filteredFiles.map((file, index) => (
						<button
							key={file.path}
							className={index === selectedIndex ? 'selected' : ''}
							type="button"
							role="option"
							aria-selected={index === selectedIndex}
							onMouseEnter={() => setSelectedIndex(index)}
							onClick={() => selectFile(file.path)}
						>
							<span>{file.name}</span>
							<small>{file.path}</small>
						</button>
					))}
					{filteredFiles.length === 0 && (
						<div className="quick-open-empty">
							{recentFiles.length === 0
								? 'No recently opened files'
								: 'No matching files'}
						</div>
					)}
				</div>
			</section>
		</div>
	);
}

export default QuickOpen;
