import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const source = await build({ entryPoints: ['src/diagnostics.ts'], bundle: true, write: false, format: 'esm', platform: 'node' });
const { isMissingTabError, describeSyncFailure } = await import(`data:text/javascript;base64,${Buffer.from(source.outputFiles[0].contents).toString('base64')}`);

test('missing-tab recognition is exact and accepts Chrome promise error shapes', () => {
    for (const error of [new Error('No tab with id: 42.'), { message: 'No tab with id: 42' }, 'No tab with id: 42.']) {
        assert.equal(isMissingTabError(error, 42), true);
    }
    for (const error of [null, undefined, 42, new Error('No tab with id: 420.'), 'No tab with id: 42. another failure', 'prefix No tab with id: 42.']) {
        assert.equal(isMissingTabError(error, 42), false);
    }
});

test('diagnostic categories never repeat private error payloads', () => {
    const secret = 'Bearer private-test-token at https://private.example/?token=secret';
    const cases = [
        ['QUOTA_BYTES exceeded', 'STORAGE_LIMIT'],
        ['MAX_NUMBER_OF_SESSION_RULES exceeded', 'RULE_LIMIT'],
        ['Invalid rule in declarativeNetRequest', 'NETWORK_RULES'],
        ['标题表情格式错误', 'EMOJI_DATA'],
        ['标签页绑定数据格式无效', 'BINDING_DATA'],
        ['请求头字段无效', 'RULE_DATA'],
        ['chrome.action.method is not a function', 'BROWSER_API'],
        ['unrecognized failure', 'UNEXPECTED'],
    ];
    for (const [message, code] of cases) {
        const failure = describeSyncFailure(new Error(`${message}: ${secret}`));
        assert.equal(failure.code, code);
        assert.ok(failure.detail.length > 0);
        assert.ok(!JSON.stringify(failure).includes(secret));
        assert.ok(!JSON.stringify(failure).includes('private-test-token'));
    }
    assert.equal(describeSyncFailure(undefined).code, 'UNEXPECTED');
});
