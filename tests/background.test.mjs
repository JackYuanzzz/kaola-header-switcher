import assert from 'node:assert/strict';
import test from 'node:test';
import { inspect } from 'node:util';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

const source = await build({
    entryPoints: ['src/background.ts'], bundle: true, write: false, format: 'iife', platform: 'browser',
});
const background = source.outputFiles[0].text;
const PRIVATE_HEADER = 'Bearer test-only-private-header';
const PRIVATE_URL = 'https://private.example/page?token=test-only-private-url';
const PRIVATE_ERROR = `Browser operation failed with ${PRIVATE_HEADER} at ${PRIVATE_URL}`;

function event() {
    const listeners = [];
    return {
        addListener(listener) { listeners.push(listener); },
        emit(...args) { return listeners.map(listener => listener(...args)); },
    };
}

function deferred() {
    let resolve;
    const promise = new Promise(complete => { resolve = complete; });
    return { promise, resolve };
}

function worker({ failures = [], bound = true } = {}) {
    const local = {
        rules: [{ id: 'doc', name: '文档联调', shortName: 'DOC', headers: [{ name: 'authorization', value: PRIVATE_HEADER }] }],
    };
    const session = {
        bindings: bound ? [{ tabId: 1, ruleId: 'doc' }] : [],
        tabEmojis: bound ? [{ tabId: 1, emoji: '🦊' }] : [],
    };
    const tabs = new Map([
        [1, { id: 1, url: PRIVATE_URL, title: 'First tab' }],
        [2, { id: 2, url: 'https://example.test/second', title: 'Second tab' }],
    ]);
    const logs = [];
    const calls = [];
    const badges = new Map();
    const faults = [...failures];
    const gates = [];
    let network = [];
    const events = {
        updated: event(), removed: event(), replaced: event(), startup: event(), installed: event(), message: event(),
    };

    async function invoke(path, args, operation) {
        calls.push({ path, args: structuredClone(args) });
        const gateIndex = gates.findIndex(gate => gate.path === path && gate.matches(args));
        if (gateIndex !== -1) {
            const [gate] = gates.splice(gateIndex, 1);
            gate.entered.resolve();
            await gate.released.promise;
        }
        const faultIndex = faults.findIndex(fault => fault.path === path && (!fault.matches || fault.matches(args)));
        if (faultIndex !== -1) {
            const [fault] = faults.splice(faultIndex, 1);
            throw new Error(fault.message ?? PRIVATE_ERROR);
        }
        return operation();
    }

    function existingTab(tabId) {
        const tab = tabs.get(tabId);
        if (!tab) throw new Error(`No tab with id: ${tabId}.`);
        return structuredClone(tab);
    }

    function storage(area, data) {
        return {
            get(keys) {
                return invoke(`storage.${area}.get`, { keys }, () => Object.fromEntries(
                    (typeof keys === 'string' ? [keys] : keys).map(key => [key, structuredClone(data[key])]),
                ));
            },
            set(values) {
                return invoke(`storage.${area}.set`, values, () => { Object.assign(data, structuredClone(values)); });
            },
            remove(key) { return invoke(`storage.${area}.remove`, { key }, () => { delete data[key]; }); },
            setAccessLevel(options) { return invoke(`storage.${area}.setAccessLevel`, options, () => undefined); },
        };
    }

    const api = {
        runtime: {
            id: 'test-extension', getURL: path => `chrome-extension://test-extension/${path}`,
            onMessage: events.message, onStartup: events.startup, onInstalled: events.installed,
        },
        storage: { local: storage('local', local), session: storage('session', session) },
        declarativeNetRequest: {
            getSessionRules: () => invoke('declarativeNetRequest.getSessionRules', {}, () => structuredClone(network)),
            updateSessionRules: options => invoke('declarativeNetRequest.updateSessionRules', options, () => {
                network = structuredClone(options.addRules);
            }),
        },
        tabs: {
            onUpdated: events.updated, onRemoved: events.removed, onReplaced: events.replaced,
            query: query => invoke('tabs.query', query, () => structuredClone([...tabs.values()])),
            get: tabId => invoke('tabs.get', { tabId }, () => existingTab(tabId)),
            sendMessage: (tabId, message) => invoke('tabs.sendMessage', { tabId, message }, () => {
                existingTab(tabId);
                return undefined;
            }),
        },
        action: Object.fromEntries(['setBadgeText', 'setBadgeBackgroundColor', 'setBadgeTextColor', 'setTitle'].map(method => [
            method,
            options => invoke(`action.${method}`, options, () => {
                existingTab(options.tabId);
                if (method === 'setBadgeText') badges.set(options.tabId, options.text);
            }),
        ])),
        scripting: { executeScript: options => invoke('scripting.executeScript', options, () => existingTab(options.target.tabId)) },
    };

    function request(message = { type: 'GET_STATE', tabId: 2 }) {
        return new Promise((resolve, reject) => {
            const handled = events.message.emit(message, {
                id: api.runtime.id, url: api.runtime.getURL('popup.html'),
            }, resolve);
            if (!handled.includes(true)) reject(new Error('Background did not handle the test request.'));
        });
    }

    runInNewContext(background, {
        chrome: api, console: { error: (...args) => logs.push(args) },
        Error, URL, Intl, Promise, structuredClone, setTimeout, clearTimeout,
    }, { filename: 'background.test.bundle.js' });

    return {
        api, tabs, session, local, logs, calls, badges, events, request,
        async flush() {
            // A management message is serialized after previously emitted events: no arbitrary sleeps.
            const response = await request();
            assert.equal(response.ok, true, response.error);
            return response.state;
        },
        failNext(path, matches, message = PRIVATE_ERROR) { faults.push({ path, matches, message }); },
        blockNext(path, matches = () => true) {
            const entered = deferred();
            const released = deferred();
            gates.push({ path, matches, entered, released });
            return { entered: entered.promise, release: released.resolve };
        },
    };
}

