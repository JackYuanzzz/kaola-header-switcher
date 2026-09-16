import { chromium, expect, test as base, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { createServer, type IncomingHttpHeaders, type RequestListener, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LaneRule, PopupState, RequestMessage, ResponseMessage } from '../src/types';

interface RecordedRequest {
    path: string;
    headers: IncomingHttpHeaders;
}

interface EchoServer {
    origin: string;
    crossOrigin: string;
    requests: RecordedRequest[];
}

interface Extension {
    context: BrowserContext;
    worker: Worker;
    control: Page;
    url: string;
    send(message: RequestMessage): Promise<ResponseMessage>;
    state(tabId: number): Promise<PopupState>;
    tabId(page: Page): Promise<number>;
}

interface ClosedTabAudit {
    entered: boolean;
    settled: boolean;
    nativeErrors: string[];
    release?: () => void;
    originalBadge: typeof chrome.action.setBadgeText;
}

const test = base.extend<{ extension: Extension; echo: EchoServer }>({
    echo: async ({}, use) => {
        const requests: RecordedRequest[] = [];
        const handler: RequestListener = (request, response) => {
            const path = request.url ?? '/';
            requests.push({ path, headers: request.headers });
            response.setHeader('Cache-Control', 'no-store');
            response.setHeader('Access-Control-Allow-Origin', '*');
            response.setHeader('Access-Control-Allow-Headers', request.headers['access-control-request-headers'] ?? '*');
            if (request.method === 'OPTIONS') {
                response.statusCode = 204;
                response.end();
            } else if (path.startsWith('/echo')) {
                response.setHeader('Content-Type', 'application/json');
                response.end(JSON.stringify(request.headers));
            } else if (path.startsWith('/asset.svg')) {
                response.setHeader('Content-Type', 'image/svg+xml');
                response.end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1"/></svg>');
            } else if (path.startsWith('/frame')) {
                response.setHeader('Content-Type', 'text/html; charset=utf-8');
                response.end('<!doctype html><title>Frame</title><p>Frame request</p>');
            } else {
                response.setHeader('Content-Type', 'text/html; charset=utf-8');
                response.end('<!doctype html><html><head><title>Lane test</title></head><body><h1>Lane test page</h1><img alt="Network fixture" src="/asset.svg"><iframe src="/frame"></iframe></body></html>');
            }
        };
        const servers: Server[] = [createServer(handler), createServer(handler)];
        const origins = await Promise.all(servers.map(async (server) => {
            await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
            const address = server.address();
            if (!address || typeof address === 'string') throw new Error('Local test server did not receive a port.');
            return `http://127.0.0.1:${address.port}`;
        }));
        try {
            await use({ origin: origins[0]!, crossOrigin: origins[1]!, requests });
        } finally {
            await Promise.all(servers.map(async (server) => {
                server.closeAllConnections();
                await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
            }));
        }
    },
    extension: async ({}, use, testInfo) => {
        const extensionPath = fileURLToPath(new URL('../dist/', import.meta.url));
        const profile = await mkdtemp(join(tmpdir(), 'lane-header-e2e-'));
        let context: BrowserContext | undefined;
        try {
            context = await chromium.launchPersistentContext(profile, {
                channel: 'chromium',
                headless: true,
                viewport: { width: 720, height: 600 },
                args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
            });
            const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
            const extensionId = new URL(worker.url()).host;
            const url = `chrome-extension://${extensionId}/popup.html`;
            const control = await context.newPage();
            await control.goto(url);
            const send = (message: RequestMessage) => control.evaluate(async (request) =>
                await chrome.runtime.sendMessage(request) as ResponseMessage, message);
            const extension: Extension = {
                context,
                worker,
                control,
                url,
                send,
                async state(tabId) {
                    const response = await send({ type: 'GET_STATE', tabId });
                    if (!response.ok) throw new Error(response.error);
                    return response.state;
                },
                async tabId(page) {
                    await page.bringToFront();
                    const id = await worker.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id);
                    if (id === undefined) throw new Error('Cannot locate the active test tab.');
                    return id;
                },
            };
            await use(extension);
            if (testInfo.status !== testInfo.expectedStatus && !control.isClosed()) {
                await testInfo.attach('popup-failure', {
                    body: await control.screenshot(),
                    contentType: 'image/png',
                });
            }
        } finally {
            await context?.close();
            // Only remove the fresh, uniquely named profile created for this test.
            await rm(profile, { recursive: true, force: true });
        }
    },
});

function makeRule(name: string, shortName: string, lane: string): LaneRule {
    return {
        id: crypto.randomUUID(),
        name,
        shortName,
        headers: [{ name: 'x-lane', value: lane }, { name: 'x-debug-user', value: 'local-test' }],
    };
}

async function save(extension: Extension, tabId: number, rule: LaneRule) {
    const result = await extension.send({ type: 'SAVE_RULE', tabId, rule });
    expect(result.ok, JSON.stringify(result)).toBe(true);
}

async function apply(extension: Extension, tabId: number, ruleId: string | null) {
    const result = await extension.send({ type: 'APPLY_RULE', tabId, ruleId });
    expect(result.ok, JSON.stringify(result)).toBe(true);
}

async function fetchHeaders(page: Page, originalLane?: string): Promise<Record<string, string>> {
    return page.evaluate(async (lane) => {
        const headers: Record<string, string> = { 'x-original': 'keep-me' };
        if (lane) headers['x-lane'] = lane;
        const response = await fetch(`/echo?nonce=${crypto.randomUUID()}`, { headers });
        return await response.json() as Record<string, string>;
    }, originalLane);
}

async function openTab(extension: Extension, echo: EchoServer) {
    const page = await extension.context.newPage();
    await page.goto(`${echo.origin}/page`);
    return { page, id: await extension.tabId(page) };
}

async function openPopup(extension: Extension, target: Page): Promise<Page> {
    await target.bringToFront();
    const popupReady = extension.context.waitForEvent('page');
    await extension.worker.evaluate(async (url) => { await chrome.tabs.create({ url, active: false }); }, extension.url);
    const popup = await popupReady;
    await popup.waitForURL(extension.url);
    await expect(popup.locator('#popup')).toHaveAttribute('aria-busy', 'false');
    return popup;
}

