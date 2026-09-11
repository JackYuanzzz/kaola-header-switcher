import type { LaneRule, TabBinding, TabEmoji } from './types.js';

export const MAX_RULES = 100;
export const MAX_HEADERS = 30;
export const DEFAULT_TAB_EMOJI = '🐨';
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9a-z-]+$/i;
const badgeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
// Unicode emoji core/ZWJ/tag sequences; property escapes remain compatible with Chrome 110.
const EMOJI_CORE = '(?:\\p{Emoji_Modifier_Base}\\uFE0F?\\p{Emoji_Modifier}|(?=\\p{Emoji})\\p{Extended_Pictographic}\\uFE0F?)';
const EMOJI_SEQUENCE = new RegExp(
    `^(?:\\p{Regional_Indicator}{2}|[#*0-9]\\uFE0F?\\u20E3|\\u{1F3F4}[\\u{E0020}-\\u{E007E}]+\\u{E007F}|${EMOJI_CORE}(?:\\u200D${EMOJI_CORE})*)$`,
    'u',
);

export function validateEmoji(value: unknown): string {
    if (typeof value !== 'string' || /[\x00-\x1f\x7f]/.test(value)) throw new Error('标题表情需要填写一个完整的 emoji。');
    const emoji = value.trim();
    if (!emoji) return DEFAULT_TAB_EMOJI;
    const segments = badgeSegmenter.segment(emoji)[Symbol.iterator]();
    if (!segments.next().done && segments.next().done && EMOJI_SEQUENCE.test(emoji)) return emoji;
    throw new Error('标题表情需要填写一个完整的 emoji，不能包含文字、方括号或多个表情。');
}

function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('规则格式无效。');
    }
    return value as Record<string, unknown>;
}

function textField(value: unknown, label: string, max?: number): string {
    if (typeof value !== 'string' || !value.trim() || (max !== undefined && Array.from(value.trim()).length > max)) {
        throw new Error(max === undefined ? `${label}不能为空。` : `${label}需要填写 1–${max} 个字符。`);
    }
    if (/[\x00-\x1f\x7f]/.test(value)) throw new Error(`${label}不能包含控制字符。`);
    return value.trim();
}

function optionalTextField(value: unknown, label: string, max?: number): string {
    if (typeof value !== 'string') throw new Error(`${label}格式无效。`);
    if (/[\x00-\x1f\x7f]/.test(value)) throw new Error(`${label}不能包含控制字符。`);
    return value.trim() ? textField(value, label, max) : '';
}

function parseRule(value: unknown, allowEmptyContent: boolean): LaneRule {
    const input = record(value);
    const id = textField(input.id, '规则 ID', 80);
    const name = optionalTextField(input.name, '规则名称', 60);
    const shortName = optionalTextField(input.shortName, '规则简称');
    if (/\s|\[|\]/.test(shortName)) throw new Error('规则简称不能包含空格或方括号。');
    if (!Array.isArray(input.headers) || !input.headers.length || input.headers.length > MAX_HEADERS) {
        throw new Error(`每条规则需要 1–${MAX_HEADERS} 个请求头。`);
    }
    const seen = new Set<string>();
    const headers = input.headers.map((value: unknown, index: number) => {
        const item = record(value);
        if (typeof item.name !== 'string') throw new Error(`第 ${index + 1} 个请求头名称格式无效。`);
        const name = textField(item.name.trim() || 'x-lane', `第 ${index + 1} 个请求头名称`, 128).toLowerCase();
        if (!HEADER_NAME.test(name)) throw new Error(`请求头名称「${name}」不是有效的 HTTP 字段名。`);
        if (seen.has(name)) throw new Error(`请求头「${name}」重复，名称不区分大小写。`);
        seen.add(name);
        // Header values are preserved exactly. Reject injection and unsupported Unicode before DNR.
        if (typeof item.value !== 'string' || (!allowEmptyContent && !item.value.trim())) throw new Error('请求头内容不能为空。');
        if (item.value.length > 8192 || /[^\t\x20-\x7e\x80-\xff]/.test(item.value)) {
            throw new Error(`请求头「${name}」内容无效：不能有换行或中文等非 Latin-1 字符，最多 8192 字符。`);
        }
        return { name, value: item.value };
    });
    return { id, name, shortName, headers };
}