function assertPrivateDiagnostics(logs) {
    const rendered = inspect(logs, { depth: 20 });
    assert.ok(!rendered.includes(PRIVATE_HEADER), 'Diagnostics must not include a request-header value.');
    assert.ok(!rendered.includes(PRIVATE_URL), 'Diagnostics must not include a page URL.');
    assert.ok(!rendered.includes('test-only-private-url'), 'Diagnostics must not include a URL token.');
}

function assertDiagnostic(log, eventName, phase, code = 'UNEXPECTED') {
    assert.equal(log.length, 1, 'Diagnostics should consist of one sanitized string, not an Error or raw payload.');
    assert.equal(typeof log[0], 'string');
    assert.ok(log[0].startsWith(`有问题找kaola：状态同步失败 [${eventName}/${phase}/${code}] `), log[0]);
}

test('a completed navigation queued before tab closure is benign and later queue work continues', async () => {
    const fake = worker();
    await fake.flush();
    assert.equal(fake.logs.length, 0);
    const gate = fake.blockNext('tabs.get', args => args.tabId === 2);
    const blockedRequest = fake.request();
    await gate.entered;
    fake.events.updated.emit(1, { status: 'complete' }, fake.tabs.get(1));
    fake.tabs.delete(1);
    fake.events.removed.emit(1, { windowId: 1, isWindowClosing: false });
    gate.release();
    await blockedRequest;
    const state = await fake.flush();
    assert.deepEqual(fake.logs, [], 'A normal closed-tab race must not create a background error.');
    assert.equal(state.bindings.length, 0);
    assert.deepEqual(fake.session.tabEmojis, []);
    const response = await fake.request({ type: 'APPLY_RULE', tabId: 2, ruleId: 'doc' });
    assert.equal(response.ok, true);
    assert.equal(response.state.activeRuleId, 'doc');
    assert.equal(fake.badges.get(2), 'DOC');
});

test('toolbar failures on a live tab remain diagnosable without leaking private values', async () => {
    const fake = worker();
    await fake.flush();
    fake.failNext('action.setBadgeText', args => args.tabId === 1);
    fake.events.updated.emit(1, { status: 'complete' }, fake.tabs.get(1));
    await fake.flush();
    assert.equal(fake.logs.length, 1);
    assertDiagnostic(fake.logs[0], 'tab-loaded', 'operation');
    assertPrivateDiagnostics(fake.logs);
    fake.events.updated.emit(1, { status: 'complete' }, fake.tabs.get(1));
    await fake.flush();
    assert.equal(fake.logs.length, 1, 'A failed background job must not poison later queued work.');
    assert.equal(fake.badges.get(1), 'DOC');
});