test('the same URL can use independent lanes across tabs, covering navigation and subresources', async ({ extension, echo }) => {
    const alpha = await openTab(extension, echo);
    const beta = await openTab(extension, echo);
    const unbound = await openTab(extension, echo);
    const alphaRule = makeRule('文档联调', 'ALP', 'alpha');
    const betaRule = makeRule('主体修复', 'BETA', 'beta');

    await save(extension, alpha.id, alphaRule);
    await save(extension, beta.id, betaRule);
    await apply(extension, alpha.id, alphaRule.id);
    await apply(extension, beta.id, betaRule.id);

    for (const [tab, lane] of [[alpha, 'alpha'], [beta, 'beta']] as const) {
        const headers = await fetchHeaders(tab.page, 'page-original');
        expect(headers['x-lane']).toBe(lane);
        expect(headers['x-debug-user']).toBe('local-test');
        expect(headers['x-original']).toBe('keep-me');
        const crossOriginHeaders = await tab.page.evaluate(async (origin) => {
            const response = await fetch(`${origin}/echo`, { headers: { 'x-original': 'cross-origin' } });
            return await response.json() as Record<string, string>;
        }, echo.crossOrigin);
        expect(crossOriginHeaders['x-lane']).toBe(lane);
        expect(crossOriginHeaders['x-debug-user']).toBe('local-test');
        expect(crossOriginHeaders['x-original']).toBe('cross-origin');

        const start = echo.requests.length;
        await tab.page.reload();
        await expect(tab.page).toHaveTitle(`🐨[${lane === 'alpha' ? 'ALP' : 'BETA'}] Lane test`);
        expect(await extension.worker.evaluate(async (tabId) => chrome.action.getBadgeText({ tabId }), tab.id)).toBe(lane === 'alpha' ? 'ALP' : 'BETA');
        const requests = echo.requests.slice(start);
        for (const path of ['/page', '/asset.svg', '/frame']) {
            expect(requests.some((request) => request.path === path && request.headers['x-lane'] === lane), `${lane} header missing from ${path}`).toBe(true);
        }
    }
    expect((await fetchHeaders(unbound.page))['x-lane']).toBeUndefined();
    expect((await fetchHeaders(unbound.page))['x-debug-user']).toBeUndefined();
    expect((await extension.state(unbound.id)).activeRuleId).toBeNull();
});

test('switching or disabling a tab does not affect another tab and restores its title', async ({ extension, echo }) => {
    const alpha = await openTab(extension, echo);
    const beta = await openTab(extension, echo);
    const first = makeRule('文档联调', 'DOC', 'alpha');
    const second = makeRule('主体修复', 'MAIN', 'beta');
    await save(extension, alpha.id, first);
    await save(extension, alpha.id, second);
    await apply(extension, alpha.id, first.id);
    await apply(extension, beta.id, first.id);

    await expect(alpha.page).toHaveTitle('🐨[DOC] Lane test');
    await expect.poll(() => extension.worker.evaluate(async (tabId) => chrome.action.getBadgeText({ tabId }), alpha.id)).toBe('DOC');
    await alpha.page.evaluate(() => { document.title = 'SPA changed title'; });
    await expect(alpha.page).toHaveTitle('🐨[DOC] SPA changed title');

    await apply(extension, alpha.id, second.id);
    expect((await fetchHeaders(alpha.page))['x-lane']).toBe('beta');
    expect((await fetchHeaders(beta.page))['x-lane']).toBe('alpha');
    await expect(alpha.page).toHaveTitle('🐨[MAIN] SPA changed title');
    await apply(extension, alpha.id, null);
    expect((await fetchHeaders(alpha.page, 'page-original'))['x-lane']).toBe('page-original');
    expect((await fetchHeaders(alpha.page))['x-debug-user']).toBeUndefined();
    expect((await fetchHeaders(beta.page))['x-lane']).toBe('alpha');
    await expect(alpha.page).toHaveTitle('SPA changed title');
    expect(await extension.worker.evaluate(async (tabId) => chrome.action.getBadgeText({ tabId }), alpha.id)).toBe('');
});

test('editing a shared rule updates all bound tabs and deleting it removes headers and indicators', async ({ extension, echo }) => {
    const alpha = await openTab(extension, echo);
    const beta = await openTab(extension, echo);
    const rule = makeRule('文档联调', 'DOC', 'old-lane');
    await save(extension, alpha.id, rule);
    await apply(extension, alpha.id, rule.id);
    await apply(extension, beta.id, rule.id);

    const changed: LaneRule = { ...rule, name: '新文档联调', shortName: 'NEW', headers: [{ name: 'x-lane', value: 'new-lane' }] };
    await save(extension, alpha.id, changed);
    for (const tab of [alpha, beta]) {
        const headers = await fetchHeaders(tab.page);
        expect(headers['x-lane']).toBe('new-lane');
        expect(headers['x-debug-user']).toBeUndefined();
        await expect(tab.page).toHaveTitle('🐨[NEW] Lane test');
        expect(await extension.worker.evaluate(async (tabId) => chrome.action.getBadgeText({ tabId }), tab.id)).toBe('NEW');
    }

    const deleted = await extension.send({ type: 'DELETE_RULE', tabId: alpha.id, ruleId: rule.id });
    expect(deleted.ok, JSON.stringify(deleted)).toBe(true);
    for (const tab of [alpha, beta]) {
        expect((await fetchHeaders(tab.page))['x-lane']).toBeUndefined();
        expect((await extension.state(tab.id)).activeRuleId).toBeNull();
        await expect(tab.page).toHaveTitle('Lane test');
        expect(await extension.worker.evaluate(async (tabId) => chrome.action.getBadgeText({ tabId }), tab.id)).toBe('');
    }
});

test('invalid edits do not replace a working rule and closing a tab removes its binding', async ({ extension, echo }) => {
    const alpha = await openTab(extension, echo);
    const observer = await openTab(extension, echo);
    const rule = makeRule('文档联调', 'DOC', 'stable-lane');
    await save(extension, alpha.id, rule);
    await apply(extension, alpha.id, rule.id);

    const invalidHeaders = [
        [{ name: 'invalid header', value: 'lane' }],
        [{ name: 'x-lane', value: 'one\r\nx-injected: yes' }],
        [{ name: 'x-lane', value: 'one' }, { name: 'X-Lane', value: 'two' }],
    ];
    for (const headers of invalidHeaders) {
        const result = await extension.send({ type: 'SAVE_RULE', tabId: alpha.id, rule: { ...rule, headers } });
        expect(result.ok).toBe(false);
        expect((await fetchHeaders(alpha.page))['x-lane']).toBe('stable-lane');
        expect((await extension.state(alpha.id)).rules.find((item) => item.id === rule.id)?.headers).toEqual(rule.headers);
    }

    await alpha.page.close();
    await expect.poll(async () => (await extension.state(observer.id)).bindings.some((binding) => binding.tabId === alpha.id)).toBe(false);
    await expect.poll(() => extension.worker.evaluate(async (tabId) =>
        (await chrome.declarativeNetRequest.getSessionRules()).some((item) => item.condition.tabIds?.includes(tabId)), alpha.id)).toBe(false);
    expect((await fetchHeaders(observer.page))['x-lane']).toBeUndefined();
});

