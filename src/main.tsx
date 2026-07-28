import {loader} from '@monaco-editor/react';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import 'monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/csharp/csharp.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/css/css.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/go/go.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/html/html.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/java/java.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/python/python.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/rust/rust.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/shell/shell.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/sql/sql.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/xml/xml.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution.js';
import 'monaco-editor/esm/vs/language/json/monaco.contribution.js';
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

type MonacoEnvironment = {
	getWorker: (_moduleId: string, label: string) => Worker;
};

(
	self as typeof self & {MonacoEnvironment: MonacoEnvironment}
).MonacoEnvironment = {
	getWorker(_moduleId, label) {
		if (label === 'json') return new jsonWorker();
		return new editorWorker();
	},
};

// Keep Monaco fully local. The wrapper otherwise defaults to a public CDN.
loader.config({monaco});

ReactDOM.createRoot(document.querySelector('#root') as HTMLElement).render(
	<React.StrictMode>
		<App />
	</React.StrictMode>,
);