test('another tab ID or embedded missing-tab text cannot suppress a live toolbar failure', async () => {
    const fake = worker();
    await fake.flush();
    for (const message of ['No tab with id: 999.', `No tab with id: 1. ${PRIVATE_ERROR}`]) {
        fake.failNext('action.setBadgeText', args => args.tabId === 1, message);
        fake.events.updated.emit(1, { status: 'complete' }, fake.tabs.get(1));
        await fake.flush();
    }
    assert.equal(fake.logs.length, 2, 'Missing-tab filtering must match the complete error for the actual target ID.');
    for (const log of fake.logs) {
        assert.equal(log.length, 1);
        assert.match(log[0], /\[tab-loaded\/operation\/[A-Z_]+\]/);
    }
    assertPrivateDiagnostics(fake.logs);
});

test('a missing-tab rejection from one toolbar call cannot hide another toolbar failure', async () => {
    const fake = worker({ bound: false });
    await fake.flush();
    const badgeGate = fake.blockNext('action.setBadgeText', args => args.tabId === 1);
    const titleGate = fake.blockNext('action.setTitle', args => args.tabId === 1);
    fake.failNext('action.setTitle', args => args.tabId === 1);
    fake.events.updated.emit(1, { status: 'complete' });
    await Promise.all([badgeGate.entered, titleGate.entered]);
    // The tab closes with native calls already outstanding. Release the missing-tab call
    // first: Promise.all must not let it hide the subsequent unrelated toolbar failure.
    fake.tabs.delete(1);
    badgeGate.release();
    titleGate.release();
    await fake.flush();
    assert.equal(fake.logs.length, 1);
    assertDiagnostic(fake.logs[0], 'tab-loaded', 'operation');
    assertPrivateDiagnostics(fake.logs);
});

test('tab removal persistence failures remain diagnosable and a later removal can retry', async () => {
    const fake = worker();
    await fake.flush();
    fake.tabs.delete(1);
    fake.failNext('declarativeNetRequest.updateSessionRules');
    fake.events.removed.emit(1, { windowId: 1, isWindowClosing: false });
    await fake.flush();
    assert.equal(fake.logs.length, 1);
    assertDiagnostic(fake.logs[0], 'tab-removed', 'operation');
    assertPrivateDiagnostics(fake.logs);
    fake.events.removed.emit(1, { windowId: 1, isWindowClosing: false });
    await fake.flush();
    assert.equal(fake.logs.length, 1);
    assert.deepEqual(fake.session.bindings, []);
    assert.deepEqual(fake.session.tabEmojis, []);
});

test('tab replacement failures remain diagnosable and a later replacement can retry', async () => {
    const fake = worker();
    await fake.flush();
    fake.tabs.delete(1);
    fake.tabs.set(3, { id: 3, title: 'Replacement tab', url: PRIVATE_URL });
    fake.failNext('declarativeNetRequest.updateSessionRules');
    fake.events.replaced.emit(3, 1);
    await fake.flush();
    assert.equal(fake.logs.length, 1);
    assertDiagnostic(fake.logs[0], 'tab-replaced', 'operation');
    assertPrivateDiagnostics(fake.logs);
    fake.events.replaced.emit(3, 1);
    await fake.flush();
    assert.equal(fake.logs.length, 1);
    assert.deepEqual(fake.session.bindings, [{ tabId: 3, ruleId: 'doc' }]);
    assert.deepEqual(fake.session.tabEmojis, [{ tabId: 3, emoji: '🦊' }]);
});

for (const eventName of ['startup', 'installed']) {
    test(`worker bootstrap and runtime ${eventName} failures remain diagnosable and initialization retries`, async () => {
        const failures = Array.from({ length: 2 }, () => ({ path: 'storage.local.setAccessLevel', message: PRIVATE_ERROR }));
        const fake = worker({ failures });
        fake.events[eventName].emit();
        const state = await fake.flush();
        assert.equal(fake.logs.length, 2);
        assertDiagnostic(fake.logs[0], 'worker-start', 'initialize');
        assertDiagnostic(fake.logs[1], eventName === 'startup' ? 'browser-start' : 'installed', 'initialize');
        assertPrivateDiagnostics(fake.logs);
        assert.equal(state.rules.length, 1);
        assert.equal(fake.badges.get(1), 'DOC');
    });
}
