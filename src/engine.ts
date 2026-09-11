import { badgeText, compileRules, DEFAULT_TAB_EMOJI, isSupportedUrl, MAX_RULES, readBindings, readRules, readTabEmojis, ruleName, ruleShortName, validateEmoji, validateRule, validateTabId } from './rules.js';
import type { LaneRule, PopupState, TabBinding, TabEmoji } from './types.js';
import { isMissingTabError } from './diagnostics.js';

interface Plan { rules: LaneRule[]; bindings: TabBinding[] }

/** All state transitions are serialized by the background worker. */
export class LaneEngine {
    private rules: LaneRule[] = [];
    private bindings: TabBinding[] = [];
    private tabEmojis: TabEmoji[] = [];
    // A replacement event can be the event that wakes this worker. Its old tab is
    // already absent from tabs.query(), but its binding is still needed by onReplaced.
    private replacementCandidates = new Map<number, TabBinding>();
    private replacementEmojiCandidates = new Map<number, TabEmoji>();
    private ready = false;

    constructor(private readonly api: typeof chrome) {}

    async initialize(): Promise<void> {
        if (this.ready) return;
        await this.api.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
        const [local, session, tabs] = await Promise.all([
            this.api.storage.local.get('rules'),
            this.api.storage.session.get(['bindings', 'pending', 'tabEmojis']),
            this.api.tabs.query({}),
        ]);
        // A journal lets a fresh worker finish a transition interrupted between DNR and storage writes.
        const pending = session.pending as Plan | undefined;
        const rules = readRules(pending ? pending.rules : local.rules);
        const tabIds = new Set(tabs.map(tab => tab.id));
        const ruleIds = new Set(rules.filter(rule => rule.headers.every(header => header.value.trim())).map(rule => rule.id));
        const savedBindings = readBindings(pending ? pending.bindings : session.bindings);
        const savedEmojis = readTabEmojis(session.tabEmojis);
        this.replacementCandidates = new Map(savedBindings
            .filter(binding => !tabIds.has(binding.tabId) && ruleIds.has(binding.ruleId))
            .map(binding => [binding.tabId, binding]));
        const bindings = savedBindings.filter(binding => tabIds.has(binding.tabId) && ruleIds.has(binding.ruleId));
        this.replacementEmojiCandidates = new Map(savedEmojis
            .filter(preference => !tabIds.has(preference.tabId))
            .map(preference => [preference.tabId, preference]));
        const tabEmojis = savedEmojis.filter(preference => tabIds.has(preference.tabId));
        await this.replaceNetworkRules(rules, bindings);
        if (pending) await this.api.storage.local.set({ rules });
        await this.api.storage.session.set({ bindings, tabEmojis });
        await this.api.storage.session.remove('pending');
        this.rules = rules;
        this.bindings = bindings;
        this.tabEmojis = tabEmojis;
        this.ready = true;
        await Promise.allSettled(tabs.filter(tab => tab.id !== undefined).map(tab => this.refreshIndicator(tab.id!)));
    }

    private async replaceNetworkRules(rules: LaneRule[], bindings: TabBinding[]): Promise<void> {
        const current = await this.api.declarativeNetRequest.getSessionRules();
        await this.api.declarativeNetRequest.updateSessionRules({
            removeRuleIds: current.map(rule => rule.id),
            addRules: compileRules(rules, bindings),
        });
    }

    private async commit(next: Plan): Promise<void> {
        const previous = { rules: this.rules, bindings: this.bindings };
        await this.api.storage.session.set({ pending: next });
        try {
            await this.replaceNetworkRules(next.rules, next.bindings);
        } catch (error) {
            await this.api.storage.session.remove('pending');
            throw error;
        }
        try {
            await this.api.storage.local.set({ rules: next.rules });
            await this.api.storage.session.set({ bindings: next.bindings });
            await this.api.storage.session.remove('pending');
        } catch (error) {
            // Roll back to the previous complete state if any persistence step fails.
            // Keep a recoverable journal if the browser cannot finish the rollback either.
            this.ready = false;
            await this.api.storage.session.set({ pending: previous });
            await this.replaceNetworkRules(previous.rules, previous.bindings);
            await this.api.storage.local.set({ rules: previous.rules });
            await this.api.storage.session.set({ bindings: previous.bindings });
            await this.api.storage.session.remove('pending');
            throw error;
        }
        this.rules = next.rules;
        this.bindings = next.bindings;
        const affected = new Set([...previous.bindings, ...next.bindings].map(binding => binding.tabId));
        // A restricted page may reject title injection; DNR and the toolbar badge remain independent.
        await Promise.allSettled([...affected].map(tabId => this.refreshIndicator(tabId)));
    }

    async snapshot(tabId: number): Promise<PopupState> {
        const tab = await this.api.tabs.get(validateTabId(tabId));
        const url = tab.pendingUrl || tab.url || '';
        return {
            rules: this.rules,
            bindings: this.bindings,
            activeRuleId: this.bindings.find(binding => binding.tabId === tabId)?.ruleId ?? null,
            tab: { id: tabId, title: tab.title || '', url, supported: isSupportedUrl(url), emoji: this.tabEmoji(tabId) },
        };
    }

    async saveRule(input: unknown): Promise<void> {
        const rule = validateRule(input);
        const exists = this.rules.some(item => item.id === rule.id);
        if (!exists && this.rules.length >= MAX_RULES) throw new Error(`最多保存 ${MAX_RULES} 条规则。`);
        const rules = exists
            ? this.rules.map(item => item.id === rule.id ? rule : item)
            : [...this.rules, rule];
        await this.commit({ rules, bindings: this.bindings });
    }

