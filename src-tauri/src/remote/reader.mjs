const state = {
  threads: [],
  papers: [],
  thread: null,
  paper: null,
  tab: 'pdf',
  search: '',
  notesDirty: false,
  openPaperIds: [],
  activeDesktopPaperId: null,
  pdfGeneration: 0,
  pdfTask: null,
  pdfViewer: null,
  pdfAbort: null
};

const $ = (id) => document.getElementById(id);
const el = (tag, className = '', text = null) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== null) node.textContent = text;
  return node;
};
const paperUrl = (id, part) => `/api/papers/${encodeURIComponent(id)}/${part}`;

async function api(path, options) {
  const response = await fetch(path, { cache: 'no-store', ...options });
  if (!response.ok) throw new Error(`Request failed (${response.status})`);
  return response.status === 204 ? null : response.json();
}

function setNavOpen(open) {
  const wasOpen = document.body.classList.contains('nav-open');
  document.body.classList.toggle('nav-open', open);
  $('sidebar').setAttribute('aria-hidden', String(!open));
  $('sidebar').inert = !open;
  $('main').inert = open;
  $('menu').setAttribute('aria-expanded', String(open));
  if (open) $('close-nav').focus();
  else if (wasOpen) $('menu').focus();
}

function section(label, count) {
  const row = el('div', 'section-label');
  row.append(el('span', '', label), el('span', '', String(count)));
  return row;
}

function navButton(label, suffix, className, onclick) {
  const button = el('button', `nav-item ${className}`);
  button.append(el('span', 'name', label));
  if (suffix) button.append(el('span', suffix.className, suffix.text));
  button.onclick = onclick;
  return button;
}

function paperNavButton(paper) {
  const open = state.openPaperIds.includes(paper.id);
  const desktopCurrent = state.activeDesktopPaperId === paper.id;
  const button = navButton(
    paper.title,
    open ? { className: 'marker', text: desktopCurrent ? 'Active' : 'Open' } : null,
    [state.paper === paper.id ? 'active' : '', open ? 'desktop-open' : '', desktopCurrent ? 'desktop-current' : ''].join(' '),
    () => selectPaper(paper.id)
  );
  button.dataset.paperId = paper.id;
  if (open) button.setAttribute('aria-label', `${paper.title}, ${desktopCurrent ? 'active' : 'open'} in desktop Re:OS`);
  return button;
}

function renderNav() {
  const nav = $('navigation');
  nav.replaceChildren();
  const open = state.openPaperIds.map(id => state.papers.find(p => p.id === id)).filter(Boolean);
  nav.append(section('Open in Re:OS', open.length));
  if (open.length) open.forEach(paper => nav.append(paperNavButton(paper)));
  else nav.append(el('p', 'nav-empty', 'Papers open in the desktop window will appear here.'));

  nav.append(section('Collection', state.papers.length));
  nav.append(navButton('All papers', { className: 'count', text: String(state.papers.length) }, !state.thread && !state.paper ? 'active' : '', () => selectThread(null)));
  nav.append(section('Threads', state.threads.length));
  for (const thread of state.threads) {
    const count = state.papers.filter(p => p.threadId === thread.id).length;
    if (thread.id === 'inbox' && !count) continue;
    nav.append(navButton(thread.id === 'inbox' ? 'Inbox' : thread.title, { className: 'count', text: String(count) }, state.thread === thread.id && !state.paper ? 'active' : '', () => selectThread(thread.id)));
  }

  const matches = state.papers.filter(p =>
    (!state.thread || state.search || p.threadId === state.thread) &&
    (!state.search || matchesSearch(p, state.search))
  );
  nav.append(section(state.search ? 'Search results' : 'Papers', matches.length));
  matches.slice(0, 120).forEach(paper => nav.append(paperNavButton(paper)));
  if (matches.length > 120) nav.append(el('p', 'nav-empty', 'Use search to narrow the paper list.'));
}

function matchesSearch(paper, query) {
  return [paper.title, paper.abstractText, paper.authors.join(' '), paper.threadId]
    .join(' ').toLowerCase().includes(query);
}

function setTop(eyebrow, title) {
  $('top-eyebrow').textContent = eyebrow;
  $('top-title').textContent = title;
}

