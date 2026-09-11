function messageOf(error: unknown): string {
    if (typeof error === 'string') return error;
    if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') return error.message;
    return '';
}

/** Ignore only Chrome's missing-tab error for the exact tab being painted. */
export function isMissingTabError(error: unknown, tabId: number): boolean {
    const message = messageOf(error);
    return message === `No tab with id: ${tabId}.` || message === `No tab with id: ${tabId}`;
}

/** Native errors may echo header contents. Report fixed categories, never raw messages. */
export function describeSyncFailure(error: unknown): { code: string; detail: string } {
    const message = messageOf(error);
    if (/quota|MAX_WRITE_OPERATIONS|storage.*full/i.test(message)) {
        return { code: 'STORAGE_LIMIT', detail: '浏览器存储达到限制，请检查可用空间或减少规则数量。' };
    }
    if (/MAX_NUMBER_OF|rule.*limit|too many.*rules/i.test(message)) {
        return { code: 'RULE_LIMIT', detail: '浏览器请求规则达到数量限制，请减少同时启用的标签页。' };
    }
    if (/declarativeNetRequest|DNR|Invalid rule|Rule with id/i.test(message)) {
        return { code: 'NETWORK_RULES', detail: '浏览器拒绝了请求规则，请检查配置并重试。' };
    }
    if (/表情|emoji/.test(message)) {
        return { code: 'EMOJI_DATA', detail: '已保存的标签页表情无法读取，请重新加载扩展。' };
    }
    if (/绑定|标签页.*重复/.test(message)) {
        return { code: 'BINDING_DATA', detail: '标签页绑定数据无法读取，请重新加载扩展。' };
    }
    if (/规则|请求头|简称/.test(message)) {
        return { code: 'RULE_DATA', detail: '已保存的规则无法读取，请检查配置；不要直接清空本地数据。' };
    }
    if (/is not a function|not supported|not available/i.test(message)) {
        return { code: 'BROWSER_API', detail: '浏览器接口不可用，请检查浏览器版本与扩展权限。' };
    }
    return { code: 'UNEXPECTED', detail: '后台操作未完成，可重新打开扩展重试；若反复出现，请提供此错误代码。' };
}