test('headers survive service worker suspension and bindings can be changed after it wakes', async ({ extension, echo }) => {
    const target = await openTab(extension, echo);
    const rule = makeRule('文档联调', 'DOC', 'worker-lane');
    await save(extension, target.id, rule);
    await apply(extension, target.id, rule.id);
    await expect(target.page).toHaveTitle('🐨[DOC] Lane test');

    const session = await extension.context.newCDPSession(extension.control);
    let versionId: string | undefined;
    let runningStatus: string | undefined;
    session.on('ServiceWorker.workerVersionUpdated', (event) => {
        for (const version of event.versions) {
            if (version.scriptURL === extension.worker.url()) {
                versionId = version.versionId;
                runningStatus = version.runningStatus;
            }
        }
    });
    await session.send('ServiceWorker.enable');
    await expect.poll(() => versionId, { message: 'The extension service worker must be visible to CDP.' }).toBeDefined();
    await session.send('ServiceWorker.stopWorker', { versionId: versionId! });
    await expect.poll(() => runningStatus).toBe('stopped');

    // Fetching a page resource uses installed DNR rules without waking the worker.
    expect((await fetchHeaders(target.page))['x-lane']).toBe('worker-lane');
    expect(runningStatus).toBe('stopped');
    expect((await extension.state(target.id)).activeRuleId).toBe(rule.id);
    await expect.poll(() => runningStatus).toBe('running');
    await apply(extension, target.id, null);
    expect((await fetchHeaders(target.page))['x-lane']).toBeUndefined();
    await expect(target.page).toHaveTitle('Lane test');
    await session.detach();
});

test('reloading the extension clears the old indicator from pages that remain open', async ({ extension, echo }) => {
    const target = await openTab(extension, echo);
    const rule = makeRule('文档联调', 'DOC', 'reload-lane');
    await save(extension, target.id, rule);
    await apply(extension, target.id, rule.id);
    await expect(target.page).toHaveTitle('🐨[DOC] Lane test');

    const controlClosed = extension.control.waitForEvent('close');
    // Reload destroys the calling worker and extension pages, so its evaluation may reject.
    await extension.worker.evaluate(() => chrome.runtime.reload()).catch(() => undefined);
    await controlClosed;
    await expect(target.page).toHaveTitle('Lane test');
    expect((await fetchHeaders(target.page))['x-lane']).toBeUndefined();
    await target.page.evaluate(() => { document.title = 'Route after extension reload'; });
    await expect(target.page).toHaveTitle('Route after extension reload');
});

test('long lane names stay complete while the toolbar badge keeps four visible graphemes', async ({ extension, echo }, testInfo) => {
    const target = await openTab(extension, echo);
    const popupReady = extension.context.waitForEvent('page');
    await extension.worker.evaluate(async (url) => { await chrome.tabs.create({ url, active: false }); }, extension.url);
    const popup = await popupReady;
    const pageErrors: string[] = [];
    popup.on('pageerror', (error) => pageErrors.push(error.message));
    await popup.waitForURL(extension.url);
    const shortName = `👩🏽‍💻🇨🇳e\u0301🐨${'文档联调-'.repeat(36)}完整保留`;
    const expectedBadge = '👩🏽‍💻🇨🇳e\u0301🐨';

    await popup.getByRole('button', { name: '创建第一条规则' }).click();
    const nameInput = popup.getByLabel('规则简称', { exact: true });
    await expect(nameInput).not.toHaveAttribute('maxlength', /.+/);
    await popup.getByLabel('规则名称', { exact: true }).fill('完整简称与 emoji');
    await nameInput.fill(shortName);
    await popup.getByLabel('请求头内容 1', { exact: true }).fill('long-name-lane');
    await popup.getByRole('button', { name: '保存并应用' }).click();
    await expect(popup.getByRole('switch', { name: '停用「完整简称与 emoji」' })).toBeChecked();
    await expect(nameInput).toHaveValue(shortName);
    await expect(popup.locator('#activeCode')).toHaveText(shortName);
    const state = await extension.state(target.id);
    expect(state.rules.find((rule) => rule.id === state.activeRuleId)?.shortName).toBe(shortName);
    const storedShortName = await extension.worker.evaluate(async (ruleId) => {
        const stored = await chrome.storage.local.get('rules');
        return (stored.rules as LaneRule[]).find((rule) => rule.id === ruleId)?.shortName;
    }, state.activeRuleId);
    expect(storedShortName).toBe(shortName);
    await expect(target.page).toHaveTitle(`🐨[${shortName}] Lane test`);
    expect(await extension.worker.evaluate(async (tabId) => chrome.action.getBadgeText({ tabId }), target.id)).toBe(expectedBadge);
    expect((await fetchHeaders(target.page))['x-lane']).toBe('long-name-lane');

    await target.page.evaluate(() => { document.title = 'Long lane SPA route'; });
    await expect(target.page).toHaveTitle(`🐨[${shortName}] Long lane SPA route`);
    await target.page.reload();
    await expect(target.page).toHaveTitle(`🐨[${shortName}] Lane test`);
    const layout = await popup.evaluate(() => ({
        viewport: window.innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        bodyWidth: document.body.scrollWidth,
        controlsOutsideViewport: [...document.querySelectorAll('input, button')]
            .filter((element) => {
                const bounds = element.getBoundingClientRect();
                return bounds.width > 0 && (bounds.left < -1 || bounds.right > window.innerWidth + 1);
            }).map((element) => element.getAttribute('aria-label') || element.textContent),
    }));
    expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewport);
    expect(layout.bodyWidth).toBeLessThanOrEqual(layout.viewport);
    expect(layout.controlsOutsideViewport).toEqual([]);
    await popup.screenshot({ path: testInfo.outputPath('sketch-long-lane.png') });
    await popup.getByRole('button', { name: '停用此标签页' }).click();
    await expect(target.page).toHaveTitle('Lane test');
    expect(await extension.worker.evaluate(async (tabId) => chrome.action.getBadgeText({ tabId }), target.id)).toBe('');
    expect(pageErrors).toEqual([]);
});