function disposePdf() {
  state.pdfGeneration += 1;
  state.pdfAbort?.abort();
  state.pdfAbort = null;
  try { state.pdfViewer?.setDocument(null); } catch { /* already gone */ }
  state.pdfViewer = null;
  if (state.pdfTask) void state.pdfTask.destroy().catch(() => {});
  state.pdfTask = null;
}

function listView() {
  disposePdf();
  $('tabs').hidden = true;
  const content = $('content');
  content.className = 'content';
  const thread = state.threads.find(t => t.id === state.thread);
  const papers = state.papers.filter(p =>
    (!state.thread || state.search || p.threadId === state.thread) &&
    (!state.search || matchesSearch(p, state.search))
  );
  const title = state.search ? 'Search results' : thread ? (thread.id === 'inbox' ? 'Inbox' : thread.title) : 'All papers';
  setTop(state.search ? 'Library search' : 'Your library', title);
  const inner = el('div', 'inner');
  inner.append(el('div', 'hero-kicker', state.search ? 'Library search' : thread ? 'Research thread' : 'Collected research'));
  inner.append(el('h1', '', title));
  inner.append(el('p', 'description', state.search ? `${papers.length} matching paper${papers.length === 1 ? '' : 's'} across your library.` : thread?.question || 'Your research, ready to read on iPad.'));
  inner.append(el('div', 'rule'));
  if (!papers.length) inner.append(el('p', 'empty', state.search ? 'No papers match this search.' : 'No papers here yet.'));
  for (const paper of papers) {
    const row = el('button', 'paper-row');
    const copy = el('span', 'paper-copy');
    copy.append(el('span', 'paper-title', paper.title));
    copy.append(el('span', 'paper-meta', [paper.authors.slice(0, 2).join(', '), paper.publishedDate.slice(0, 4)].filter(Boolean).join(' · ')));
    row.append(copy);
    if (state.openPaperIds.includes(paper.id)) row.append(el('span', 'open-badge', 'Open on Mac'));
    row.append(el('span', 'arrow', '↗'));
    row.onclick = () => selectPaper(paper.id);
    inner.append(row);
  }
  content.replaceChildren(inner);
}

function mayLeaveNotes() { return !state.notesDirty || confirm('Discard unsaved notes?'); }

function selectThread(id) {
  if (!mayLeaveNotes()) return;
  state.notesDirty = false;
  state.paper = null;
  state.thread = id;
  state.search = '';
  $('search').value = '';
  setNavOpen(false);
  renderNav();
  listView();
}

function selectPaper(id) {
  if (!mayLeaveNotes()) return;
  const paper = state.papers.find(p => p.id === id);
  if (!paper) return;
  state.notesDirty = false;
  state.paper = id;
  state.thread = paper.threadId;
  state.tab = paper.hasPdf ? 'pdf' : paper.hasSummary ? 'summary' : 'details';
  setNavOpen(false);
  renderNav();
  paperView();
}

function pdfButton(text, title, onclick) {
  const button = el('button', 'small-btn', text);
  button.title = title;
  button.setAttribute('aria-label', title);
  button.onclick = onclick;
  return button;
}

