import { MAX_HEADERS, MAX_RULES, ruleName as displayRuleName, ruleShortName as displayRuleShortName } from './rules.js';
import { setupSketches } from './sketch.js';
import type { LaneRule, PopupState, RequestMessage, ResponseMessage } from './types.js';

function byId<T extends HTMLElement>(id: string): T {
    const element = document.getElementById(id);
    if (!element) throw new Error(`找不到界面元素：${id}`);
    return element as T;
}

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
    const element = document.createElement(tag);
    element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
}

const popup = byId('popup');
const editor = byId('editor');
const ruleList = byId('ruleList');
const newButton = byId<HTMLButtonElement>('newRule');
const clearButton = byId<HTMLButtonElement>('clearCurrent');
const retryButton = byId<HTMLButtonElement>('retry');
const tabEmojiForm = byId<HTMLFormElement>('tabEmojiForm');
const tabEmojiInput = byId<HTMLInputElement>('tabEmoji');
const saveEmojiButton = byId<HTMLButtonElement>('saveTabEmoji');
const redrawSketches = setupSketches(popup);
let state: PopupState | null = null;
let tabId: number | null = null;
let draft: LaneRule | null = null;
let baseline = '';
let busy = false;
let requestVersion = 0;
let refreshQueued = false;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
let confirmation: HTMLElement | null = null;
let formError: HTMLElement | null = null;
let draftStatus: HTMLElement | null = null;
let emojiBaseline = tabEmojiInput.value;

function dirty(): boolean {
    return draft !== null && JSON.stringify(draft) !== baseline;
}

function emojiDirty(): boolean {
    return tabEmojiInput.value !== emojiBaseline;
}

function updateEmojiControls(): void {
    restrict(tabEmojiInput, !state);
    restrict(saveEmojiButton, !state || !emojiDirty());
}

function updateEmojiValue(value: string, force = false): void {
    if ((force || !emojiDirty()) && tabEmojiInput.value !== value) tabEmojiInput.value = value;
    emojiBaseline = value;
    updateEmojiControls();
}

function restrict(control: HTMLButtonElement | HTMLInputElement, disabled: boolean): void {
    control.dataset.restricted = String(disabled);
    control.disabled = busy || disabled;
}

function setBusy(value: boolean): void {
    busy = value;
    popup.setAttribute('aria-busy', String(value));
    popup.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button, input').forEach((control) => {
        control.disabled = value || control.dataset.restricted === 'true';
    });
}

function button(text: string, className: string, action: () => void, disabled = false): HTMLButtonElement {
    const control = node('button', className, text);
    control.type = 'button';
    if (control.classList.contains('btn')) control.dataset.sketch = control.classList.contains('primary') ? 'primary' : 'box';
    if (control.classList.contains('switch')) control.dataset.sketch = 'toggle';
    restrict(control, disabled);
    control.addEventListener('click', action);
    return control;
}

function status(message: string, kind: 'info' | 'error' | 'success' = 'info', retry = false): void {
    byId('statusMessage').textContent = message;
    byId('statusBar').className = `status-bar ${kind}-status`;
    retryButton.hidden = !retry;
    redrawSketches();
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : '操作失败，请重试。';
}

async function send(message: RequestMessage): Promise<PopupState> {
    const response = await chrome.runtime.sendMessage<RequestMessage, ResponseMessage>(message);
    if (!response) throw new Error('未能连接扩展后台，请重新打开弹窗后重试。');
    if (!response.ok) throw new Error(response.error);
    return response.state;
}

function renderHeader(): void {
    if (!state) return;
    updateEmojiValue(state.tab.emoji);
    const activeRule = state.rules.find((rule) => rule.id === state?.activeRuleId);
    byId('tabTitle').textContent = state.tab.title || '未命名标签页';
    byId('tabTitle').title = state.tab.title;
    byId('tabUrl').textContent = state.tab.url || '无法读取网址';
    byId('tabUrl').title = state.tab.url;
    byId('activeStamp').classList.toggle('inactive', !activeRule || !state.tab.supported);
    byId('activeCode').textContent = activeRule ? displayRuleShortName(activeRule) : '—';
    byId('activeCode').title = activeRule ? displayRuleShortName(activeRule) : '';
    byId('activeRuleName').textContent = !state.tab.supported ? '此页面不可应用' : activeRule ? displayRuleName(activeRule) : '尚未启用';
    byId('activeRuleName').title = activeRule ? displayRuleName(activeRule) : '';
    byId('activeState').textContent = !state.tab.supported
        ? '可先编辑并保存规则'
        : activeRule ? `已启用 · ${activeRule.headers.length} 个请求头` : '使用原始请求头';
    restrict(clearButton, !state.activeRuleId);
    restrict(newButton, state.rules.length >= MAX_RULES);
    newButton.title = state.rules.length >= MAX_RULES ? `最多保存 ${MAX_RULES} 条规则` : '';
    updateEditorContext();
    redrawSketches();
}