test('the sketch popup can create, edit, enable, and delete rules without leaving the panel', async ({ extension, echo }, testInfo) => {
    const target = await openTab(extension, echo);
    // A background extension tab keeps the website active, as an action popup does.
    const popupReady = extension.context.waitForEvent('page');
    await extension.worker.evaluate(async (url) => { await chrome.tabs.create({ url, active: false }); }, extension.url);
    const popup = await popupReady;
    const pageErrors: string[] = [];
    popup.on('pageerror', (error) => pageErrors.push(error.message));
    await popup.waitForURL(extension.url);
    await expect(popup.getByRole('heading', { name: '有问题找kaola', exact: true, level: 1 })).toBeVisible();
    const koala = popup.getByRole('img', { name: '卡通考拉', exact: true });
    await expect(koala).toBeVisible();
    await expect.poll(() => koala.evaluate((element) => element instanceof HTMLImageElement && element.complete && element.naturalWidth > 0)).toBe(true);
    await expect.poll(() => popup.locator('svg.sketch-surface path').count()).toBeGreaterThan(0);
    const sketchSurfaces = await popup.locator('svg.sketch-surface').evaluateAll((elements) => elements.map((element) => ({
        decorative: element.getAttribute('aria-hidden'),
        pointerEvents: getComputedStyle(element).pointerEvents,
        paths: [...element.querySelectorAll('path')].map((path) => path.getAttribute('d')),
    })));
    expect(sketchSurfaces.length).toBeGreaterThan(0);
    for (const surface of sketchSurfaces) {
        expect(surface.decorative).toBe('true');
        expect(surface.pointerEvents).toBe('none');
        expect(surface.paths.length).toBeGreaterThan(0);
        expect(surface.paths.every((path) => path !== null && path.length > 10)).toBe(true);
    }
    const iconResults = await popup.evaluate(async () => {
        const manifest = chrome.runtime.getManifest();
        const icons = Object.entries(manifest.icons ?? {});
        const decoded = await Promise.all(icons.map(async ([size, path]) => {
            const image = new Image();
            image.src = chrome.runtime.getURL(path);
            await image.decode();
            return { size: Number(size), width: image.naturalWidth, height: image.naturalHeight, url: image.src };
        }));
        return { name: manifest.name, decoded };
    });
    expect(iconResults.name).toBe('有问题找kaola');
    expect(iconResults.decoded.map((icon) => icon.size)).toEqual([16, 32, 48, 128]);
    for (const icon of iconResults.decoded) {
        expect(icon.width).toBe(icon.size);
        expect(icon.height).toBe(icon.size);
        expect(icon.url.startsWith('chrome-extension://')).toBe(true);
    }
    await expect(popup.locator('#tabUrl')).toContainText(echo.origin);
    await expect(popup.getByRole('button', { name: '创建第一条规则' })).toBeEnabled();
    await popup.screenshot({ path: testInfo.outputPath('sketch-empty.png') });

    await popup.getByRole('button', { name: '创建第一条规则' }).click();
    await popup.getByRole('button', { name: '保存规则', exact: true }).click();
    await expect(popup.getByRole('alert')).not.toBeEmpty();
    await popup.getByLabel('规则名称', { exact: true }).fill('文档联调');
    await popup.getByLabel('规则简称', { exact: true }).fill('DOC');
    await popup.getByLabel('请求头内容 1', { exact: true }).fill('doc-20260910');
    await popup.getByRole('button', { name: '＋ 增加请求头' }).click();
    await popup.getByLabel('请求头名称 2', { exact: true }).fill('x-debug-user');
    await popup.getByLabel('请求头内容 2', { exact: true }).fill('local-test');
    await popup.getByRole('button', { name: '保存并应用' }).click();
    await expect(popup.getByRole('switch', { name: '停用「文档联调」' })).toBeChecked();
    expect((await fetchHeaders(target.page))['x-lane']).toBe('doc-20260910');

    for (const [name, shortName, lane] of [['主体修复', 'MAIN', 'main-test'], ['图视频轮询 oncall', 'ONC', 'oncall-test']]) {
        await popup.getByRole('button', { name: '＋ 新建规则' }).click();
        await popup.getByLabel('规则名称', { exact: true }).fill(name!);
        await popup.getByLabel('规则简称', { exact: true }).fill(shortName!);
        await popup.getByLabel('请求头内容 1', { exact: true }).fill(lane!);
        await popup.getByRole('button', { name: '保存规则', exact: true }).click();
        await expect(popup.getByRole('switch', { name: `启用「${name}」` })).not.toBeChecked();
    }
    const documentRule = popup.getByRole('listitem').filter({ has: popup.getByRole('switch', { name: '停用「文档联调」' }) });
    await documentRule.getByRole('button', { name: '编辑', exact: true }).click();
    await expect(popup.getByLabel('请求头内容 1', { exact: true })).toHaveValue('doc-20260910');
    await expect(popup.locator('#popup')).toHaveAttribute('aria-busy', 'false');
    for (const name of ['文档联调', '主体修复', '图视频轮询 oncall']) {
        await expect(popup.getByRole('button', { name: `删除「${name}」`, exact: true })).toBeVisible();
    }
    for (const selector of ['.tab-masthead', '.rule-index', '.sheet-footer', '#statusBar']) {
        await expect(popup.locator(`${selector} > svg.sketch-surface path`)).toHaveCount(2);
    }
    for (const selector of ['.sheet-footer', '#statusBar']) {
        expect(await popup.locator(selector).evaluate((element) => getComputedStyle(element).borderTopWidth)).toBe('0px');
    }
    await popup.screenshot({ path: testInfo.outputPath('sketch-popup.png') });
    await popup.screenshot({ path: fileURLToPath(new URL('../artifacts/sketch-popup.png', import.meta.url)) });

    await popup.getByLabel('请求头内容 1', { exact: true }).fill('edited-from-popup');
    await popup.getByRole('button', { name: '保存规则', exact: true }).click();
    await expect.poll(async () => (await fetchHeaders(target.page))['x-lane']).toBe('edited-from-popup');
    await popup.getByRole('switch', { name: '停用「文档联调」' }).click();
    await expect.poll(async () => (await fetchHeaders(target.page))['x-lane']).toBeUndefined();
    await expect(popup.locator('.sync-note')).toBeHidden();
    await popup.getByRole('switch', { name: '启用「文档联调」' }).click();
    await expect.poll(async () => (await fetchHeaders(target.page))['x-lane']).toBe('edited-from-popup');
    await expect(popup.locator('.sync-note')).toContainText('1 个标签页');
    await popup.getByRole('button', { name: '删除此规则' }).click();
    await expect(popup.getByRole('button', { name: '确认删除', exact: true })).toBeVisible();
    const otherRule = (await extension.state(target.id)).rules.find((rule) => rule.name === '主体修复');
    expect(otherRule).toBeDefined();
    await save(extension, target.id, { ...otherRule!, name: '主体修复（后台同步）' });
    // Seeing the changed rule proves the popup processed the real storage refresh.
    await expect(popup.getByRole('switch', { name: '启用「主体修复（后台同步）」' })).toBeVisible();
    await expect(popup.getByRole('button', { name: '确认删除', exact: true })).toBeVisible();
    await popup.getByRole('button', { name: '确认删除', exact: true }).click();
    await expect(popup.getByRole('switch', { name: /「文档联调」/ })).toHaveCount(0);
    await expect.poll(async () => (await fetchHeaders(target.page))['x-lane']).toBeUndefined();
    expect(pageErrors).toEqual([]);
});