function makePdfReader(paper, content) {
  const shell = el('div', 'pdf-shell');
  const toolbar = el('div', 'pdf-toolbar');
  const previous = pdfButton('‹', 'Previous page', () => { if (state.pdfViewer) state.pdfViewer.currentPageNumber -= 1; });
  const pageInput = el('input', 'page-input');
  pageInput.type = 'number'; pageInput.min = '1'; pageInput.value = '1'; pageInput.setAttribute('aria-label', 'Page number');
  const total = el('span', 'page-total', 'of —');
  const next = pdfButton('›', 'Next page', () => { if (state.pdfViewer) state.pdfViewer.currentPageNumber += 1; });
  const zoomOut = pdfButton('−', 'Zoom out', () => { if (state.pdfViewer) state.pdfViewer.currentScale = Math.max(.5, state.pdfViewer.currentScale / 1.2); });
  const fit = pdfButton('Fit width', 'Fit page to width', () => { if (state.pdfViewer) state.pdfViewer.currentScaleValue = 'page-width'; });
  const zoomIn = pdfButton('+', 'Zoom in', () => { if (state.pdfViewer) state.pdfViewer.currentScale = Math.min(3, state.pdfViewer.currentScale * 1.2); });
  const openOriginal = pdfButton('Open PDF', 'Open original PDF in a new tab', () => window.open(paperUrl(paper.id, 'pdf'), '_blank', 'noopener'));
  toolbar.append(previous, pageInput, total, next, el('span', 'spacer'), zoomOut, fit, zoomIn, openOriginal);
  const stage = el('div', 'pdf-stage');
  const scroll = el('div', 'pdf-scroll');
  scroll.id = 'pdf-scroll';
  const viewer = el('div', 'pdfViewer');
  scroll.append(viewer);
  const message = el('div', 'pdf-message', 'Loading PDF…');
  stage.append(scroll, message);
  shell.append(toolbar, stage);
  content.append(shell);
  pageInput.onchange = () => {
    if (!state.pdfViewer) return;
    const requested = Number.parseInt(pageInput.value, 10);
    if (Number.isFinite(requested) && requested >= 1 && requested <= state.pdfViewer.pagesCount) state.pdfViewer.currentPageNumber = requested;
    pageInput.value = String(state.pdfViewer.currentPageNumber);
  };

  const generation = state.pdfGeneration;
  void loadPdf(paper, { scroll, viewer, message, pageInput, total, previous, next }, generation);
}

async function loadPdf(paper, elements, generation) {
  const { scroll, viewer, message, pageInput, total, previous, next } = elements;
  try {
    const pdfjs = await import('/assets/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = '/assets/pdf.worker.min.mjs';
    const pdfViewerLib = await import('/assets/pdf_viewer.mjs');
    if (generation !== state.pdfGeneration) return;
    const abort = new AbortController();
    state.pdfAbort = abort;
    const eventBus = new pdfViewerLib.EventBus();
    const linkService = new pdfViewerLib.PDFLinkService({ eventBus, externalLinkTarget: pdfViewerLib.LinkTarget.BLANK });
    const pdfViewer = new pdfViewerLib.PDFViewer({
      container: scroll, viewer, eventBus, linkService,
      textLayerMode: 2, annotationMode: pdfjs.AnnotationMode.ENABLE,
      abortSignal: abort.signal
    });
    state.pdfViewer = pdfViewer;
    linkService.setViewer(pdfViewer);
    eventBus.on('pagesinit', () => {
      if (generation !== state.pdfGeneration) return;
      pdfViewer.currentScaleValue = 'page-width';
      message.hidden = true;
      total.textContent = `of ${pdfViewer.pagesCount}`;
      previous.disabled = pdfViewer.currentPageNumber <= 1;
      next.disabled = pdfViewer.currentPageNumber >= pdfViewer.pagesCount;
    });
    eventBus.on('pagechanging', ({ pageNumber }) => {
      if (generation !== state.pdfGeneration) return;
      pageInput.value = String(pageNumber);
      previous.disabled = pageNumber <= 1;
      next.disabled = pageNumber >= pdfViewer.pagesCount;
    });
    const task = pdfjs.getDocument({ url: paperUrl(paper.id, 'pdf'), withCredentials: true });
    state.pdfTask = task;
    const document = await task.promise;
    if (generation !== state.pdfGeneration) { await task.destroy(); return; }
    pdfViewer.setDocument(document);
    linkService.setDocument(document);
  } catch (error) {
    if (generation !== state.pdfGeneration) return;
    message.hidden = false;
    message.classList.add('error');
    message.textContent = `Could not open this PDF: ${error instanceof Error ? error.message : String(error)}. Try “Open PDF” above.`;
  }
}

function paperView() {
  disposePdf();
  const paper = state.papers.find(p => p.id === state.paper);
  if (!paper) return;
  setTop(state.threads.find(t => t.id === paper.threadId)?.title || 'Paper', paper.title);
  const tabs = $('tabs');
  tabs.hidden = false;
  tabs.replaceChildren();
  for (const [key, label] of [['pdf', 'PDF'], ['summary', 'Summary'], ['notes', 'Notes'], ['details', 'Details']]) {
    if (key === 'pdf' && !paper.hasPdf) continue;
    const button = el('button', `tab ${state.tab === key ? 'active' : ''}`, label);
    button.onclick = () => {
      if (!mayLeaveNotes()) return;
      state.notesDirty = false;
      state.tab = key;
      paperView();
    };
    tabs.append(button);
  }
  const content = $('content');
  content.className = `paper-body${state.tab === 'pdf' ? ' pdf' : ''}`;
  content.replaceChildren();
  if (state.tab === 'pdf') {
    makePdfReader(paper, content);
  } else if (state.tab === 'summary' || state.tab === 'notes') {
    const document = el('div', 'document');
    content.append(document);
    document.append(el('div', 'hero-kicker', state.tab === 'notes' ? 'Research notes' : 'Paper summary'));
    document.append(el('h1', '', state.tab === 'notes' ? 'Notes' : 'Summary'));
    if (state.tab === 'summary') {
      const pre = el('pre', '', 'Loading…');
      document.append(pre);
      api(paperUrl(paper.id, 'summary')).then(data => { if (pre.isConnected) pre.textContent = data.text || 'No summary yet.'; }).catch(error => { if (pre.isConnected) pre.textContent = error.message; });
    } else {
      const editor = el('textarea', 'notes-editor');
      editor.placeholder = 'Write your notes here…';
      editor.setAttribute('aria-label', 'Paper notes');
      document.append(editor);
      const line = el('div', 'save-line');
      const status = el('span', 'status', 'Loading…');
      const save = el('button', 'primary-btn', 'Save notes');
      save.disabled = true;
      line.append(status, save);
      document.append(line);
      api(paperUrl(paper.id, 'notes')).then(data => {
        if (!editor.isConnected) return;
        editor.value = data.text;
        status.textContent = 'Saved to your papers folder';
        save.disabled = false;
      }).catch(error => { if (status.isConnected) status.textContent = error.message; });
      editor.oninput = () => { state.notesDirty = true; status.textContent = 'Unsaved changes'; };
      save.onclick = async () => {
        save.disabled = true;
        status.textContent = 'Saving…';
        try {
          await api(paperUrl(paper.id, 'notes'), { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: editor.value }) });
          state.notesDirty = false;
          status.textContent = 'Saved';
        } catch (error) { status.textContent = error.message; }
        finally { save.disabled = false; }
      };
    }
  } else {
    const inner = el('div', 'inner');
    inner.append(el('div', 'hero-kicker', 'Paper details'), el('h1', '', paper.title));
    inner.append(el('p', 'description', paper.authors.join(', ') || 'Unknown authors'));
    inner.append(el('div', 'rule'), el('p', 'description', paper.abstractText || 'No abstract available.'));
    content.append(inner);
  }
}