function updateEditorContext(): void {
    if (!state) return;
    const applyButton = editor.querySelector<HTMLButtonElement>('[data-apply-current]');
    if (applyButton) restrict(applyButton, !state.tab.supported);
    const supportNote = editor.querySelector<HTMLElement>('.unsupported-note');
    if (supportNote) supportNote.hidden = state.tab.supported;
    const syncNote = editor.querySelector<HTMLElement>('.sync-note');
    if (syncNote) {
        const usageCount = state.bindings.filter((binding) => binding.ruleId === draft?.id).length;
        syncNote.textContent = `保存会同步正在使用此规则的 ${usageCount} 个标签页。`;
        syncNote.hidden = usageCount === 0;
    }
}

function renderRules(): void {
    if (!state) return;
    ruleList.replaceChildren();
    byId('ruleCount').textContent = `${state.rules.length} 条`;
    byId('listEmpty').hidden = state.rules.length > 0;
    byId('listEmpty').textContent = '还没有规则。创建一条，把常用的请求头保存在这里。';
    for (const rule of state.rules) {
        const active = state.activeRuleId === rule.id;
        const selected = draft?.id === rule.id;
        const item = node('li', `rule${active ? ' active' : ''}`);
        item.dataset.sketch = 'rule';
        const top = node('div', 'rule-top');
        const nameText = displayRuleName(rule);
        const codeText = displayRuleShortName(rule);
        const name = node('span', 'rule-name', nameText);
        name.title = nameText;
        const toggle = button('', 'switch', () => { void applyRule(active ? null : rule.id); }, !state.tab.supported && !active);
        toggle.setAttribute('role', 'switch');
        toggle.setAttribute('aria-checked', String(active));
        toggle.setAttribute('aria-label', `${active ? '停用' : '启用'}「${nameText}」`);
        const code = node('span', 'mini-code', codeText);
        code.title = codeText;
        top.append(code, name, toggle);
        const otherCount = state.bindings.filter((binding) => binding.ruleId === rule.id && binding.tabId !== tabId).length;
        const used = active ? '当前标签页使用中' : otherCount ? `另 ${otherCount} 个标签页使用中` : '未启用';
        const actions = node('div', 'rule-actions');
        actions.append(button(selected ? '正在编辑' : '编辑', `text-btn${selected ? '' : ' secondary'}`, () => {
            if (!selected) protectDraft(() => selectRule(rule.id));
        }));
        const remove = button('删除', 'text-btn danger', () => requestDeleteRule(rule.id));
        remove.setAttribute('aria-label', `删除「${nameText}」`);
        actions.append(remove);
        item.append(top, node('p', 'rule-meta', `${rule.headers.length} 个请求头 · ${used}`), actions);
        ruleList.append(item);
    }
    redrawSketches();
}

function clearConfirmation(): void {
    confirmation?.remove();
    confirmation = null;
}

function confirmInline(message: string, confirmText: string, action: () => void): void {
    clearConfirmation();
    const box = node('div', 'confirm-box');
    box.dataset.sketch = 'confirm';
    box.setAttribute('role', 'alert');
    const actions = node('div', 'confirm-actions');
    actions.append(
        button('继续编辑', 'btn', clearConfirmation),
        button(confirmText, 'btn danger', () => { clearConfirmation(); action(); }),
    );
    box.append(node('p', 'confirm-copy', message), actions);
    editor.prepend(box);
    confirmation = box;
    editor.scrollTop = 0;
    actions.querySelector('button')?.focus();
    redrawSketches();
}

function protectDraft(action: () => void): void {
    if (!dirty()) { action(); return; }
    confirmInline('当前规则有未保存的修改。放弃后将无法恢复。', '放弃修改并继续', action);
}

