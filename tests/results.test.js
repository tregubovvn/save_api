'use strict';

/* =========================================================================
   Тесты ResultsApi. Запуск: node tests/results.test.js
   Без зависимостей: node:assert + подмена globalThis.fetch.
   ========================================================================= */

const assert = require('node:assert');
const path = require('node:path');

const ResultsApi = require(path.join(__dirname, '..', 'results-api.js'));

const results = { passed: 0, failed: 0 };
const failures = [];

async function test(name, fn) {
    try {
        await fn();
        results.passed++;
        console.log('  ok   ' + name);
    } catch (e) {
        results.failed++;
        failures.push({ name, error: e });
        console.log('  FAIL ' + name + ' :: ' + e.message);
    }
}

function eq(actual, expected, msg) {
    assert.deepStrictEqual(actual, expected, msg);
}

let calls = [];
let routes = [];

function jsonResponse(status, data) {
    const text = data === undefined ? '' : JSON.stringify(data);
    return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => text,
    };
}

function route(match, handler) {
    routes.push({ match, handler });
}

function installFetch() {
    globalThis.fetch = async (url, opts) => {
        const entry = { url: String(url), opts: opts || {} };
        calls.push(entry);
        for (const r of routes) {
            if (entry.url.includes(r.match)) return r.handler(entry);
        }
        throw new Error('unexpected fetch: ' + entry.url);
    };
}

function resetFetch() {
    calls = [];
    routes = [];
    installFetch();
}

function bodyOf(call) {
    return call.opts.body ? JSON.parse(call.opts.body) : null;
}

const RECENT = new Date(Date.now() - 60 * 1000).toISOString();       // минуту назад
const OLD = new Date(Date.now() - 30 * 60 * 1000).toISOString();     // полчаса назад