test('list deletion can be cancelled and confirmed deletion clears every tab using that rule', async ({ extension, echo }) => {
    const alpha = await openTab(extension, echo);
    const beta = await openTab(extension, echo);
    const observer = await openTab(extension, echo);
    const shared = makeRule('文档联调', 'DOC', 'shared-lane');
    const other = makeRule('过期待删', 'OLD', 'old-lane');
    const untouched = makeRule('主体修复', 'MAIN', 'main-lane');
    for (const rule of [shared, other, untouched]) await save(extension, alpha.id, rule);
    await apply(extension, alpha.id, shared.id);
    await apply(extension, beta.id, shared.id);
    await apply(extension, observer.id, untouched.id);
    const popup = await openPopup(extension, alpha.page);
    const pageErrors: string[] = [];
    popup.on('pageerror', (error) => pageErrors.push(error.message));
    await expect(popup.getByLabel('规则名称', { exact: true })).toHaveValue(shared.name);

    await popup.getByRole('button', { name: `删除「${other.name}」`, exact: true }).click();
    await expect(popup.locator('.confirm-box')).toContainText(other.name);
    await popup.locator('.confirm-box').getByRole('button', { name: '继续编辑', exact: true }).click();
    await expect(popup.locator('.confirm-box')).toHaveCount(0);
    expect((await extension.state(alpha.id)).rules.some((rule) => rule.id === other.id)).toBe(true);
    await expect(popup.getByLabel('规则名称', { exact: true })).toHaveValue(shared.name);

    await popup.getByRole('button', { name: `删除「${other.name}」`, exact: true }).click();
    await popup.getByRole('button', { name: '确认删除', exact: true }).click();
    await expect(popup.getByRole('button', { name: `删除「${other.name}」`, exact: true })).toHaveCount(0);
    expect((await extension.state(alpha.id)).rules.some((rule) => rule.id === other.id)).toBe(false);
    await expect(popup.getByLabel('规则名称', { exact: true })).toHaveValue(shared.name);
    expect((await fetchHeaders(alpha.page))['x-lane']).toBe('shared-lane');

    await popup.getByRole('button', { name: `删除「${shared.name}」`, exact: true }).click();
    await expect(popup.locator('.confirm-box')).toContainText(shared.name);
    expect((await fetchHeaders(beta.page))['x-lane']).toBe('shared-lane');
    await popup.getByRole('button', { name: '确认删除', exact: true }).click();
    await expect(popup.getByRole('button', { name: `删除「${shared.name}」`, exact: true })).toHaveCount(0);
    for (const tab of [alpha, beta]) {
        expect((await extension.state(tab.id)).activeRuleId).toBeNull();
        expect((await fetchHeaders(tab.page))['x-lane']).toBeUndefined();
        await expect(tab.page).toHaveTitle('Lane test');
        expect(await extension.worker.evaluate(async (tabId) => chrome.action.getBadgeText({ tabId }), tab.id)).toBe('');
    }
    expect((await fetchHeaders(observer.page))['x-lane']).toBe('main-lane');
    await expect(observer.page).toHaveTitle('🐨[MAIN] Lane test');
    expect(pageErrors).toEqual([]);
});

test('rule directory starts newest-first and supports persisted drag and keyboard ordering', async ({ extension, echo }) => {
    const target = await openTab(extension, echo);
    const first = makeRule('规则一', 'ONE', 'lane-one');
    const second = makeRule('规则二', 'TWO', 'lane-two');
    const third = makeRule('规则三', 'THREE', 'lane-three');
    for (const rule of [first, second, third]) await save(extension, target.id, rule);
    await apply(extension, target.id, second.id);
    const popup = await openPopup(extension, target.page);
    const names = () => popup.locator('.rule-name').allTextContents();
    await expect.poll(names).toEqual([third.name, second.name, first.name]);

    // Reordering the directory must not discard an unsaved editor draft or change the active lane.
    await popup.getByRole('listitem').filter({ has: popup.getByRole('button', { name: `删除「${third.name}」` }) })
        .getByRole('button', { name: '编辑', exact: true }).click();
    await popup.getByLabel('规则名称', { exact: true }).fill('未保存的草稿');
    const secondHandle = popup.getByRole('button', { name: `拖动排序「${second.name}」` });
    await secondHandle.dragTo(popup.locator('.rule').first(), { targetPosition: { x: 10, y: 5 } });
    await expect.poll(names).toEqual([second.name, third.name, first.name]);
    await expect(popup.getByLabel('规则名称', { exact: true })).toHaveValue('未保存的草稿');
    expect((await extension.state(target.id)).activeRuleId).toBe(second.id);
    expect((await fetchHeaders(target.page))['x-lane']).toBe('lane-two');

    await popup.getByRole('button', { name: `拖动排序「${third.name}」` }).focus();
    await popup.keyboard.press('ArrowUp');
    await expect.poll(names).toEqual([third.name, second.name, first.name]);
    await popup.reload();
    await expect.poll(names).toEqual([third.name, second.name, first.name]);
    expect((await extension.state(target.id)).rules.map(rule => rule.id)).toEqual([third.id, second.id, first.id]);
});