function requestDeleteRule(ruleId: string): void {
    const target = state?.rules.find((rule) => rule.id === ruleId);
    if (!target) {
        clearConfirmation();
        status('这条规则已被删除，请查看最新目录。');
        return;
    }
    const snapshot = JSON.stringify(target);
    const discardsDraft = draft?.id === ruleId && dirty();
    const warning = discardsDraft ? '此规则未保存的修改也会一并丢弃。' : '';
    const scope = '正在使用它的标签页也会停用此规则，删除后无法恢复。';
    confirmInline(`确定删除「${displayRuleName(target)}」？${warning}${scope}`, '确认删除', () => {
        const current = state?.rules.find((rule) => rule.id === ruleId);
        if (!current) {
            status('这条规则已被删除，请查看最新目录。');
            return;
        }
        // Keep the confirmed ID independent from the editor and require a fresh confirmation
        // if this target changed while its prompt was open.
        if (JSON.stringify(current) !== snapshot) {
            status('规则内容已更新，请重新核对并确认删除。');
            requestDeleteRule(ruleId);
            return;
        }
        void deleteRule(ruleId);
    });
}

function selectRule(id: string | null): void {
    const found = state?.rules.find((rule) => rule.id === id);
    draft = found ? structuredClone(found) : null;
    baseline = JSON.stringify(draft);
    clearConfirmation();
    renderRules();
    renderEditor();
}

function startNewRule(): void {
    draft = { id: crypto.randomUUID(), name: '', shortName: '', headers: [{ name: 'x-lane', value: '' }] };
    baseline = JSON.stringify(draft);
    clearConfirmation();
    renderRules();
    renderEditor();
    editor.querySelector<HTMLInputElement>('[name="ruleName"]')?.focus();
}

function markDirty(): void {
    if (draftStatus) {
        draftStatus.textContent = dirty() ? '未保存' : '已保存';
        if (draft && !state?.rules.some((rule) => rule.id === draft?.id) && !dirty()) draftStatus.textContent = '新草稿';
        draftStatus.classList.toggle('dirty', dirty());
    }
    if (formError) formError.textContent = '';
    clearConfirmation();
}

function field(label: string, name: string, value: string, placeholder: string, onInput: (value: string) => void): HTMLLabelElement {
    const wrapper = node('label', '', label);
    const input = node('input');
    input.name = name;
    input.value = value;
    input.placeholder = placeholder;
    input.autocomplete = 'off';
    input.spellcheck = false;
    restrict(input, false);
    input.addEventListener('input', () => { onInput(input.value); markDirty(); });
    const shell = node('span', 'input-shell');
    shell.dataset.sketch = 'input';
    shell.append(input);
    wrapper.append(shell);
    return wrapper;
}