async function refreshOpenPapers() {
  try {
    const open = await api('/api/open-papers');
    if (JSON.stringify(open.ids) === JSON.stringify(state.openPaperIds) && open.activeId === state.activeDesktopPaperId) return;
    state.openPaperIds = open.ids;
    state.activeDesktopPaperId = open.activeId;
    renderNav();
  } catch { /* The desktop may be restarting. The next poll will retry. */ }
}

async function load() {
  try {
    const data = await api('/api/library');
    state.threads = data.threads;
    state.papers = data.papers;
    if (state.paper && !state.papers.some(p => p.id === state.paper)) state.paper = null;
    await refreshOpenPapers();
    renderNav();
    state.paper ? paperView() : listView();
  } catch (error) {
    disposePdf();
    $('content').replaceChildren(el('div', 'inner', `Could not load the library: ${error.message}`));
  }
}

$('menu').onclick = () => setNavOpen(true);
$('close-nav').onclick = () => setNavOpen(false);
$('backdrop').onclick = () => setNavOpen(false);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && document.body.classList.contains('nav-open')) {
    setNavOpen(false);
  }
});
$('refresh').onclick = () => { if (mayLeaveNotes()) { state.notesDirty = false; void load(); } };
$('search').oninput = (event) => {
  if (!mayLeaveNotes()) { event.target.value = state.search; return; }
  state.notesDirty = false;
  state.search = event.target.value.trim().toLowerCase();
  state.paper = null;
  renderNav();
  listView();
};
window.onbeforeunload = () => state.notesDirty ? true : undefined;
setInterval(() => { if (!document.hidden) void refreshOpenPapers(); }, 3000);
void load();
