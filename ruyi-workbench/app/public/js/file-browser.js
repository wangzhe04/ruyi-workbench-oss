'use strict';

// EC-D 第59波：工作区文件浏览与安全预览领域。
//
// 模块持有目录懒加载、文件 @ 提及和多格式预览。Markdown 渲染、高亮、工具调用与
// 当前工作区解析由组合根注入；HTML 产物继续使用空 sandbox iframe 隔离。
import { state } from './state.js';
import { $, autoGrow, bindKeyboardClick, el, fileBasename, fmtBytes, parseCsv } from './util.js';
import { api, apiErrText as fallbackApiErrText } from './net.js';
import { t } from './i18n.js';

const IMAGE_EXTENSION = /\.(png|jpe?g|gif|bmp|webp|svg|ico|tiff?)$/i;
// 一层目录最多向服务端要多少项。file_list 非递归默认只回 500 项(按名字排序后截断),超过 500 项的目录里
// 排在后面的子文件夹会整个消失;服务端没有硬上限(只有 maxVisited 兜底),这里放宽到 5000,仍撞顶就在树里明说。
const DIR_LIST_MAX_FILES = 5000;
// CSV 预览最多画多少行。
const CSV_PREVIEW_MAX_ROWS = 200;
// 目录读不了时服务端回 {ok:true,result:{ok:false,code,error}},error 是服务端中文——不直接上屏,按 code 翻成本地化短句。
const DIR_READ_FAILURE_KEYS = Object.freeze({ not_found: 'file.tree.notFound', 'not-allowed': 'file.tree.notAllowed' });

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
      body: JSON.stringify({ root: directory, recursive: false, absolute: true, maxFiles: DIR_LIST_MAX_FILES }),   // file_list 默认只返回相对路径;树节点要绝对 path
    });
    const result = response && response.result;
    // 读不了(不存在/不在允许范围)不是「空文件夹」:抛本地化错误,走调用方已有的 file.tree.readFailed 分支。
    if (result && result.ok === false) {
      const key = DIR_READ_FAILURE_KEYS[result.code];
      throw new Error(key ? t(key) : String(result.code || t('common.unknown')));
    }
    if (!result || !result.ok || !Array.isArray(result.files)) return [];
    // 走查 U10：工作文件夹是整个用户目录时，如意自己的数据目录（.ruyi-workbench）不出现在文件树里 ——
    // 那里面是配置、线程记录，不是用户的文件（工具层对其中敏感部分本来就拒读）。3.0 改名后旧目录名是指回来的联接，一并藏。
    const key = p => String(p || '').replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
    const status = state.status || {};
    const hidden = new Set([status.dataRoot, ...(Array.isArray(status.dataRootAliases) ? status.dataRootAliases : [])].map(key).filter(Boolean));
    const entries = result.files.filter(file => !hidden.has(key(file.path))).map(file => ({
      path: file.path,
      type: file.type === 'directory' ? 'directory' : 'file',
      name: fileBasename(file.path),
    }));
    entries.sort((left, right) => left.type === right.type
      ? left.name.localeCompare(right.name)
      : left.type === 'directory' ? -1 : 1);
    entries.truncated = result.truncated === true;   // 数组上挂一个标记:调用方在末尾补一行「只列了前 N 项」
    return entries;
  }

  // 服务端 maxFiles 撞顶(truncated:true)时,在这一层末尾补一行提示——否则排在后面的项静默消失,用户以为就这么多。
  function appendTruncatedNote(container, entries) {
    if (entries && entries.truncated) {
      container.appendChild(el('div', 'ftree-empty ftree-truncated', t('file.tree.truncated', { count: DIR_LIST_MAX_FILES })));
    }
  }

  function fileTreeRow(entry, depth) {
    const row = el('div', 'ftree-row');
    row.style.paddingLeft = (6 + depth * 14) + 'px';
    if (entry.type === 'directory') {
      const caret = el('span', 'ftree-caret', '▸');
      caret.setAttribute('aria-hidden', 'true');
      const icon = el('span', 'ftree-icon', '📁');
      icon.setAttribute('aria-hidden', 'true');
      const label = el('span', 'ftree-name', entry.name);
      label.title = entry.name;   // 名字被省略号截断时悬停看全名
      row.append(caret, icon, label);
      // a11y:行本身就是展开/收起的按钮(目录行里没有别的可操作元素,不会嵌套)。
      row.setAttribute('role', 'button');
      row.tabIndex = 0;
      row.setAttribute('aria-expanded', 'false');
      bindKeyboardClick(row);
      const childWrap = el('div', 'ftree-children hidden');
      let loaded = false;
      row.onclick = async () => {
        const open = childWrap.classList.toggle('hidden');
        caret.textContent = open ? '▸' : '▾';
        row.setAttribute('aria-expanded', open ? 'false' : 'true');
        if (!open && !loaded) {
          loaded = true;
          childWrap.textContent = '';
          childWrap.appendChild(el('div', 'ftree-loading', t('file.tree.loading')));
          try {
            const children = await fetchDirLevel(entry.path);
            childWrap.textContent = '';
            if (!children.length) childWrap.appendChild(el('div', 'ftree-empty', t('file.tree.empty')));
            for (const child of children) childWrap.appendChild(fileTreeRow(child, depth + 1));
            appendTruncatedNote(childWrap, children);
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

    // 文件行里还有一枚真按钮(@ 提及),行本身不能再当 role=button(按钮里套按钮,读屏会压平):
    // 把「预览」的可聚焦部分收成行内的 .ftree-main,@ 与它并列。鼠标点行内任何位置照旧预览(row.onclick),
    // 键盘 Enter/空格在 .ftree-main 上触发它的 click,冒泡到同一个处理器。
    const main = el('div', 'ftree-main');
    main.setAttribute('role', 'button');
    main.tabIndex = 0;
    const caret = el('span', 'ftree-caret', '');
    caret.setAttribute('aria-hidden', 'true');
    const icon = el('span', 'ftree-icon', IMAGE_EXTENSION.test(entry.name) ? '🖼' : '📄');
    icon.setAttribute('aria-hidden', 'true');
    const label = el('span', 'ftree-name', entry.name);
    label.title = entry.name;   // 名字被省略号截断时悬停看全名
    main.append(caret, icon, label);
    bindKeyboardClick(main);
    const mention = el('button', 'ftree-at', '@');
    mention.title = t('file.tree.mention.title');
    mention.setAttribute('aria-label', t('file.tree.mention.title'));
    mention.onclick = event => {
      event.stopPropagation();
      mentionFile(entry.path);
    };
    row.append(main, mention);
    row.onclick = () => previewFile(entry.path);
    return row;
  }

  // 目录树加载序号:切工作区时前一次(可能更慢)的读盘结果晚到,不能盖掉新工作区的树。
  let fileTreeLoadSeq = 0;
  async function loadFileTree() {
    const loadSeq = ++fileTreeLoadSeq;
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
      if (loadSeq !== fileTreeLoadSeq) return; // 已有更新的一次加载,丢弃过期结果
      tree.textContent = '';
      if (!entries.length) {
        tree.appendChild(el('div', 'ftree-empty', t('file.tree.empty')));
        return;
      }
      for (const entry of entries) tree.appendChild(fileTreeRow(entry, 0));
      appendTruncatedNote(tree, entries);
    } catch (error) {
      if (loadSeq !== fileTreeLoadSeq) return;
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
    // 按引号切分(带引号的字段里的逗号/换行不拆)、剥 BOM;「只显示前 200 行」只在真的还有更多行时才提示。
    const { rows, truncated } = parseCsv(text, CSV_PREVIEW_MAX_ROWS);
    const table = el('table', 'fp-csv');
    rows.forEach((cells, rowIndex) => {
      const row = el('tr');
      for (const cellText of cells) {
        row.appendChild(el(rowIndex === 0 ? 'th' : 'td', '', cellText));
      }
      table.appendChild(row);
    });
    wrap.appendChild(table);
    if (truncated) wrap.appendChild(el('div', 'fp-trunc', t('chat.first200Lines')));
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