    async deleteRule(ruleId: string): Promise<void> {
        if (!this.rules.some(rule => rule.id === ruleId)) throw new Error('规则已不存在。');
        await this.commit({
            rules: this.rules.filter(rule => rule.id !== ruleId),
            bindings: this.bindings.filter(binding => binding.ruleId !== ruleId),
        });
    }

    async applyRule(tabId: number, ruleId: string | null): Promise<void> {
        const state = await this.snapshot(tabId);
        if (ruleId !== null && !state.tab.supported) throw new Error('请切换到普通 HTTP/HTTPS 网页后启用规则。');
        if (ruleId !== null) {
            const rule = this.rules.find(item => item.id === ruleId);
            if (!rule) throw new Error('规则已不存在。');
            validateRule(rule);
        }
        const bindings = this.bindings.filter(binding => binding.tabId !== tabId);
        if (ruleId !== null) bindings.push({ tabId, ruleId });
        await this.commit({ rules: this.rules, bindings });
    }

    private async persistEmojis(next: TabEmoji[]): Promise<void> {
        // Emoji preferences are independent of rule journals and become visible only after persistence succeeds.
        await this.api.storage.session.set({ tabEmojis: next });
        this.tabEmojis = next;
    }

    async setTabEmoji(tabId: number, value: unknown): Promise<void> {
        await this.api.tabs.get(validateTabId(tabId));
        const emoji = validateEmoji(value);
        const next = this.tabEmojis.filter(preference => preference.tabId !== tabId);
        if (emoji !== DEFAULT_TAB_EMOJI) next.push({ tabId, emoji });
        await this.persistEmojis(next);
        await Promise.allSettled([this.refreshIndicator(tabId)]);
    }

    tabEmoji(tabId: number): string {
        return this.tabEmojis.find(preference => preference.tabId === tabId)?.emoji ?? DEFAULT_TAB_EMOJI;
    }

    async removeTab(tabId: number): Promise<void> {
        this.replacementCandidates.delete(tabId);
        this.replacementEmojiCandidates.delete(tabId);
        if (this.bindings.some(binding => binding.tabId === tabId)) {
            await this.commit({ rules: this.rules, bindings: this.bindings.filter(binding => binding.tabId !== tabId) });
        }
        if (this.tabEmojis.some(preference => preference.tabId === tabId)) {
            await this.persistEmojis(this.tabEmojis.filter(preference => preference.tabId !== tabId));
        }
    }

    async replaceTab(addedTabId: number, removedTabId: number): Promise<void> {
        const candidate = this.bindings.find(binding => binding.tabId === removedTabId)
            ?? this.replacementCandidates.get(removedTabId);
        const binding = candidate && this.rules.some(rule => rule.id === candidate.ruleId) ? candidate : undefined;
        const preference = this.tabEmojis.find(item => item.tabId === removedTabId)
            ?? this.replacementEmojiCandidates.get(removedTabId);
        if (!binding && !preference) return;
        const previousEmojis = this.tabEmojis;
        const tabEmojis = this.tabEmojis.filter(item => ![addedTabId, removedTabId].includes(item.tabId));
        if (preference) tabEmojis.push({ ...preference, tabId: addedTabId });
        await this.persistEmojis(tabEmojis);
        try {
            if (binding) {
                await this.commit({ rules: this.rules, bindings: [
                    ...this.bindings.filter(item => ![addedTabId, removedTabId].includes(item.tabId)),
                    { ...binding, tabId: addedTabId },
                ] });
            } else {
                await Promise.allSettled([this.refreshIndicator(addedTabId)]);
            }
        } catch (error) {
            await this.persistEmojis(previousEmojis);
            throw error;
        }
        this.replacementCandidates.delete(removedTabId);
        this.replacementEmojiCandidates.delete(removedTabId);
    }

    indicator(tabId: number): string | null {
        const ruleId = this.bindings.find(binding => binding.tabId === tabId)?.ruleId;
        const rule = this.rules.find(rule => rule.id === ruleId);
        return rule ? ruleShortName(rule) : null;
    }

    async refreshIndicator(tabId: number): Promise<void> {
        const shortName = this.indicator(tabId);
        const ruleId = this.bindings.find(binding => binding.tabId === tabId)?.ruleId;
        const rule = this.rules.find(rule => rule.id === ruleId);
        const updates = [
            () => this.api.action.setBadgeText({ tabId, text: badgeText(shortName ?? '') }),
            () => this.api.action.setBadgeBackgroundColor({ tabId, color: '#40553f' }),
            () => this.api.action.setBadgeTextColor({ tabId, color: '#fffdf8' }),
            () => this.api.action.setTitle({ tabId, title: rule ? `${ruleShortName(rule)} · ${ruleName(rule)} — 仅当前标签页` : '有问题找kaola · 当前标签页未启用' }),
        ];
        // onUpdated may already be queued when a tab closes. Inspect every result: one
        // expected NoTab must not hide a different API failure in the same batch.
        const results = await Promise.allSettled(updates.map(async update => update()));
        for (const result of results) {
            if (result.status === 'rejected' && !isMissingTabError(result.reason, tabId)) throw result.reason;
        }
        // Its toolbar is gone; onRemoved still cleans the binding and emoji normally.
        if (results.some(result => result.status === 'rejected')) return;
        const message = { type: 'SET_TAB_INDICATOR', shortName, emoji: this.tabEmoji(tabId) };
        try {
            await this.api.tabs.sendMessage(tabId, message, { frameId: 0 });
        } catch {
            // Reinjection also clears a prior instance's title marker after extension reload.
            try {
                const tab = await this.api.tabs.get(tabId);
                if (!isSupportedUrl(tab.url || '')) return;
                await this.api.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
                await this.api.tabs.sendMessage(tabId, message, { frameId: 0 });
            } catch {
                // Chrome-protected pages cannot receive content scripts.
            }
        }
    }
}
