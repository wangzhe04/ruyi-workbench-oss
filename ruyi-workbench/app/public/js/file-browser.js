'use strict';

// EC-D 第59波：工作区文件浏览与安全预览领域。
//
// 模块持有目录懒加载、文件 @ 提及和多格式预览。Markdown 渲染、高亮、工具调用与
// 当前工作区解析由组合根注入；HTML 产物继续使用空 sandbox iframe 隔离。
import { state } from './state.js';
import { $, autoGrow, el, fileBasename, fmtBytes } from './util.js';
import { api, apiErrText as fallbackApiErrText } from './net.js';
import { t } from './i18n.js';

const IMAGE_EXTENSION = /\.(png|jpe?g|gif|bmp|webp|svg|ico|tiff?)$/i;

export function createFileBrowserDomain({
  apiErrText = fallbackApiErrText,
  currentWorkspace = () => '',
  renderMarkdown = () => '',
  highlightIn = () => {},
  runTool = async () => {},
} = {}) {
  function pathRelativeToWorkspace(fullPath) {
    const root = currentWorkspace();
    if (!root || !fullPath) return fileBasename(fullPath);
    const normalizedRoot = root.replace(/[\\/]+$/, '');
    const lowerFullPath = fullPath.toLowerCase();
    const lowerRoot = normalizedRoot.toLowerCase();
    if (lowerFullPath === lowerRoot) return '.';
    if (lowerFullPath.startsWith(lowerRoot + '\\') || lowerFullPath.startsWith(lowerRoot + '/')) {
      return fullPath.slice(normalizedRoot.length + 1).replace(/\\/g, '/');
    }
    return fileBasename(fullPath);
  }

  async function fetchDirLevel(directory) {
    const response = await api('/api/tools/file_list', {
      method: 'POST',
      body: JSON.stringify({ root: directory, recursive: false }),
    });
    const result = response && response.result;
    if (!result || !result.ok || !Array.isArray(result.files)) return [];
    const entries = result.files.map(file => ({
      path: file.path,
      type: file.type === 'directory' ? 'directory' : 'file',
      name: fileBasename(file.path),
    }));
    entries.sort((left, right) => left.type === right.type
      ? left.name.localeCompare(right.name)
      : left.type === 'directory' ? -1 : 1);
    return entries;
  }

  function fileTreeRow(entry, depth) {
    const row = el('div', 'ftree-row');
    row.style.paddingLeft = (6 + depth * 14) + 'px';
    if (entry.type === 'directory') {
      const caret = el('span', 'ftree-caret', '▸');
      const label = el('span', 'ftree-name', entry.name);
      row.append(caret, el('span', 'ftree-icon', '📁'), label);
      const childWrap = el('div', 'ftree-children hidden');
      let loaded = false;
      row.onclick = async () => {
        const open = childWrap.classList.toggle('hidden');
        caret.textContent = open ? '▸' : '▾';
        if (!open && !loaded) {
          loaded = true;
          childWrap.textContent = '';
          childWrap.appendChild(el('div', 'ftree-loading', t('file.tree.loading')));
          try {
            const children = await fetchDirLevel(entry.path);
            childWrap.textContent = '';
            if (!children.length) childWrap.appendChild(el('div', 'ftree-empty', t('file.tree.empty')));
            for (const child of children) childWrap.appendChild(fileTreeRow(child, depth + 1));
          } catch (error) {
            childWrap.textContent = '';
            childWrap.appendChild(el('div', 'ftree-empty', t('file.tree.readFailed', {
              reason: apiErrText(error),
            })));
            loaded = false;
          }
        }
      };
      const fragment = document.createDocumentFragment();
      fragment.append(row, childWrap);
      return fragment;
    }

    row.append(
      el('span', 'ftree-caret', ''),
      el('span', 'ftree-icon', IMAGE_EXTENSION.test(entry.name) ? '🖼' : '📄'),
      el('span', 'ftree-name', entry.name),
    );
    const mention = el('button', 'ftree-at', '@');
    mention.title = t('file.tree.mention.title');
    mention.onclick = event => {
      event.stopPropagation();
      mentionFile(entry.path);
    };
    row.appendChild(mention);
    row.onclick = () => previewFile(entry.path);
    return row;
  }

  async function loadFileTree() {
    const rootElement = $('fileTreeRoot');
    const tree = $('fileTree');
    if (!rootElement || !tree) return;
    const root = currentWorkspace();
    rootElement.textContent = root ? '📂 ' + fileBasename(root) : t('file.tree.rootUnset');
    rootElement.title = root || '';
    $('filePreview')?.classList.add('hidden');
    tree.textContent = '';
    if (!root) return;
    tree.appendChild(el('div', 'ftree-loading', t('file.tree.loading')));
    try {
      const entries = await fetchDirLevel(root);
      tree.textContent = '';
      if (!entries.length) {
        tree.appendChild(el('div', 'ftree-empty', t('file.tree.empty')));
        return;
      }
      for (const entry of entries) tree.appendChild(fileTreeRow(entry, 0));
    } catch (error) {
      tree.textContent = '';
      tree.appendChild(el('div', 'ftree-empty', t('file.tree.readFailed', {
        reason: apiErrText(error),
      })));
    }
  }

  function previewFile(fullPath) {
    return renderFilePreviewInto($('filePreview'), fullPath);
  }

  async function renderFilePreviewInto(box, fullPath) {
    if (!box) return;
    box.classList.remove('hidden');
    box.textContent = '';
    const head = el('div', 'file-preview-head');
    head.append(el('span', 'fp-name', fileBasename(fullPath)));
    const open = el('button', 'mini', t('file.open'));
    open.onclick = () => runTool('office_open', { path: fullPath });
    head.appendChild(open);
    box.appendChild(head);
    const body = el('div', 'fp-body-wrap');
    body.appendChild(el('div', 'fp-loading', t('file.preview.loading')));
    box.appendChild(body);
    const sessionId = state.currentSession && state.currentSession.id;
    try {
      const query = '?path=' + encodeURIComponent(fullPath)
        + (sessionId ? '&sessionId=' + encodeURIComponent(sessionId) : '');
      const result = await api('/api/file/preview' + query);
      body.textContent = '';
      if (!result || result.ok === false) {
        const reason = result && (result.errorText
          || (result.error && (result.error.message || result.error))
          || result.hint);
        body.appendChild(el('div', 'fp-placeholder', t('file.preview.failed', {
          reason: String(reason || t('common.unknown')),
        })));
        return;
      }
      if (result.truncated) {
        head.appendChild(el('span', 'fp-trunc', t('file.preview.truncated', {
          size: Math.round(1024) + 'KB',
        })));
      }
      if (result.kind === 'image') {
        const image = el('img', 'fp-image');
        image.src = result.dataUri;
        image.alt = fileBasename(fullPath);
        body.appendChild(image);
      } else if (result.kind === 'image-toobig') {
        body.appendChild(el('div', 'fp-placeholder', t('file.preview.imageTooLarge', {
          size: fmtBytes(result.size),
        })));
      } else if (result.kind === 'html') {
        const frame = document.createElement('iframe');
        frame.className = 'fp-html-frame';
        frame.setAttribute('sandbox', '');
        frame.setAttribute('srcdoc', String(result.content || ''));
        body.appendChild(el('div', 'fp-html-note', t('file.preview.htmlIsolated')));
        body.appendChild(frame);
      } else if (result.kind === 'text') {
        renderTextPreview(body, fullPath, result.content);
      } else if (result.kind === 'binary') {
        body.appendChild(el('div', 'fp-placeholder', t('file.preview.binary', {
          format: (result.ext || '').toUpperCase() || t('common.unknown'),
        })));
      } else {
        body.appendChild(el('div', 'fp-placeholder', t('file.preview.unavailable')));
      }
    } catch (error) {
      body.textContent = '';
      body.appendChild(el('div', 'fp-placeholder', t('file.preview.failed', {
        reason: apiErrText(error),
      })));
    }
  }

  function renderTextPreview(body, fullPath, content) {
    const text = String(content || '');
    if (/\.(md|markdown)$/i.test(fullPath)) {
      const markdown = el('div', 'fp-md markdown');
      markdown.innerHTML = renderMarkdown(text);
      highlightIn(markdown);
      body.appendChild(markdown);
    } else if (/\.csv$/i.test(fullPath)) {
      body.appendChild(renderCsvTable(text));
    } else {
      body.appendChild(el('pre', 'fp-body', text));
    }
  }

  function renderCsvTable(text) {
    const wrap = el('div', 'fp-csv-wrap');
    const rows = text.replace(/\r/g, '').split('\n')
      .filter((row, index, all) => row.length || index < all.length - 1)
      .slice(0, 200);
    const table = el('table', 'fp-csv');
    rows.forEach((line, rowIndex) => {
      const row = el('tr');
      for (const cellText of line.split(',')) {
        row.appendChild(el(rowIndex === 0 ? 'th' : 'td', '', cellText));
      }
      table.appendChild(row);
    });
    wrap.appendChild(table);
    if (rows.length >= 200) wrap.appendChild(el('div', 'fp-trunc', t('chat.first200Lines')));
    return wrap;
  }

  function mentionFile(fullPath) {
    const relative = pathRelativeToWorkspace(fullPath);
    const input = $('promptInput');
    if (!input) return;
    const insert = '@' + relative + ' ';
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;
    input.value = input.value.slice(0, start) + insert + input.value.slice(end);
    const position = start + insert.length;
    input.setSelectionRange(position, position);
    input.focus();
    autoGrow(input);
    try {
      localStorage.setItem('wcw.draft', input.value);
    } catch {
      // localStorage 不可用时仍保留当前输入框内容。
    }
  }

  function bindFileBrowser() {
    const refresh = $('fileTreeRefreshBtn');
    if (refresh) refresh.onclick = loadFileTree;
  }

  return Object.freeze({
    bindFileBrowser,
    loadFileTree,
    renderFilePreviewInto,
  });
}
