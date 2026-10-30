import { DEFAULT_TAB_EMOJI, validateEmoji } from './rules.js';

// Bundled as an IIFE. Session storage survives extension reloads without changing SSR markup.
interface LaneTitleController { update(shortName: string | null, emoji: string): void; dispose(): void }
interface TitleMarker { owner: string; base: string; rendered: string }
const context = window as Window & { __laneHeaderSwitcherTitle?: LaneTitleController };
const markerKey = '__lane_header_switcher_title__';
const legacyMarkerAttribute = 'data-lane-header-switcher-title';

function parseMarker(raw: string | null): TitleMarker | null {
    try {
        const value: unknown = JSON.parse(raw || 'null');
        if (!value || typeof value !== 'object') return null;
        const marker = value as Record<string, unknown>;
        return typeof marker.owner === 'string' && typeof marker.base === 'string' && typeof marker.rendered === 'string'
            ? marker as unknown as TitleMarker : null;
    } catch { return null; }
}

function readMarker(): TitleMarker | null {
    try { return parseMarker(sessionStorage.getItem(markerKey)); }
    catch { return null; }
}

// Retire any previous instance when Chrome reinjects into an already-open document.
context.__laneHeaderSwitcherTitle?.dispose();
// Older versions stored the marker on <html>; remove it before React hydrates.
const legacy = parseMarker(document.documentElement?.getAttribute(legacyMarkerAttribute) ?? null);
const stale = readMarker() ?? legacy;
if (stale && document.title === stale.rendered) document.title = stale.base;
document.documentElement?.removeAttribute(legacyMarkerAttribute);
try { sessionStorage.removeItem(markerKey); } catch { /* Storage can be unavailable. */ }

{
    const owner = crypto.randomUUID();
    let prefix = '';
    let baseTitle = document.title;
    let renderedTitle = document.title;
    let revision = 0;
    let invalidationTimer: ReturnType<typeof setInterval> | undefined;
    const contextValid = () => {
        try { return Boolean(chrome.runtime?.id); } catch { return false; }
    };
    const remember = () => {
        try { sessionStorage.setItem(markerKey, JSON.stringify({ owner, base: baseTitle, rendered: renderedTitle })); }
        catch { /* Keep the title indicator working when storage is unavailable. */ }
    };
    const restore = () => {
        observer.disconnect();
        clearInterval(invalidationTimer);
        invalidationTimer = undefined;
        const marker = readMarker();
        if (marker?.owner === owner || !marker) {
            if (document.title === renderedTitle) document.title = baseTitle;
            try { sessionStorage.removeItem(markerKey); } catch { /* Storage can be unavailable. */ }
        }
        prefix = '';
        renderedTitle = document.title;
    };
    const render = () => {
        if (!contextValid()) { controller.dispose(); return; }
        if (!prefix) return;
        if (document.title !== renderedTitle) baseTitle = document.title;
        const title = `${prefix}${baseTitle}`;
        if (document.title !== title) document.title = title;
        renderedTitle = title;
        remember();
    };
    const observer = new MutationObserver(() => render());
    const controller: LaneTitleController = {
        update(shortName, emoji) {
            revision += 1;
            if (document.title !== renderedTitle) baseTitle = document.title;
            observer.disconnect();
            if (!shortName) {
                restore();
                return;
            }
            prefix = `${emoji}[${shortName}] `;
            renderedTitle = `${prefix}${baseTitle}`;
            document.title = renderedTitle;
            remember();
            observer.observe(document, { subtree: true, childList: true, characterData: true });
            // Chrome has no content-script unload event. Only bound tabs check context validity;
            // this local check sends no messages and also restores titles after disable/uninstall.
            if (invalidationTimer === undefined) invalidationTimer = setInterval(() => {
                if (!contextValid()) controller.dispose();
            }, 1000);
        },
        dispose() {
            revision += 1;
            restore();
            try { chrome.runtime.onMessage.removeListener(onMessage); } catch { /* Invalidated context. */ }
            if (context.__laneHeaderSwitcherTitle === controller) delete context.__laneHeaderSwitcherTitle;
        },
    };
    context.__laneHeaderSwitcherTitle = controller;
    const onMessage = (message: unknown, sender: chrome.runtime.MessageSender, respond: (response: unknown) => void) => {
        if (sender.id !== chrome.runtime.id || !message || typeof message !== 'object') return false;
        const input = message as Record<string, unknown>;
        if (input.type !== 'SET_TAB_INDICATOR') return false;
        if (input.shortName !== null && typeof input.shortName !== 'string') return false;
        let emoji: string;
        try { emoji = validateEmoji(input.emoji ?? DEFAULT_TAB_EMOJI); } catch { return false; }
        controller.update(input.shortName, emoji);
        respond({ ok: true });
        return false;
    };
    chrome.runtime.onMessage.addListener(onMessage);
    void chrome.runtime.sendMessage({ type: 'GET_TAB_INDICATOR' }).then((response: { ok?: boolean; shortName?: string | null; emoji?: string }) => {
        // Do not overwrite a newer push from the background with an earlier read.
        if (revision === 0 && response?.ok && (response.shortName === null || typeof response.shortName === 'string')) {
            controller.update(response.shortName, validateEmoji(response.emoji ?? DEFAULT_TAB_EMOJI));
        }
    }).catch(() => undefined);
}