test('list deletion preserves other dirty drafts and warns before discarding the deleted rule draft', async ({ extension, echo }) => {
    const target = await openTab(extension, echo);
    const edited = makeRule('正在编辑的规则', 'EDIT', 'saved-lane');
    const firstRemoval = makeRule('删除对象一', 'ONE', 'one-lane');
    const secondRemoval = makeRule('删除对象二', 'TWO', 'two-lane');
    for (const rule of [edited, firstRemoval, secondRemoval]) await save(extension, target.id, rule);
    const popup = await openPopup(extension, target.page);
    const pageErrors: string[] = [];
    popup.on('pageerror', (error) => pageErrors.push(error.message));
    await popup.getByRole('listitem').filter({ has: popup.getByRole('button', { name: `删除「${edited.name}」`, exact: true }) })
        .getByRole('button', { name: '编辑', exact: true }).click();
    const nameInput = popup.getByLabel('规则名称', { exact: true });
    const valueInput = popup.getByLabel('请求头内容 1', { exact: true });
    await expect(nameInput).toHaveValue(edited.name);
    await nameInput.fill('尚未保存的名称');
    await valueInput.fill('unsaved-existing-draft');

    await popup.getByRole('button', { name: `删除「${firstRemoval.name}」`, exact: true }).click();
    await popup.getByRole('button', { name: '确认删除', exact: true }).click();
    await expect(popup.getByRole('button', { name: `删除「${firstRemoval.name}」`, exact: true })).toHaveCount(0);
    await expect(nameInput).toHaveValue('尚未保存的名称');
    await expect(valueInput).toHaveValue('unsaved-existing-draft');
    await expect(popup.locator('.draft-state')).toHaveText('未保存');
    expect((await extension.state(target.id)).rules.find((rule) => rule.id === edited.id)).toEqual(edited);

    await popup.getByRole('button', { name: '＋ 新建规则' }).click();
    await popup.getByRole('button', { name: '放弃修改并继续', exact: true }).click();
    await nameInput.fill('尚未保存的新规则');
    await popup.getByLabel('规则简称', { exact: true }).fill('NEW');
    await valueInput.fill('unsaved-new-draft');
    await popup.getByRole('button', { name: `删除「${secondRemoval.name}」`, exact: true }).click();
    await popup.getByRole('button', { name: '确认删除', exact: true }).click();
    await expect(popup.getByRole('button', { name: `删除「${secondRemoval.name}」`, exact: true })).toHaveCount(0);
    await expect(nameInput).toHaveValue('尚未保存的新规则');
    await expect(valueInput).toHaveValue('unsaved-new-draft');
    await expect(popup.locator('.draft-state')).toHaveText('未保存');
    expect((await extension.state(target.id)).rules.map((rule) => rule.id)).toEqual([edited.id]);

    const remainingRule = popup.getByRole('listitem').filter({ has: popup.getByRole('button', { name: `删除「${edited.name}」`, exact: true }) });
    await remainingRule.getByRole('button', { name: '编辑', exact: true }).click();
    await popup.getByRole('button', { name: '放弃修改并继续', exact: true }).click();
    await valueInput.fill('unsaved-deleted-draft');
    await popup.getByRole('button', { name: `删除「${edited.name}」`, exact: true }).click();
    await expect(popup.locator('.confirm-box')).toContainText('未保存');
    await expect(popup.locator('.confirm-box')).toContainText('一并丢弃');
    expect((await extension.state(target.id)).rules.find((rule) => rule.id === edited.id)).toEqual(edited);
    await expect(valueInput).toHaveValue('unsaved-deleted-draft');
    await popup.locator('.confirm-box').getByRole('button', { name: '继续编辑', exact: true }).click();
    await expect(valueInput).toHaveValue('unsaved-deleted-draft');
    await expect(popup.locator('.draft-state')).toHaveText('未保存');

    await popup.getByRole('button', { name: `删除「${edited.name}」`, exact: true }).click();
    await popup.getByRole('button', { name: '确认删除', exact: true }).click();
    await expect(popup.getByRole('button', { name: '创建第一条规则', exact: true })).toBeVisible();
    expect((await extension.state(target.id)).rules).toEqual([]);
    expect(pageErrors).toEqual([]);
});