async function main() {
    console.log('\nResultsApi v' + ResultsApi.VERSION + '\n');

    await test('save: POST в /rest/v1/records с apikey и Bearer', async () => {
        resetFetch();
        route('/rest/v1/records', () => jsonResponse(201));
        const api = ResultsApi.create({
            endpoint: 'https://proj.supabase.co/', apiKey: 'anon-key', minIntervalMs: 0,
        });
        const r = await api.save({ studentId: '42', activity: 'RE:AD — тест', grade: 5, comment: 'ok' });
        eq(r.success, true);
        eq(r.record.student_id, '42');
        eq(r.record.grade, '5');
        eq(calls[0].url, 'https://proj.supabase.co/rest/v1/records');
        eq(calls[0].opts.method, 'POST');
        eq(calls[0].opts.headers.apikey, 'anon-key');
        eq(calls[0].opts.headers.Authorization, 'Bearer anon-key');
        eq(bodyOf(calls[0]).activity, 'RE:AD — тест');
    });

    await test('save: событие result-saved', async () => {
        resetFetch();
        route('/rest/v1/records', () => jsonResponse(201));
        const api = ResultsApi.create({ endpoint: 'https://p', apiKey: 'k', minIntervalMs: 0 });
        let saved = null;
        api.on('result-saved', e => { saved = e.record; });
        await api.save({ studentId: '1', activity: 'a', grade: 4 });
        eq(saved && saved.student_id, '1');
    });

    await test('save: ограничение частоты → RATE_LIMIT', async () => {
        resetFetch();
        route('/rest/v1/records', () => jsonResponse(200, [{ date_time: RECENT }]));
        const api = ResultsApi.create({ endpoint: 'https://p', apiKey: 'k' });
        await assert.rejects(
            () => api.save({ studentId: '1', activity: 'a', grade: 4 }),
            e => e.code === 'RATE_LIMIT' && /Подождите ещё/.test(e.message));
        eq(calls.length, 1);   // только проверка, без POST
    });

    await test('save: старая запись не блокирует', async () => {
        resetFetch();
        route('/rest/v1/records', (call) => {
            if (call.opts.method === 'POST') return jsonResponse(201);
            return jsonResponse(200, [{ date_time: OLD }]);
        });
        const api = ResultsApi.create({ endpoint: 'https://p', apiKey: 'k' });
        const r = await api.save({ studentId: '1', activity: 'a', grade: 4 });
        eq(r.success, true);
        eq(calls.length, 2);
    });

    await test('save: checkInterval:false пропускает проверку', async () => {
        resetFetch();
        route('/rest/v1/records', (call) => {
            if (call.opts.method === 'POST') return jsonResponse(201);
            return jsonResponse(200, [{ date_time: RECENT }]);
        });
        const api = ResultsApi.create({ endpoint: 'https://p', apiKey: 'k' });
        const r = await api.save({ studentId: '1', activity: 'a', grade: 4 }, { checkInterval: false });
        eq(r.success, true);
        eq(calls.length, 1);
    });

    await test('save: валидация полей', async () => {
        const api = ResultsApi.create({ endpoint: 'https://p', apiKey: 'k' });
        await assert.rejects(() => api.save({ activity: 'a', grade: 4 }), e => e.code === 'STUDENT_ID_REQUIRED');
        await assert.rejects(() => api.save({ studentId: '1', grade: 4 }), e => e.code === 'ACTIVITY_REQUIRED');
        await assert.rejects(() => api.save({ studentId: '1', activity: 'a' }), e => e.code === 'GRADE_REQUIRED');
    });

    await test('list: URL с фильтром, сортировкой и limit', async () => {
        resetFetch();
        route('/rest/v1/records', () => jsonResponse(200, [{ student_id: '7' }]));
        const api = ResultsApi.create({ endpoint: 'https://p', apiKey: 'k' });
        const rows = await api.list('7', { limit: 5 });
        eq(rows.length, 1);
        eq(calls[0].url.includes('student_id=eq.7'), true);
        eq(calls[0].url.includes('order=date_time.desc'), true);
        eq(calls[0].url.includes('limit=5'), true);
    });

    await test('list: без studentId → STUDENT_ID_REQUIRED', async () => {
        const api = ResultsApi.create({ endpoint: 'https://p', apiKey: 'k' });
        await assert.rejects(() => api.list(''), e => e.code === 'STUDENT_ID_REQUIRED');
    });

    await test('HTTP-ошибка содержит текст сервера', async () => {
        resetFetch();
        route('/rest/v1/records', () => jsonResponse(401, { message: 'Invalid API key' }));
        const api = ResultsApi.create({ endpoint: 'https://p', apiKey: 'k', minIntervalMs: 0 });
        await assert.rejects(
            () => api.save({ studentId: '1', activity: 'a', grade: 4 }),
            e => e.code === 'HTTP' && /Invalid API key/.test(e.message));
    });

    await test('без endpoint → ENDPOINT_REQUIRED', async () => {
        const api = ResultsApi.create({ apiKey: 'k' });
        await assert.rejects(() => api.list('1'), e => e.code === 'ENDPOINT_REQUIRED');
    });

    await test('ИД студента хранится между вызовами', () => {
        const api = ResultsApi.create({ endpoint: 'https://p', apiKey: 'k', storagePrefix: 'idTest' });
        eq(api.hasStudentId(), false);
        api.setStudentId(' 12345 ');
        eq(api.getStudentId(), '12345');
        eq(api.hasStudentId(), true);
        api.setStudentId('');
        eq(api.hasStudentId(), false);
    });

    await test('rateLimitStatus: остаток времени', async () => {
        resetFetch();
        route('/rest/v1/records', () => jsonResponse(200, [{ date_time: RECENT }]));
        const api = ResultsApi.create({ endpoint: 'https://p', apiKey: 'k', minIntervalMs: 10 * 60 * 1000 });
        const st = await api.rateLimitStatus('1');
        eq(st.limited, true);
        eq(st.waitMs > 0 && st.waitMs <= 10 * 60 * 1000, true);
    });

    console.log('\nИтого: ' + results.passed + ' passed, ' + results.failed + ' failed\n');
    if (results.failed) {
        for (const f of failures) {
            console.error('--- ' + f.name + '\n' + ((f.error && f.error.stack) || f.error) + '\n');
        }
        process.exitCode = 1;
    }
}

main();