export function validateRule(value: unknown): LaneRule {
    return parseRule(value, false);
}

function displayLabel(value: string): string {
    // document.title normalizes ASCII whitespace. Match it so the title observer does not grow prefixes forever.
    return value.replace(/[\x09-\x0d\x20]+/g, ' ').trim();
}

function headerLabel(rule: LaneRule): string {
    return displayLabel(rule.headers.find(header => header.value.trim())?.value || '') || '未命名规则';
}

export function ruleName(rule: LaneRule): string {
    return displayLabel(rule.name) || headerLabel(rule);
}

export function ruleShortName(rule: LaneRule): string {
    return displayLabel(rule.shortName) || headerLabel(rule);
}

/** Chrome 角标只显示前四个字素，避免截断组合 emoji；存储与标题仍使用完整简称。 */
export function badgeText(shortName: string): string {
    let result = '';
    let length = 0;
    for (const { segment } of badgeSegmenter.segment(shortName)) {
        if (length === 4) break;
        result += segment;
        length += 1;
    }
    return result;
}

export function readRules(value: unknown): LaneRule[] {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > MAX_RULES) throw new Error('本地规则数据格式无效。');
    // Older releases allowed empty contents. Keep these rules editable, but never activate them until repaired.
    const rules = value.map(item => parseRule(item, true));
    if (new Set(rules.map(rule => rule.id)).size !== rules.length) throw new Error('本地规则 ID 重复。');
    return rules;
}

export function readBindings(value: unknown): TabBinding[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new Error('标签页绑定数据格式无效。');
    const seen = new Set<number>();
    return value.map(item => {
        const entry = record(item);
        const tabId = validateTabId(entry.tabId);
        if (seen.has(tabId)) throw new Error('同一标签页存在重复绑定。');
        seen.add(tabId);
        return { tabId, ruleId: textField(entry.ruleId, '规则 ID', 80) };
    });
}

export function readTabEmojis(value: unknown): TabEmoji[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new Error('标签页表情数据格式无效。');
    const seen = new Set<number>();
    return value.map(item => {
        const entry = record(item);
        const tabId = validateTabId(entry.tabId);
        if (seen.has(tabId)) throw new Error('同一标签页存在重复表情设置。');
        seen.add(tabId);
        return { tabId, emoji: validateEmoji(entry.emoji) };
    });
}

export function validateTabId(value: unknown): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw new Error('当前标签页不可用，请重新打开扩展。');
    }
    return value;
}

export function isSupportedUrl(value: string): boolean {
    try {
        const url = new URL(value);
        return ['http:', 'https:'].includes(url.protocol)
            && url.hostname !== 'chromewebstore.google.com'
            && !(url.hostname === 'chrome.google.com' && url.pathname.startsWith('/webstore'));
    } catch {
        return false;
    }
}

export function compileRules(rules: LaneRule[], bindings: TabBinding[]): chrome.declarativeNetRequest.Rule[] {
    return bindings.map((binding, index) => {
        const rule = rules.find(rule => rule.id === binding.ruleId);
        if (!rule) throw new Error('所选规则已删除，请重新选择。');
        return {
            id: index + 1,
            priority: 1,
            action: {
                type: 'modifyHeaders' as chrome.declarativeNetRequest.RuleActionType,
                requestHeaders: rule.headers.map(header => ({
                    header: header.name,
                    operation: 'set' as chrome.declarativeNetRequest.HeaderOperation,
                    value: header.value,
                })),
            },
            condition: {
                tabIds: [binding.tabId],
                // Explicit main_frame is essential; omitting resource types excludes it.
                resourceTypes: [
                    'main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object',
                    'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket', 'webtransport',
                    'webbundle', 'other',
                ] as chrome.declarativeNetRequest.ResourceType[],
            },
        };
    });
}