test('each tab can customize its title emoji without changing its rule, badge, or another tab', async ({ extension, echo }) => {
    const alpha = await openTab(extension, echo);
    const beta = await openTab(extension, echo);
    const rule = makeRule('共享文档规则', 'DOC', 'emoji-lane');
    await save(extension, alpha.id, rule);
    await apply(extension, alpha.id, rule.id);
    await apply(extension, beta.id, rule.id);
    const popup = await openPopup(extension, alpha.page);
    const pageErrors: string[] = [];
    popup.on('pageerror', (error) => pageErrors.push(error.message));
    const emojiInput = popup.getByLabel('标题表情', { exact: true });
    const saveEmoji = popup.getByRole('button', { name: '保存表情', exact: true });
    await expect(emojiInput).toHaveValue('🐨');
    await emojiInput.fill('🦊');
    await saveEmoji.click();
    await expect(alpha.page).toHaveTitle('🦊[DOC] Lane test');
    await expect(beta.page).toHaveTitle('🐨[DOC] Lane test');
    expect((await extension.state(alpha.id)).tab.emoji).toBe('🦊');
    expect((await extension.state(beta.id)).tab.emoji).toBe('🐨');
    expect(await extension.worker.evaluate(async (tabId) => chrome.action.getBadgeText({ tabId }), alpha.id)).toBe('DOC');

    const headerInput = popup.getByLabel('请求头内容 1', { exact: true });
    await headerInput.fill('still-unsaved-rule-draft');
    await emojiInput.fill('👩🏽‍💻');
    await saveEmoji.click();
    await expect(alpha.page).toHaveTitle('👩🏽‍💻[DOC] Lane test');
    await expect(headerInput).toHaveValue('still-unsaved-rule-draft');
    await expect(popup.locator('.draft-state')).toHaveText('未保存');
    expect((await fetchHeaders(alpha.page))['x-lane']).toBe('emoji-lane');

    await emojiInput.fill('abc');
    await saveEmoji.click();
    await expect(popup.locator('#statusBar')).toHaveClass(/error-status/);
    await expect(emojiInput).toHaveValue('abc');
    await expect(headerInput).toHaveValue('still-unsaved-rule-draft');
    expect((await extension.state(alpha.id)).tab.emoji).toBe('👩🏽‍💻');
    await expect(alpha.page).toHaveTitle('👩🏽‍💻[DOC] Lane test');
    for (const emoji of ['a', '🦊🐱']) {
        const result = await extension.send({ type: 'SET_TAB_EMOJI', tabId: alpha.id, emoji });
        expect(result.ok).toBe(false);
        expect((await extension.state(alpha.id)).tab.emoji).toBe('👩🏽‍💻');
    }
    await emojiInput.fill('👩🏽‍💻');
    await headerInput.fill('emoji-lane');
    await alpha.page.evaluate(() => { document.title = 'Emoji SPA route'; });
    await expect(alpha.page).toHaveTitle('👩🏽‍💻[DOC] Emoji SPA route');
    await alpha.page.reload();
    await expect(alpha.page).toHaveTitle('👩🏽‍💻[DOC] Lane test');

    const session = await extension.context.newCDPSession(extension.control);
    let versionId: string | undefined;
    let stopped = false;
    session.on('ServiceWorker.workerVersionUpdated', (event) => {
        for (const version of event.versions) {
            if (version.scriptURL === extension.worker.url()) {
                versionId = version.versionId;
                if (version.runningStatus === 'stopped') stopped = true;
            }
        }
    });
    await session.send('ServiceWorker.enable');
    await expect.poll(() => versionId).toBeDefined();
    await session.send('ServiceWorker.stopWorker', { versionId: versionId! });
    await expect.poll(() => stopped).toBe(true);
    expect((await extension.state(alpha.id)).tab.emoji).toBe('👩🏽‍💻');
    await expect(alpha.page).toHaveTitle('👩🏽‍💻[DOC] Lane test');
    await session.detach();

    await popup.getByRole('button', { name: '停用此标签页', exact: true }).click();
    await expect(alpha.page).toHaveTitle('Lane test');
    expect((await extension.state(alpha.id)).tab.emoji).toBe('👩🏽‍💻');
    await popup.getByRole('switch', { name: `启用「${rule.name}」`, exact: true }).click();
    await expect(alpha.page).toHaveTitle('👩🏽‍💻[DOC] Lane test');
    expect(await extension.worker.evaluate(async (tabId) => chrome.action.getBadgeText({ tabId }), alpha.id)).toBe('DOC');

    const unbound = await openTab(extension, echo);
    expect((await extension.state(unbound.id)).tab.emoji).toBe('🐨');
    const savedWithoutRule = await extension.send({ type: 'SET_TAB_EMOJI', tabId: unbound.id, emoji: '🐼' });
    expect(savedWithoutRule.ok, JSON.stringify(savedWithoutRule)).toBe(true);
    expect((await extension.state(unbound.id)).activeRuleId).toBeNull();
    await expect(unbound.page).toHaveTitle('Lane test');
    await apply(extension, unbound.id, rule.id);
    await expect(unbound.page).toHaveTitle('🐼[DOC] Lane test');

    await emojiInput.fill('');
    await saveEmoji.click();
    await expect(emojiInput).toHaveValue('🐨');
    await expect(alpha.page).toHaveTitle('🐨[DOC] Lane test');
    expect((await extension.state(alpha.id)).tab.emoji).toBe('🐨');
    await expect(beta.page).toHaveTitle('🐨[DOC] Lane test');
    await expect(unbound.page).toHaveTitle('🐼[DOC] Lane test');
    expect((await extension.state(alpha.id)).rules.find((item) => item.id === rule.id)).toEqual(rule);
    expect(pageErrors).toEqual([]);
});

test('only header content is required and empty rule labels follow its latest value', async ({ extension, echo }) => {
    const alpha = await openTab(extension, echo);
    const beta = await openTab(extension, echo);
    const popup = await openPopup(extension, alpha.page);
    const pageErrors: string[] = [];
    popup.on('pageerror', (error) => pageErrors.push(error.message));
    await popup.getByRole('button', { name: '创建第一条规则', exact: true }).click();
    const nameInput = popup.getByLabel('规则名称', { exact: true });
    const shortNameInput = popup.getByLabel('规则简称', { exact: true });
    const headerName = popup.getByLabel('请求头名称 1', { exact: true });
    const headerValue = popup.getByLabel('请求头内容 1', { exact: true });
    const originalValue = '  alpha\tlane  ';
    await expect(nameInput).toHaveValue('');
    await expect(shortNameInput).toHaveValue('');
    await headerName.fill('');
    await headerValue.fill(originalValue);
    await popup.getByRole('button', { name: '保存并应用', exact: true }).click();
    await expect(popup.getByRole('switch', { name: '停用「alpha lane」', exact: true })).toBeChecked();
    await expect(popup.locator('#activeCode')).toHaveText('alpha lane');
    await expect(nameInput).toHaveValue('');
    await expect(shortNameInput).toHaveValue('');
    await expect(headerName).toHaveValue('x-lane');
    await expect(headerValue).toHaveValue(originalValue);
    const state = await extension.state(alpha.id);
    const saved = state.rules.find((rule) => rule.id === state.activeRuleId);
    expect(saved).toBeDefined();
    expect(saved).toMatchObject({ name: '', shortName: '', headers: [{ name: 'x-lane', value: originalValue }] });
    const persisted = await extension.worker.evaluate(async (ruleId) => {
        const stored = await chrome.storage.local.get('rules');
        return (stored.rules as LaneRule[]).find((rule) => rule.id === ruleId);
    }, saved!.id);
    expect(persisted).toEqual(saved);
    await expect(alpha.page).toHaveTitle('🐨[alpha lane] Lane test');
    expect(await extension.worker.evaluate(async (tabId) => chrome.action.getBadgeText({ tabId }), alpha.id)).toBe('alph');
    // HTTP removes field-edge whitespace, while the stored value and interior tab remain intact.
    expect((await fetchHeaders(alpha.page))['x-lane']).toBe('alpha\tlane');
    await apply(extension, beta.id, saved!.id);
    await expect(beta.page).toHaveTitle('🐨[alpha lane] Lane test');

    const nextValue = '  beta\tlane  ';
    await headerValue.fill(nextValue);
    await popup.getByRole('button', { name: '保存规则', exact: true }).click();
    await expect(popup.getByRole('switch', { name: '停用「beta lane」', exact: true })).toBeChecked();
    await expect(popup.getByRole('heading', { name: '编辑「beta lane」', exact: true })).toBeVisible();
    await expect(nameInput).toHaveValue('');
    await expect(shortNameInput).toHaveValue('');
    for (const tab of [alpha, beta]) {
        await expect(tab.page).toHaveTitle('🐨[beta lane] Lane test');
        expect(await extension.worker.evaluate(async (tabId) => chrome.action.getBadgeText({ tabId }), tab.id)).toBe('beta');
        expect((await fetchHeaders(tab.page))['x-lane']).toBe('beta\tlane');
    }
    await alpha.page.evaluate(() => { document.title = 'Fallback label SPA'; });
    await expect(alpha.page).toHaveTitle('🐨[beta lane] Fallback label SPA');

    for (const invalidValue of ['', ' \t ']) {
        await headerValue.fill(invalidValue);
        await popup.getByRole('button', { name: '保存规则', exact: true }).click();
        await expect(popup.locator('#statusBar')).toHaveClass(/error-status/);
        await expect(popup.locator('#editor .error')).toContainText('不能为空');
        expect((await extension.state(alpha.id)).rules.find((rule) => rule.id === saved!.id)?.headers[0]?.value).toBe(nextValue);
        await expect(alpha.page).toHaveTitle('🐨[beta lane] Fallback label SPA');
    }
    await headerValue.fill(nextValue);
    await popup.getByRole('button', { name: '＋ 增加请求头', exact: true }).click();
    await popup.getByLabel('请求头名称 2', { exact: true }).fill('x-debug-user');
    await popup.getByRole('button', { name: '保存规则', exact: true }).click();
    await expect(popup.locator('#editor .error')).toContainText('不能为空');
    expect((await extension.state(alpha.id)).rules.find((rule) => rule.id === saved!.id)?.headers).toEqual([{ name: 'x-lane', value: nextValue }]);
    const duplicatedDefaults = await extension.send({
        type: 'SAVE_RULE',
        tabId: alpha.id,
        rule: { ...saved!, headers: [{ name: '', value: 'first' }, { name: ' ', value: 'second' }] },
    });
    expect(duplicatedDefaults.ok).toBe(false);
    expect((await fetchHeaders(alpha.page))['x-lane']).toBe('beta\tlane');
    expect(pageErrors).toEqual([]);
});

