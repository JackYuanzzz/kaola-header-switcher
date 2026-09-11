import { LaneEngine } from './engine.js';
import { validateTabId } from './rules.js';
import { describeSyncFailure } from './diagnostics.js';

const engine = new LaneEngine(chrome);
let queue: Promise<unknown> = Promise.resolve();

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = queue.then(async () => {
        await engine.initialize();
        return operation();
    });
    queue = result.catch(() => undefined);
    return result;
}

chrome.runtime.onMessage.addListener((value: unknown, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || !value || typeof value !== 'object') return false;
    const message = value as Record<string, unknown>;
    if (message.type === 'GET_TAB_INDICATOR' && sender.tab?.id !== undefined) {
        void enqueue(async () => ({ ok: true, shortName: engine.indicator(sender.tab!.id!), emoji: engine.tabEmoji(sender.tab!.id!) }))
            .then(sendResponse, () => sendResponse({ ok: false, error: '无法读取标签页状态。' }));
        return true;
    }
    // Content scripts can only read their own abbreviation, never stored header values or management APIs.
    if (!sender.url?.startsWith(chrome.runtime.getURL(''))) return false;
    void enqueue(async () => {
        const tabId = validateTabId(message.tabId);
        // Resolve the target before any writes, including save/delete requests from stale popups.
        await chrome.tabs.get(tabId);
        switch (message.type) {
            case 'GET_STATE': break;
            case 'SAVE_RULE': await engine.saveRule(message.rule); break;
            case 'SET_TAB_EMOJI': await engine.setTabEmoji(tabId, message.emoji); break;
            case 'DELETE_RULE':
                if (typeof message.ruleId !== 'string') throw new Error('规则 ID 无效。');
                await engine.deleteRule(message.ruleId);
                break;
            case 'APPLY_RULE':
                if (message.ruleId !== null && typeof message.ruleId !== 'string') throw new Error('规则 ID 无效。');
                await engine.applyRule(tabId, message.ruleId);
                break;
            default: throw new Error('未知操作，请重新打开扩展。');
        }
        return { ok: true, state: await engine.snapshot(tabId) };
    }).then(sendResponse, (error: unknown) => sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : '操作失败，请重试。',
    }));
    return true;
});

// Register synchronously so events can wake a suspended Manifest V3 worker.
chrome.tabs.onRemoved.addListener(tabId => { synchronize('tab-removed', () => engine.removeTab(tabId)); });
chrome.tabs.onReplaced.addListener((added, removed) => { synchronize('tab-replaced', () => engine.replaceTab(added, removed)); });
chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (info.status === 'complete') synchronize('tab-loaded', () => engine.refreshIndicator(tabId));
});
chrome.runtime.onStartup.addListener(() => { synchronize('browser-start', async () => undefined); });
chrome.runtime.onInstalled.addListener(() => { synchronize('installed', async () => undefined); });

type SyncEvent = 'tab-removed' | 'tab-replaced' | 'tab-loaded' | 'browser-start' | 'installed' | 'worker-start';

function synchronize(event: SyncEvent, operation: () => Promise<void>): void {
    let phase = 'initialize';
    void enqueue(async () => {
        phase = 'operation';
        await operation();
    }).catch((error: unknown) => {
        const failure = describeSyncFailure(error);
        // Fixed event/phase/reason strings explain the failure without logging rule values or URLs.
        console.error(`有问题找kaola：状态同步失败 [${event}/${phase}/${failure.code}] ${failure.detail}`);
    });
}

synchronize('worker-start', async () => undefined);