function renderEditor(): void {
    editor.replaceChildren();
    confirmation = null;
    formError = null;
    draftStatus = null;
    editor.scrollTop = 0;
    if (!draft) {
        const empty = node('div', 'empty-editor');
        empty.append(
            node('p', 'sheet-kicker', '从一条规则开始'),
            node('h2', '', '给标签页，\n配好请求头。'),
            node('p', '', '为不同环境保存请求头。打开网页后，在左侧启用对应规则；每个标签页分别配置。'),
            button('创建第一条规则', 'btn primary', startNewRule, !state),
        );
        editor.append(empty);
        redrawSketches();
        return;
    }
    const editing = draft;
    const exists = state?.rules.some((rule) => rule.id === editing.id) ?? false;
    const form = node('form');
    form.noValidate = true;
    const heading = node('div', 'sheet-title-row');
    heading.dataset.sketch = 'heading';
    const title = node('h2', '', exists ? `编辑「${displayRuleName(editing)}」` : '新建规则');
    title.title = title.textContent || '';
    draftStatus = node('span', 'draft-state', exists ? '已保存' : '新草稿');
    heading.append(title, draftStatus);
    const grid = node('div', 'form-grid');
    grid.append(
        field('规则名称', 'ruleName', editing.name, '留空使用请求头内容', (value) => { editing.name = value; }),
        field('规则简称', 'shortName', editing.shortName, '留空使用请求头内容', (value) => { editing.shortName = value; }),
    );
    const headerBlock = node('div', 'headers-block');
    let add: HTMLButtonElement;
    const labels = node('div', 'headers-labels');
    labels.setAttribute('aria-hidden', 'true');
    labels.append(node('span', '', '请求头名称'), node('span', '', '请求头内容'), node('span'));
    const rows = node('div');
    function renderHeaderRows(): void {
        rows.replaceChildren();
        editing.headers.forEach((header, index) => {
            const row = node('div', 'header-row');
            for (const key of ['name', 'value'] as const) {
                const input = node('input');
                input.value = header[key];
                input.placeholder = key === 'name' ? '默认 x-lane' : '例如：doc-test';
                input.setAttribute('aria-label', `请求头${key === 'name' ? '名称' : '内容'} ${index + 1}`);
                if (key === 'value') {
                    input.required = true;
                    input.setAttribute('aria-required', 'true');
                }
                input.autocomplete = 'off';
                input.spellcheck = false;
                restrict(input, false);
                input.addEventListener('input', () => { header[key] = input.value; markDirty(); });
                const shell = node('span', 'input-shell');
                shell.dataset.sketch = 'input';
                shell.append(input);
                row.append(shell);
            }
            const remove = button('×', 'remove-header', () => {
                editing.headers.splice(index, 1);
                renderHeaderRows();
                restrict(add, editing.headers.length >= MAX_HEADERS);
                markDirty();
            }, editing.headers.length === 1);
            remove.setAttribute('aria-label', `删除请求头 ${index + 1}`);
            row.append(remove);
            rows.append(row);
        });
        redrawSketches();
    }
    renderHeaderRows();
    add = button('＋ 增加请求头', 'add-header', () => {
        editing.headers.push({ name: '', value: '' });
        renderHeaderRows();
        restrict(add, editing.headers.length >= MAX_HEADERS);
        markDirty();
        rows.lastElementChild?.querySelector('input')?.focus();
    }, editing.headers.length >= MAX_HEADERS);
    add.title = `每条规则最多 ${MAX_HEADERS} 个请求头`;
    formError = node('p', 'error');
    formError.setAttribute('role', 'alert');
    headerBlock.append(labels, rows, add, node('p', 'scope-note', '仅请求头内容必填；名称留空默认 x-lane，规则名称和简称留空跟随内容。'), formError);
    const footer = node('div', 'sheet-footer');
    footer.dataset.sketch = 'separator';
    const actions = node('div', 'footer-actions');
    // Submit is handled once on the form, including the Enter key.
    const submit = node('button', 'btn', '保存规则');
    submit.type = 'submit';
    submit.dataset.sketch = 'box';
    restrict(submit, false);
    const apply = button('保存并应用', 'btn primary', () => { void saveRule(true); }, !state?.tab.supported);
    apply.dataset.applyCurrent = '';
    actions.append(
        button('取消', 'btn', () => protectDraft(() => selectRule(exists ? editing.id : state?.activeRuleId || state?.rules[0]?.id || null))),
        submit,
        apply,
    );
    footer.append(actions, node('p', 'scope-note', '启用后覆盖此标签页所有请求中配置的同名请求头；其余请求头保留。新请求生效，已有页面可刷新。'));
    footer.append(node('p', 'sync-note'));
    footer.append(node('p', 'scope-note unsupported-note', '此页面无法应用请求头。请在普通 HTTP / HTTPS 网页中启用。'));
    if (exists) footer.append(button('删除此规则', 'danger-link', () => requestDeleteRule(editing.id)));
    form.append(node('p', 'sheet-kicker', exists ? '规则编辑' : '新的环境'), heading, grid, headerBlock, footer);
    form.addEventListener('submit', (event) => { event.preventDefault(); void saveRule(false); });
    editor.append(form);
    updateEditorContext();
    markDirty();
    redrawSketches();
}

function acceptState(next: PopupState): void {
    const unsaved = dirty();
    const draftId = draft?.id;
    const previouslySaved = Boolean(state?.rules.some((rule) => rule.id === draftId));
    state = next;
    renderHeader();
    renderRules();
    if (!unsaved && draft && previouslySaved) {
        const updated = next.rules.find((rule) => rule.id === draftId);
        // Binding/title updates must not replace an identical form, steal focus, or dismiss a
        // pending delete confirmation. Only changed/deleted saved content needs a new editor.
        if (!updated || JSON.stringify(updated) !== baseline) {
            selectRule(updated?.id || next.activeRuleId || next.rules[0]?.id || null);
        }
    }
    // Never replace a new or dirty draft when another tab updates storage.
}

async function mutation(action: () => Promise<void>, pending: string, reportFormError = true): Promise<void> {
    if (busy) return;
    requestVersion += 1;
    setBusy(true);
    clearConfirmation();
    status(pending);
    try {
        await action();
    } catch (error) {
        const message = errorText(error);
        status(message, 'error');
        if (reportFormError && formError) formError.textContent = message;
    } finally {
        setBusy(false);
        if (refreshQueued) { refreshQueued = false; void refresh(); }
    }
}