test('closing a tab during a queued indicator update does not report a synchronization error', async ({ extension, echo }) => {
    const target = await openTab(extension, echo);
    const rule = makeRule('关闭竞态回归', 'RACE', 'closed-tab-race');
    await save(extension, target.id, rule);
    await apply(extension, target.id, rule.id);
    await extension.send({ type: 'SET_TAB_EMOJI', tabId: target.id, emoji: '🦊' });
    await expect(target.page).toHaveTitle('🦊[RACE] Lane test');
    // A queued management response marks the end of earlier initialization/indicator work.
    await extension.state(target.id);
    const workerErrors: string[] = [];
    extension.worker.on('console', message => {
        if (message.type() === 'error') workerErrors.push(message.text());
    });

    await extension.worker.evaluate(tabId => {
        const originalBadge = chrome.action.setBadgeText.bind(chrome.action);
        const audit: ClosedTabAudit = { entered: false, settled: false, nativeErrors: [], originalBadge };
        const scope = globalThis as typeof globalThis & { __laneClosedTabAudit?: ClosedTabAudit };
        scope.__laneClosedTabAudit = audit;
        chrome.action.setBadgeText = (async details => {
            if (details.tabId !== tabId || audit.entered) return originalBadge(details);
            audit.entered = true;
            // Keep the native API call pending while the real tab is closed, making the race deterministic.
            await new Promise<void>(resolve => { audit.release = resolve; });
            try {
                return await originalBadge(details);
            } catch (error) {
                audit.nativeErrors.push(error instanceof Error ? error.message : String(error));
                throw error;
            } finally {
                audit.settled = true;
            }
        }) as typeof chrome.action.setBadgeText;
    }, target.id);

    try {
        // The real onUpdated(complete) handler enters the gate installed above.
        await target.page.reload({ waitUntil: 'load' });
        await expect.poll(() => extension.worker.evaluate(() =>
            (globalThis as typeof globalThis & { __laneClosedTabAudit?: ClosedTabAudit }).__laneClosedTabAudit?.entered,
        )).toBe(true);
        await target.page.close();
        await extension.worker.evaluate(() =>
            (globalThis as typeof globalThis & { __laneClosedTabAudit?: ClosedTabAudit }).__laneClosedTabAudit?.release?.(),
        );
        await expect.poll(() => extension.worker.evaluate(() =>
            (globalThis as typeof globalThis & { __laneClosedTabAudit?: ClosedTabAudit }).__laneClosedTabAudit?.settled,
        )).toBe(true);
        expect(await extension.worker.evaluate(() =>
            (globalThis as typeof globalThis & { __laneClosedTabAudit?: ClosedTabAudit }).__laneClosedTabAudit?.nativeErrors,
        )).toEqual([`No tab with id: ${target.id}.`]);

        // A later request passes through the same queue, ensuring onRemoved has finished its cleanup.
        const next = await openTab(extension, echo);
        const state = await extension.state(next.id);
        expect(state.bindings.some(binding => binding.tabId === target.id)).toBe(false);
        const cleaned = await extension.worker.evaluate(async tabId => {
            const session = await chrome.storage.session.get(['bindings', 'tabEmojis']);
            const bindings = session.bindings as Array<{ tabId: number }>;
            const emojis = session.tabEmojis as Array<{ tabId: number }>;
            const network = await chrome.declarativeNetRequest.getSessionRules();
            return {
                binding: bindings.some(binding => binding.tabId === tabId),
                emoji: emojis.some(emoji => emoji.tabId === tabId),
                network: network.some(rule => rule.condition.tabIds?.includes(tabId)),
            };
        }, target.id);
        expect(cleaned).toEqual({ binding: false, emoji: false, network: false });
        await apply(extension, next.id, rule.id);
        await expect(next.page).toHaveTitle('🐨[RACE] Lane test');
        expect((await fetchHeaders(next.page))['x-lane']).toBe('closed-tab-race');
        expect(workerErrors).toEqual([]);
    } finally {
        await extension.worker.evaluate(() => {
            const scope = globalThis as typeof globalThis & { __laneClosedTabAudit?: ClosedTabAudit };
            const audit = scope.__laneClosedTabAudit;
            if (!audit) return;
            audit.release?.();
            chrome.action.setBadgeText = audit.originalBadge;
            delete scope.__laneClosedTabAudit;
        }).catch(() => undefined);
    }
});
