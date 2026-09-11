import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

async function loadSource(entryPoint) {
    const result = await build({ entryPoints: [entryPoint], bundle: true, write: false, format: 'esm', platform: 'node' });
    return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`);
}
const { LaneEngine } = await loadSource('src/engine.ts');
const { badgeText, DEFAULT_TAB_EMOJI, validateEmoji, validateRule, readRules, ruleName, ruleShortName, isSupportedUrl, compileRules } = await loadSource('src/rules.ts');

const rule = (id = 'doc', value = 'lane-a') => ({
    id, name: '文档联调', shortName: 'DOC', headers: [{ name: 'x-lane', value }],
});

function fakeChrome() {
    const local = {};
    const session = {};
    const tabs = [{ id: 1, url: 'https://test.example/page', title: 'Test' }, { id: 2, url: 'https://test.example/page', title: 'Test' }];
    const badges = new Map();
    const hoverTitles = new Map();
    const indicatorMessages = new Map();
    let networkRules = [];
    let rejectDnr = false;
    let rejectLocal = false;
    let rejectEmojis = false;
    const storage = data => ({
        async get(keys) { return Object.fromEntries((typeof keys === 'string' ? [keys] : keys).map(key => [key, structuredClone(data[key])])); },
        async set(values) {
            if (data === local && rejectLocal) { rejectLocal = false; throw new Error('Disk full'); }
            if (data === session && rejectEmojis && Object.hasOwn(values, 'tabEmojis')) { rejectEmojis = false; throw new Error('Session storage full'); }
            Object.assign(data, structuredClone(values));
        },
        async remove(key) { delete data[key]; },
        async setAccessLevel() {},
    });
    const api = {
        storage: { local: storage(local), session: storage(session) },
        declarativeNetRequest: {
            async getSessionRules() { return structuredClone(networkRules); },
            async updateSessionRules({ addRules }) {
                if (rejectDnr) { rejectDnr = false; throw new Error('Rejected rule'); }
                networkRules = structuredClone(addRules);
            },
        },
        tabs: {
            async query() { return tabs; },
            async get(id) { const tab = tabs.find(tab => tab.id === id); if (!tab) throw new Error('Tab closed'); return tab; },
            async sendMessage(tabId, message) { indicatorMessages.set(tabId, structuredClone(message)); },
        },
        action: {
            async setBadgeText({ tabId, text }) { badges.set(tabId, text); },
            async setBadgeBackgroundColor() {},
            async setBadgeTextColor() {},
            async setTitle({ tabId, title }) { hoverTitles.set(tabId, title); },
        },
        scripting: { async executeScript() {} },
    };
    return { api, local, session, tabs, badges, hoverTitles, indicatorMessages, network: () => networkRules, rejectNextDnr: () => { rejectDnr = true; }, rejectNextLocal: () => { rejectLocal = true; }, rejectNextEmojis: () => { rejectEmojis = true; } };
}

test('validation canonicalizes header names and preserves nonempty header contents', () => {
    const parsed = validateRule({ ...rule(), headers: [{ name: ' X-Lane ', value: ' padded ' }, { name: 'x-extra', value: 'second' }] });
    assert.deepEqual(parsed.headers, [{ name: 'x-lane', value: ' padded ' }, { name: 'x-extra', value: 'second' }]);
});

test('only header content is required; blank header names default to x-lane', () => {
    const parsed = validateRule({ ...rule(), name: '', shortName: '', headers: [{ name: '   ', value: '  lane-default  ' }] });
    assert.equal(parsed.name, '');
    assert.equal(parsed.shortName, '');
    assert.deepEqual(parsed.headers, [{ name: 'x-lane', value: '  lane-default  ' }]);
    for (const value of ['', '   ', '\t ']) {
        assert.throws(() => validateRule({ ...rule(), headers: [{ name: '', value }] }), /请求头内容不能为空/);
    }
    assert.throws(() => validateRule({ ...rule(), headers: [{ name: '', value: 'a' }, { name: ' ', value: 'b' }] }), /x-lane.*重复/);
});

test('legacy empty header contents remain editable but cannot activate until repaired', async () => {
    const fake = fakeChrome();
    fake.local.rules = [{ ...rule(), headers: [{ name: 'x-lane', value: '' }] }];
    fake.session.bindings = [{ tabId: 1, ruleId: 'doc' }];
    const engine = new LaneEngine(fake.api);
    await engine.initialize();
    const state = await engine.snapshot(1);
    assert.equal(state.rules[0].headers[0].value, '');
    assert.equal(state.activeRuleId, null);
    assert.deepEqual(fake.network(), []);
    await assert.rejects(engine.applyRule(1, 'doc'), /请求头内容不能为空/);
    await engine.saveRule({ ...state.rules[0], headers: [{ name: 'x-lane', value: 'repaired-lane' }] });
    await engine.applyRule(1, 'doc');
    assert.equal((await engine.snapshot(1)).activeRuleId, 'doc');
    assert.equal(fake.network()[0].action.requestHeaders[0].value, 'repaired-lane');
    for (const headers of [
        [{ name: 'bad name', value: '' }],
        [{ name: 'x-lane', value: 'a\r\nx-admin: true' }],
        [{ name: 'x-lane', value: null }],
    ]) assert.throws(() => readRules([{ ...rule(), headers }]));
});

test('name and abbreviation independently fall back to normalized header content without changing stored fields', () => {
    const parsed = validateRule({ ...rule(), name: '', shortName: '', headers: [{ name: '', value: '  lane\t with   spaces  ' }] });
    assert.equal(ruleName(parsed), 'lane with spaces');
    assert.equal(ruleShortName(parsed), 'lane with spaces');
    assert.equal(parsed.name, '');
    assert.equal(parsed.shortName, '');
    assert.equal(parsed.headers[0].value, '  lane\t with   spaces  ');
    assert.equal(ruleName({ ...parsed, name: '自定义名称' }), '自定义名称');
    assert.equal(ruleShortName({ ...parsed, name: '自定义名称' }), 'lane with spaces');
    assert.equal(ruleName({ ...parsed, shortName: 'CUSTOM' }), 'lane with spaces');
    assert.equal(ruleShortName({ ...parsed, shortName: 'CUSTOM' }), 'CUSTOM');
    // Defensive display helpers can handle old/raw objects even though empty values cannot be saved anymore.
    const raw = { ...parsed, headers: [{ name: 'x-empty', value: ' ' }, { name: 'x-next', value: ' second-value ' }] };
    assert.equal(ruleName(raw), 'second-value');
    assert.equal(ruleShortName(raw), 'second-value');
    assert.equal(ruleName({ ...raw, headers: [] }), '未命名规则');
    assert.equal(ruleShortName({ ...raw, headers: [{ name: '', value: '' }] }), '未命名规则');
    const longValue = 'long-lane-'.repeat(20);
    const long = validateRule({ ...rule(), name: '', shortName: '', headers: [{ name: '', value: longValue }] });
    assert.equal(ruleName(long), longValue);
    assert.equal(ruleShortName(long), longValue);
});

test('derived labels automatically follow edited header content and preserve empty source labels', async () => {
    const fake = fakeChrome();
    const engine = new LaneEngine(fake.api);
    await engine.initialize();
    await engine.saveRule({ ...rule(), name: '', shortName: '', headers: [{ name: '', value: 'first-lane' }] });
    await engine.applyRule(1, 'doc');
    assert.equal(engine.indicator(1), 'first-lane');
    await engine.saveRule({ ...rule(), name: '', shortName: '', headers: [{ name: '', value: '  next\t lane   content ' }] });
    assert.equal(engine.indicator(1), 'next lane content');
    assert.equal(fake.badges.get(1), 'next');
    assert.equal(fake.hoverTitles.get(1), 'next lane content · next lane content — 仅当前标签页');
    assert.equal(fake.indicatorMessages.get(1).shortName, 'next lane content');
    assert.equal(fake.local.rules[0].name, '');
    assert.equal(fake.local.rules[0].shortName, '');
    assert.equal(fake.local.rules[0].headers[0].value, '  next\t lane   content ');
    assert.equal(fake.network()[0].action.requestHeaders[0].value, '  next\t lane   content ');
});

test('rule abbreviations have no character limit and retain their complete value', () => {
    const shortName = '文档联调规则简称'.repeat(1000);
    assert.equal(validateRule({ ...rule(), shortName }).shortName, shortName);
    assert.equal(validateRule({ ...rule(), shortName: '  LONG-RULE-NAME  ' }).shortName, 'LONG-RULE-NAME');
});

test('badges contain at most four complete grapheme clusters', () => {
    assert.equal(badgeText(''), '');
    assert.equal(badgeText('DOC'), 'DOC');
    assert.equal(badgeText('LONG-RULE-NAME'), 'LONG');
    assert.equal(badgeText('文档联调规则'), '文档联调');
    const firstFour = '👨‍👩‍👧‍👦👩🏽‍💻🇨🇳e\u0301';
    assert.equal(badgeText(`${firstFour}更多内容`), firstFour);
    assert.equal(badgeText('1️⃣2️⃣3️⃣4️⃣5️⃣'), '1️⃣2️⃣3️⃣4️⃣');
});

test('long abbreviations persist in full across workers while only badges are shortened', async () => {
    const fake = fakeChrome();
    const first = new LaneEngine(fake.api);
    const shortName = '👩🏽‍💻文档联调-完整规则简称';
    await first.initialize();
    await first.saveRule({ ...rule(), shortName });
    await first.applyRule(1, 'doc');
    const recovered = new LaneEngine(fake.api);
    await recovered.initialize();
    assert.equal(fake.local.rules[0].shortName, shortName);
    assert.equal((await recovered.snapshot(1)).rules[0].shortName, shortName);
    assert.equal(recovered.indicator(1), shortName);
    assert.equal(fake.indicatorMessages.get(1).shortName, shortName);
    assert.equal(fake.badges.get(1), '👩🏽‍💻文档联');
    assert.equal(fake.hoverTitles.get(1), `${shortName} · 文档联调 — 仅当前标签页`);
    await recovered.applyRule(1, null);
    assert.equal(fake.badges.get(1), '');
    assert.equal(fake.indicatorMessages.get(1).shortName, null);
    assert.equal(fake.hoverTitles.get(1), '有问题找kaola · 当前标签页未启用');
});

test('invalid names, injection, duplicate fields, and invalid labels are rejected', () => {
    for (const input of [
        { ...rule(), headers: [{ name: 'x lane', value: 'a' }] },
        { ...rule(), headers: [{ name: 'x-lane', value: 'a\r\nx-admin: yes' }] },
        { ...rule(), headers: [{ name: 'x-lane', value: '\0' }] },
        { ...rule(), headers: [{ name: 'x-lane', value: '中文' }] },
        { ...rule(), headers: [{ name: 'x-lane', value: 'a' }, { name: 'X-LANE', value: 'b' }] },
        { ...rule(), headers: [] }, { ...rule(), shortName: null }, { ...rule(), shortName: '[A]' },
        { ...rule(), shortName: '含 空格' }, { ...rule(), shortName: '含\n换行' }, { ...rule(), shortName: '含\0控制符' },
        { ...rule(), name: null }, { ...rule(), name: 'a'.repeat(61) }, { ...rule(), headers: [{ name: null, value: 'a' }] },
        { ...rule(), headers: Array.from({ length: 31 }, (_, i) => ({ name: `x-${i}`, value: 'a' })) },
    ]) assert.throws(() => validateRule(input));
});

test('emoji validation accepts one complete emoji grapheme and rejects text or incomplete components', () => {
    for (const value of ['🐨', '🦊', '👩🏽‍💻', '👨‍👩‍👧‍👦', '🇨🇳', '1️⃣', '#️⃣', '❤️', '🏳️‍🌈', '🏴\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}']) {
        assert.equal(validateEmoji(value), value);
    }
    assert.equal(validateEmoji(''), DEFAULT_TAB_EMOJI);
    assert.equal(validateEmoji('   '), DEFAULT_TAB_EMOJI);
    assert.equal(validateEmoji('  🦊  '), '🦊');
    for (const value of [null, 7, 'abc', '1', '😀🐨', '[😀]', '\0', '\t', '😀\n', '\u200D', '👩‍', '🇨', 'e\u0301', '🐨🏽', '👩‍A']) {
        assert.throws(() => validateEmoji(value), /emoji/);
    }
});

test('an unbound tab can set its emoji while other tabs remain default', async () => {
    const fake = fakeChrome();
    const engine = new LaneEngine(fake.api);
    await engine.initialize();
    assert.equal((await engine.snapshot(1)).tab.emoji, '🐨');
    await engine.setTabEmoji(1, '🦊');
    assert.equal((await engine.snapshot(1)).tab.emoji, '🦊');
    assert.equal((await engine.snapshot(2)).tab.emoji, '🐨');
    assert.equal((await engine.snapshot(1)).activeRuleId, null);
    assert.deepEqual(fake.session.tabEmojis, [{ tabId: 1, emoji: '🦊' }]);
    assert.deepEqual(fake.network(), []);
    assert.deepEqual(fake.indicatorMessages.get(1), { type: 'SET_TAB_INDICATOR', shortName: null, emoji: '🦊' });
});

test('tabs sharing one rule retain independent emoji choices through disabling and reapplying', async () => {
    const fake = fakeChrome();
    const engine = new LaneEngine(fake.api);
    await engine.initialize();
    await engine.saveRule(rule());
    await engine.setTabEmoji(1, '🦊');
    await engine.setTabEmoji(2, '👩🏽‍💻');
    await engine.applyRule(1, 'doc');
    await engine.applyRule(2, 'doc');
    assert.equal(fake.indicatorMessages.get(1).emoji, '🦊');
    assert.equal(fake.indicatorMessages.get(2).emoji, '👩🏽‍💻');
    assert.equal(fake.badges.get(1), 'DOC');
    assert.equal(fake.badges.get(2), 'DOC');
    await engine.applyRule(1, null);
    assert.equal((await engine.snapshot(1)).tab.emoji, '🦊');
    assert.equal(fake.indicatorMessages.get(1).shortName, null);
    await engine.applyRule(1, 'doc');
    assert.equal(fake.indicatorMessages.get(1).emoji, '🦊');
    await engine.saveRule(rule('doc', 'updated'));
    assert.equal(fake.indicatorMessages.get(2).emoji, '👩🏽‍💻');
    await engine.setTabEmoji(1, '');
    assert.equal((await engine.snapshot(1)).tab.emoji, '🐨');
    assert.deepEqual(fake.session.tabEmojis, [{ tabId: 2, emoji: '👩🏽‍💻' }]);
});

test('emoji writes become visible only after successful persistence', async () => {
    const fake = fakeChrome();
    const engine = new LaneEngine(fake.api);
    await engine.initialize();
    await engine.setTabEmoji(1, '🦊');
    fake.rejectNextEmojis();
    await assert.rejects(engine.setTabEmoji(1, '🐱'), /Session storage full/);
    assert.equal((await engine.snapshot(1)).tab.emoji, '🦊');
    assert.deepEqual(fake.session.tabEmojis, [{ tabId: 1, emoji: '🦊' }]);
    assert.equal(fake.indicatorMessages.get(1).emoji, '🦊');
});

test('emoji choices recover across worker suspension and reset with a fresh extension session', async () => {
    const fake = fakeChrome();
    const first = new LaneEngine(fake.api);
    await first.initialize();
    await first.setTabEmoji(1, '🇨🇳');
    const second = new LaneEngine(fake.api);
    await second.initialize();
    assert.equal((await second.snapshot(1)).tab.emoji, '🇨🇳');
    for (const key of Object.keys(fake.session)) delete fake.session[key];
    const restarted = new LaneEngine(fake.api);
    await restarted.initialize();
    assert.equal((await restarted.snapshot(1)).tab.emoji, '🐨');
});

test('closing an unbound tab clears its emoji and replacement migrates preferences without requiring a rule', async () => {
    const fake = fakeChrome();
    const engine = new LaneEngine(fake.api);
    await engine.initialize();
    await engine.setTabEmoji(1, '🦊');
    await engine.replaceTab(2, 1);
    assert.equal(engine.tabEmoji(1), '🐨');
    assert.equal((await engine.snapshot(2)).tab.emoji, '🦊');
    assert.deepEqual(fake.session.tabEmojis, [{ tabId: 2, emoji: '🦊' }]);
    await engine.removeTab(2);
    assert.equal(engine.tabEmoji(2), '🐨');
    assert.deepEqual(fake.session.tabEmojis, []);
});

test('a replacement waking a worker restores orphan emoji independently of binding recovery', async () => {
    const fake = fakeChrome();
    fake.session.tabEmojis = [{ tabId: 99, emoji: '👩🏽‍💻' }];
    const engine = new LaneEngine(fake.api);
    await engine.initialize();
    assert.deepEqual(fake.session.tabEmojis, []);
    await engine.replaceTab(2, 99);
    assert.equal((await engine.snapshot(2)).tab.emoji, '👩🏽‍💻');
    assert.equal((await engine.snapshot(2)).activeRuleId, null);
    assert.deepEqual(fake.session.tabEmojis, [{ tabId: 2, emoji: '👩🏽‍💻' }]);
});

test('binding journals and failed rule saves leave emoji preferences unchanged', async () => {
    const fake = fakeChrome();
    const engine = new LaneEngine(fake.api);
    await engine.initialize();
    await engine.saveRule(rule());
    await engine.applyRule(1, 'doc');
    await engine.setTabEmoji(1, '🦊');
    fake.rejectNextLocal();
    await assert.rejects(engine.saveRule(rule('doc', 'changed')), /Disk full/);
    await engine.initialize();
    assert.equal((await engine.snapshot(1)).tab.emoji, '🦊');
    fake.session.pending = { rules: [rule('doc', 'resumed')], bindings: [{ tabId: 1, ruleId: 'doc' }] };
    const recovered = new LaneEngine(fake.api);
    await recovered.initialize();
    assert.equal((await recovered.snapshot(1)).tab.emoji, '🦊');
    assert.equal(fake.network()[0].action.requestHeaders[0].value, 'resumed');
});

test('a rejected tab replacement rolls back its emoji migration along with its network binding', async () => {
    const fake = fakeChrome();
    const engine = new LaneEngine(fake.api);
    await engine.initialize();
    await engine.saveRule(rule());
    await engine.applyRule(1, 'doc');
    await engine.setTabEmoji(1, '🦊');
    fake.rejectNextDnr();
    await assert.rejects(engine.replaceTab(2, 1), /Rejected rule/);
    assert.equal((await engine.snapshot(1)).activeRuleId, 'doc');
    assert.equal((await engine.snapshot(1)).tab.emoji, '🦊');
    assert.equal((await engine.snapshot(2)).activeRuleId, null);
    assert.equal((await engine.snapshot(2)).tab.emoji, '🐨');
    assert.deepEqual(fake.session.tabEmojis, [{ tabId: 1, emoji: '🦊' }]);
});

test('session rules include navigation and never match another or background tab', () => {
    const compiled = compileRules([rule()], [{ tabId: 7, ruleId: 'doc' }]);
    assert.deepEqual(compiled[0].condition.tabIds, [7]);
    assert.ok(compiled[0].condition.resourceTypes.includes('main_frame'));
    assert.ok(compiled[0].condition.resourceTypes.includes('websocket'));
    assert.equal(compiled[0].condition.requestDomains, undefined);
    assert.equal(compiled[0].action.requestHeaders[0].operation, 'set');
});

test('unsupported browser pages and Chrome Web Store cannot be enabled', () => {
    assert.equal(isSupportedUrl('https://example.test'), true);
    for (const url of ['chrome://settings', 'about:blank', 'file:///tmp/test.html', 'https://chromewebstore.google.com/detail/test', 'https://chrome.google.com/webstore/detail/test']) {
        assert.equal(isSupportedUrl(url), false);
    }
});

test('a fresh worker recovers bindings while a fresh browser session only recovers saved rules', async () => {
    const fake = fakeChrome();
    const first = new LaneEngine(fake.api);
    await first.initialize();
    await first.saveRule(rule());
    await first.applyRule(1, 'doc');
    const second = new LaneEngine(fake.api);
    await second.initialize();
    assert.equal((await second.snapshot(1)).activeRuleId, 'doc');
    assert.equal(fake.network().length, 1);
    for (const key of Object.keys(fake.session)) delete fake.session[key];
    const restarted = new LaneEngine(fake.api);
    await restarted.initialize();
    assert.equal((await restarted.snapshot(1)).rules.length, 1);
    assert.equal((await restarted.snapshot(1)).activeRuleId, null);
    assert.equal(fake.network().length, 0);
});

test('a Chrome DNR rejection retains the last working rule and configuration', async () => {
    const fake = fakeChrome();
    const engine = new LaneEngine(fake.api);
    await engine.initialize();
    await engine.saveRule(rule());
    await engine.applyRule(1, 'doc');
    const previous = structuredClone(fake.network());
    fake.rejectNextDnr();
    await assert.rejects(engine.saveRule(rule('doc', 'bad-lane')), /Rejected rule/);
    assert.deepEqual(fake.network(), previous);
    assert.equal(fake.local.rules[0].headers[0].value, 'lane-a');
    assert.equal(fake.session.pending, undefined);
});

test('a failed storage write rolls back DNR and the saved rule together', async () => {
    const fake = fakeChrome();
    const engine = new LaneEngine(fake.api);
    await engine.initialize();
    await engine.saveRule(rule());
    await engine.applyRule(1, 'doc');
    const previous = structuredClone(fake.network());
    fake.rejectNextLocal();
    await assert.rejects(engine.saveRule(rule('doc', 'new-lane')), /Disk full/);
    assert.deepEqual(fake.network(), previous);
    assert.equal(fake.local.rules[0].headers[0].value, 'lane-a');
    assert.equal(fake.session.pending, undefined);
    await engine.initialize();
    assert.equal((await engine.snapshot(1)).rules[0].headers[0].value, 'lane-a');
});

test('interrupted storage transitions recover from the journal and prune closed tabs', async () => {
    const fake = fakeChrome();
    fake.local.rules = [rule()];
    fake.session.pending = {
        rules: [rule('doc', 'updated')],
        bindings: [{ tabId: 1, ruleId: 'doc' }, { tabId: 999, ruleId: 'doc' }],
    };
    const engine = new LaneEngine(fake.api);
    await engine.initialize();
    assert.equal(fake.local.rules[0].headers[0].value, 'updated');
    assert.deepEqual(fake.session.bindings, [{ tabId: 1, ruleId: 'doc' }]);
    assert.equal(fake.session.pending, undefined);
    assert.equal(fake.network()[0].action.requestHeaders[0].value, 'updated');
});

test('tab replacement transfers the binding; tab removal clears it', async () => {
    const fake = fakeChrome();
    const engine = new LaneEngine(fake.api);
    await engine.initialize();
    await engine.saveRule(rule());
    await engine.applyRule(1, 'doc');
    await engine.setTabEmoji(1, '🦊');
    await engine.replaceTab(2, 1);
    assert.equal((await engine.snapshot(1)).activeRuleId, null);
    assert.equal((await engine.snapshot(2)).activeRuleId, 'doc');
    assert.equal((await engine.snapshot(2)).tab.emoji, '🦊');
    assert.deepEqual(fake.network()[0].condition.tabIds, [2]);
    await engine.removeTab(2);
    assert.equal(fake.network().length, 0);
    assert.deepEqual(fake.session.tabEmojis, []);
});

test('a replacement that wakes a suspended worker recovers the old tab binding before cleanup', async () => {
    const fake = fakeChrome();
    fake.local.rules = [rule()];
    fake.session.bindings = [{ tabId: 99, ruleId: 'doc' }];
    fake.session.tabEmojis = [{ tabId: 99, emoji: '🦊' }];
    // Tab 99 has already disappeared; tab 2 replaces it before this worker starts.
    const engine = new LaneEngine(fake.api);
    await engine.initialize();
    assert.equal(fake.network().length, 0);
    await engine.replaceTab(2, 99);
    assert.equal((await engine.snapshot(2)).activeRuleId, 'doc');
    assert.equal((await engine.snapshot(2)).tab.emoji, '🦊');
    assert.deepEqual(fake.network()[0].condition.tabIds, [2]);
});