async function saveTabEmoji(): Promise<void> {
    if (tabId === null || busy || !state || !emojiDirty()) return;
    const currentTabId = tabId;
    const emoji = tabEmojiInput.value;
    await mutation(async () => {
        const next = await send({ type: 'SET_TAB_EMOJI', tabId: currentTabId, emoji });
        acceptState(next);
        // Normalize only after a successful save. A rejected value remains editable as typed.
        updateEmojiValue(next.tab.emoji, true);
        status('此标签页的标题表情已保存。', 'success');
    }, '正在保存此标签页的标题表情…', false);
}

async function applyRule(ruleId: string | null): Promise<void> {
    if (tabId === null) return;
    await mutation(async () => {
        acceptState(await send({ type: 'APPLY_RULE', tabId: tabId!, ruleId }));
        status(ruleId ? '已应用到此标签页。刷新页面可重新发送现有请求。' : '此标签页已停用规则。', 'success');
    }, ruleId ? '正在应用规则…' : '正在停用规则…');
}

async function saveRule(apply: boolean): Promise<void> {
    if (!draft || tabId === null || busy) return;
    const savedId = draft.id;
    const currentTabId = tabId;
    const rule = structuredClone(draft);
    await mutation(async () => {
        const next = await send({ type: 'SAVE_RULE', tabId: currentTabId, rule });
        state = next;
        selectRule(savedId);
        renderHeader();
        if (apply) {
            try {
                acceptState(await send({ type: 'APPLY_RULE', tabId: currentTabId, ruleId: savedId }));
            } catch (error) {
                throw new Error(`规则已保存，但应用失败：${errorText(error)}`);
            }
        }
        status(apply ? '规则已保存，并应用到此标签页。' : '规则已保存；使用此规则的标签页已同步更新。', 'success');
    }, apply ? '正在保存并应用…' : '正在保存规则…');
}

async function deleteRule(ruleId: string): Promise<void> {
    if (tabId === null) return;
    await mutation(async () => {
        const next = await send({ type: 'DELETE_RULE', tabId: tabId!, ruleId });
        if (draft?.id === ruleId) {
            state = next;
            selectRule(next.activeRuleId || next.rules[0]?.id || null);
            renderHeader();
        } else {
            // Deleting a directory item must preserve another rule's current editor,
            // including unsaved edits and a new draft which has no saved rule yet.
            acceptState(next);
        }
        status('规则已删除，使用此规则的标签页已停用。', 'success');
    }, '正在删除规则…');
}

async function refresh(): Promise<void> {
    if (tabId === null) return;
    if (busy) { refreshQueued = true; return; }
    const version = ++requestVersion;
    try {
        const next = await send({ type: 'GET_STATE', tabId });
        if (version !== requestVersion) return;
        acceptState(next);
    } catch (error) {
        if (version === requestVersion) status(errorText(error), 'error', true);
    }
}

function scheduleRefresh(): void {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => { void refresh(); }, 100);
}

async function initialize(): Promise<void> {
    setBusy(true);
    status('正在读取配置…');
    try {
        if (tabId === null) {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tab?.id === undefined) throw new Error('找不到当前标签页，请从普通网页重新打开扩展。');
            tabId = tab.id;
        }
        state = await send({ type: 'GET_STATE', tabId });
        renderHeader();
        selectRule(state.activeRuleId || state.rules[0]?.id || null);
        status(state.tab.supported ? '配置保存在此浏览器中。点击开关，仅影响当前标签页。' : '此页面不能应用规则，可编辑并保存后到普通网页使用。');
    } catch (error) {
        status(errorText(error), 'error', true);
        byId('tabTitle').textContent = '暂时无法读取';
        byId('listEmpty').textContent = '配置读取失败，请点击下方重试。';
        renderEditor();
        restrict(newButton, true);
        restrict(clearButton, true);
        updateEmojiControls();
    } finally {
        setBusy(false);
    }
}

newButton.addEventListener('click', () => protectDraft(startNewRule));
clearButton.addEventListener('click', () => { void applyRule(null); });
retryButton.addEventListener('click', () => { if (state) void refresh(); else void initialize(); });
tabEmojiInput.addEventListener('input', updateEmojiControls);
tabEmojiForm.addEventListener('submit', (event) => { event.preventDefault(); void saveTabEmoji(); });
updateEmojiControls();
chrome.storage.onChanged.addListener(scheduleRefresh);
chrome.tabs.onUpdated.addListener((updatedTabId) => { if (updatedTabId === tabId) scheduleRefresh(); });
void initialize();
