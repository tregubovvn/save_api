'use strict';

/* =========================================================================
   Характеризационные тесты Moodle File API.
   Запуск: node tests/run.js
   Никаких зависимостей: только node:assert и подмена globalThis.fetch.
   Цель — зафиксировать поведение публичного API до/после рефакторинга.
   ========================================================================= */

const assert = require('node:assert');
const path = require('node:path');

const LIB = path.join(__dirname, '..', 'file-api.js');
const FilesApi = require(LIB);

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

/* --------------------------- Заглушка fetch --------------------------- */

let calls = [];
let routes = [];

function jsonResponse(status, data) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => data,
        text: async () => JSON.stringify(data),
    };
}

function textResponse(status, text) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => { throw new Error('not json'); },
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

/* ------------------------------- Тесты ------------------------------- */

(async function main() {
    console.log('\nFilesApi v' + FilesApi.VERSION + '\n');

    /* ---------- Чистые функции ---------- */

    await test('extractGistId: ссылка gist', () => {
        eq(FilesApi.extractGistId('https://gist.github.com/user/abc1234567'), 'abc1234567');
    });

    await test('extractGistId: raw-ссылка', () => {
        eq(FilesApi.extractGistId('https://gist.githubusercontent.com/user/abc1234567/raw/quiz.xml'), 'abc1234567');
    });

    await test('extractGistId: голый ID', () => {
        eq(FilesApi.extractGistId('abc1234567'), 'abc1234567');
    });

    await test('extractGistId: ссылка приложения с ?name=', () => {
        const url = 'https://tregubovvn.github.io/mt_v2/index.html?name=' +
            encodeURIComponent('https://gist.githubusercontent.com/u/abc1234567/raw/q.xml');
        eq(FilesApi.extractGistId(url), 'abc1234567');
    });

    await test('extractGistId: мусор → null', () => {
        eq(FilesApi.extractGistId('не ссылка'), null);
        eq(FilesApi.extractGistId(''), null);
        eq(FilesApi.extractGistId(null), null);
    });

    await test('buildTaskUrl: без флагов', () => {
        eq(FilesApi.buildTaskUrl('https://x/raw.xml', {}, 'https://app/'),
            'https://app/?name=' + encodeURIComponent('https://x/raw.xml'));
    });

    await test('buildTaskUrl: флаги в порядке checkmode, headershow, crushmode, randommode', () => {
        const url = FilesApi.buildTaskUrl('https://x/raw.xml',
            { randommode: true, checkmode: true, crushmode: false, headershow: true }, 'https://app/');
        eq(url, 'https://app/?name=' + encodeURIComponent('https://x/raw.xml') +
            '&checkmode=true&headershow=true&randommode=true');
    });

    await test('buildTaskUrl: база с query → &', () => {
        const url = FilesApi.buildTaskUrl('https://x/raw.xml', {}, 'https://app/?v=1');
        eq(url.indexOf('&name=') > 0, true);
    });

    await test('buildTaskUrl: нет rawUrl или базы → пустая строка', () => {
        eq(FilesApi.buildTaskUrl('', {}, 'https://app/'), '');
        eq(FilesApi.buildTaskUrl('https://x/raw.xml', {}, ''), '');
    });

    /* ---------- Экземпляр: содержимое, имена, события ---------- */

    resetFetch();

    const api = FilesApi.create({ gistFilename: 'quiz.xml', fileName: 'quiz.xml' });

    await test('setContent: помечает dirty и эмитит content-change', () => {
        let changes = 0;
        let dirtyEvents = [];
        api.on('content-change', () => changes++);
        api.on('dirty-change', e => dirtyEvents.push(e.dirty));
        api.setContent('<quiz/>');
        eq(changes, 1);
        eq(dirtyEvents, [true]);
        eq(api.isDirty(), true);
        eq(api.getContent(), '<quiz/>');
    });

    await test('setContent({silent}) не меняет dirty', () => {
        const fresh = FilesApi.create();
        fresh.setContent('a');
        fresh.setContent('b', { silent: true });
        eq(fresh.getContent(), 'b');
        eq(fresh.isDirty(), true);   // dirty остался с первого вызова
        const clean = FilesApi.create();
        clean.setContent('x', { silent: true });
        eq(clean.isDirty(), false);
    });

    await test('setFileName санитизирует запрещённые символы', () => {
        const a = FilesApi.create();
        a.setFileName('a/b:c*?.xml');
        // подряд идущие запрещённые символы схлопываются в один '_'
        eq(a.getFileName(), 'a_b_c_.xml');
    });

    await test('on() возвращает отписку', () => {
        const a = FilesApi.create();
        let n = 0;
        const off = a.on('status', () => n++);
        a.setContent('x');
        a.setAutosave(false);
        const after = n;
        off();
        a.setAutosave(true);
        eq(n, after);
    });

    /* ---------- Токены ---------- */

    await test('токены: set/get/has/clear', () => {
        const a = FilesApi.create();
        eq(a.hasToken('github'), false);
        a.setToken('github', '  ghp_x  ');
        eq(a.getToken('github'), 'ghp_x');
        eq(a.hasToken('github'), true);
        a.clearToken('github');
        eq(a.getToken('github'), '');
    });

    await test('токены: неизвестный сервис → BAD_SERVICE', () => {
        const a = FilesApi.create();
        assert.throws(() => a.setToken('gitlab', 'x'), e => e.code === 'BAD_SERVICE');
    });

    /* ---------- Сохранение без DOM ---------- */

    await test('saveToFile без DOM → DOM_REQUIRED', async () => {
        const a = FilesApi.create();
        a.setContent('<quiz/>');
        await assert.rejects(() => a.saveToFile(), e => e.code === 'DOM_REQUIRED');
    });

    /* ---------- Gist ---------- */

    await test('loadFromGist: разбор ответа и привязка', async () => {
        resetFetch();
        route('/gists/abc1234', () => jsonResponse(200, {
            id: 'abc1234',
            html_url: 'https://gist.github.com/u/abc1234',
            description: 'Тест',
            files: {
                'quiz.xml': {
                    filename: 'quiz.xml',
                    content: '<quiz><question type="multichoice"/></quiz>',
                    raw_url: 'https://gist.githubusercontent.com/u/abc1234/raw/quiz.xml',
                },
            },
        }));
        const a = FilesApi.create();
        const r = await a.loadFromGist('https://gist.github.com/u/abc1234');
        eq(r.source, 'gist');
        eq(r.fileName, 'quiz.xml');
        eq(r.gist.gistId, 'abc1234');
        eq(a.getGistInfo().gistId, 'abc1234');
        eq(a.getContent().indexOf('<quiz>'), 0);
        eq(a.isDirty(), false);
        eq(calls[0].opts.headers, undefined);   // без токена заголовков нет
    });

    await test('loadFromGist: битая ссылка → BAD_REF', async () => {
        const a = FilesApi.create();
        await assert.rejects(() => a.loadFromGist('нет-id'), e => e.code === 'BAD_REF');
    });

    await test('loadFromGist: HTTP 404 → HTTP с текстом', async () => {
        resetFetch();
        route('/gists/deadbeef', () => jsonResponse(404, { message: 'Not Found' }));        const a = FilesApi.create();
        await assert.rejects(() => a.loadFromGist('deadbeef'), e =>
            e.code === 'HTTP' && /Not Found/.test(e.message));
    });

    await test('loadFromGist: пустой файл → EMPTY', async () => {
        resetFetch();
        route('/gists/abcdef1234', () => jsonResponse(200, {
            id: 'abcdef1234', files: { 'quiz.xml': { content: '   ', raw_url: 'https://x/raw' } },
        }));
        const a = FilesApi.create();
        await assert.rejects(() => a.loadFromGist('abcdef1234'), e => e.code === 'EMPTY');
    });

    await test('loadFromGist: validate блокирует → VALIDATION', async () => {
        resetFetch();
        route('/gists/abcdef12345', () => jsonResponse(200, {
            id: 'abcdef12345', files: { 'quiz.xml': { content: 'не xml', raw_url: null } },
        }));
        const a = FilesApi.create({ validate: c => (/<quiz/.test(c) ? null : 'не Moodle XML') });
        await assert.rejects(() => a.loadFromGist('abcdef12345'), e =>
            e.code === 'VALIDATION' && /не Moodle XML/.test(e.message));
    });

    await test('publishToGist: создание, заголовок Bearer, taskUrl', async () => {
        resetFetch();
        const raw = 'https://gist.githubusercontent.com/u/new1234/raw/quiz.xml';
        route('/gists', () => jsonResponse(201, {
            id: 'new1234',
            html_url: 'https://gist.github.com/u/new1234',
            files: { 'quiz.xml': { raw_url: raw } },
        }));
        const a = FilesApi.create({ testAppUrl: 'https://app/' });
        a.setToken('github', 'ghp_token');
        a.setContent('<quiz/>');
        const r = await a.publishToGist({ description: 'Описание' });
        eq(r.target, 'gist');
        eq(r.gistId, 'new1234');
        eq(r.rawUrl, raw);
        eq(r.taskUrl, 'https://app/?name=' + encodeURIComponent(raw));
        eq(calls[0].opts.method, 'POST');
        eq(calls[0].opts.headers.Authorization, 'Bearer ghp_token');
        eq(bodyOf(calls[0]).public, false);
        eq(bodyOf(calls[0]).files['quiz.xml'].content, '<quiz/>');
        eq(a.isDirty(), false);
    });

    await test('publishToGist: повторная публикация → PATCH по привязанному id', async () => {
        resetFetch();
        route('/gists', (call) => jsonResponse(200, {
            id: 'new1234', html_url: 'https://gist.github.com/u/new1234',
            files: { 'quiz.xml': { raw_url: 'https://x/raw2.xml' } },
        }));
        const a = FilesApi.create();
        a.setToken('github', 't');
        a.setContent('<quiz/>');
        await a.publishToGist();
        await a.publishToGist();
        eq(calls[1].opts.method, 'PATCH');
        eq(calls[1].url.endsWith('/gists/new1234'), true);
    });

    await test('publishToGist без токена → GITHUB_TOKEN_REQUIRED', async () => {
        const a = FilesApi.create();
        a.setContent('<quiz/>');
        await assert.rejects(() => a.publishToGist(), e => e.code === 'GITHUB_TOKEN_REQUIRED');
    });

    await test('beforePublish блокирует публикацию → VALIDATION', async () => {
        const a = FilesApi.create({ beforePublish: () => ({ ok: false, reason: 'нет правильного ответа' }) });
        a.setContent('<quiz/>');
        a.setToken('github', 't');
        await assert.rejects(() => a.publishToGist(), e =>
            e.code === 'VALIDATION' && /нет правильного ответа/.test(e.message));
    });

    /* ---------- Свой сервер ---------- */

    await test('publishToServer: имя файла <Тип>_<10 цифр>.xml и url из ответа', async () => {
        resetFetch();
        route('/publish.php', () => jsonResponse(200, {
            ok: true, url: 'https://site/Task_Arhive/ReadTest_1234567890.xml', updated: false,
        }));
        const a = FilesApi.create({ serverEndpoint: 'https://site/publish.php' });
        a.setToken('server', 'pw');
        a.setContent('<quiz/>');
        const r = await a.publishToServer({ taskType: 'ReadTest' });
        eq(/^ReadTest_\d{10}\.xml$/.test(r.fileName), true);
        eq(r.rawUrl, 'https://site/Task_Arhive/ReadTest_1234567890.xml');
        eq(r.updated, false);
        const body = bodyOf(calls[0]);
        eq(body.action, 'publish');
        eq(body.folder, 'Task_Arhive');
        eq(body.content, '<quiz/>');
        eq(typeof body.password, 'string');
    });

    await test('publishToServer: неверный тип → VALIDATION', async () => {
        const a = FilesApi.create();
        a.setToken('server', 'pw');
        a.setContent('<quiz/>');
        await assert.rejects(() => a.publishToServer({ taskType: 'HackTest' }), e => e.code === 'VALIDATION');
    });

    await test('publishToServer: 401 → SERVER_AUTH', async () => {
        resetFetch();
        route('/publish.php', () => jsonResponse(401, { error: 'Неверный пароль' }));
        const a = FilesApi.create({ serverEndpoint: 'https://site/publish.php' });
        a.setToken('server', 'bad');
        a.setContent('<quiz/>');
        await assert.rejects(() => a.publishToServer(), e =>
            e.code === 'SERVER_AUTH' && /Неверный пароль/.test(e.message));
    });

    await test('publishToServer без пароля → SERVER_PASSWORD_REQUIRED', async () => {
        const a = FilesApi.create();
        a.setContent('<quiz/>');
        await assert.rejects(() => a.publishToServer(), e => e.code === 'SERVER_PASSWORD_REQUIRED');
    });

    await test('listServerFiles: файлы из ответа', async () => {
        resetFetch();
        route('/publish.php', () => jsonResponse(200, {
            files: [{ name: 'ReadTest_1234567890.xml', size: 10, modified: 1, url: 'u' }],
            url: 'https://site/Task_Arhive/',
        }));
        const a = FilesApi.create({ serverEndpoint: 'https://site/publish.php' });
        a.setToken('server', 'pw');
        const r = await a.listServerFiles();
        eq(r.files.length, 1);
        eq(r.files[0].name, 'ReadTest_1234567890.xml');
        eq(bodyOf(calls[0]).action, 'list');
    });

    /* ---------- GitVerse ---------- */

    await test('publishToGitverse: выбор репозитория, 404 файла → POST, rawUrl', async () => {
        resetFetch();
        route('/user/repos', () => jsonResponse(200, {
            items: [{ path: 'other/repo' }, { path: 'me/moodle-quiz' }],
        }));
        route('/contents/quiz.xml', (call) => {
            if (call.opts.method === 'POST') {
                return jsonResponse(201, { blob_id: 'b1' });
            }
            return jsonResponse(404, { message: 'Not Found' });
        });
        const a = FilesApi.create({ testAppUrl: 'https://app/' });
        a.setToken('gitverse', 'gv');
        a.setContent('<quiz/>');
        const r = await a.publishToGitverse();
        eq(r.target, 'gitverse');
        eq(r.project, 'me/moodle-quiz');
        eq(r.branch, 'master');
        eq(r.fileName, 'quiz.xml');
        eq(r.rawUrl, 'https://gitverse.ru/me/moodle-quiz/raw/branch/master/quiz.xml');
        eq(bodyOf(calls[2]).commit_message.indexOf('Публикация') === 0, true);
    });

    await test('publishToGitverse без токена → GITVERSE_TOKEN_REQUIRED', async () => {
        const a = FilesApi.create();
        a.setContent('<quiz/>');
        await assert.rejects(() => a.publishToGitverse(), e => e.code === 'GITVERSE_TOKEN_REQUIRED');
    });

    /* ---------- Состояние ---------- */

    await test('isPublishedStale: после публикации и правки', async () => {
        resetFetch();
        route('/gists', () => jsonResponse(201, {
            id: 's1', html_url: 'https://gist.github.com/u/s1',
            files: { 'quiz.xml': { raw_url: 'https://x/raw.xml' } },
        }));
        const a = FilesApi.create();
        eq(a.isPublishedStale(), false);
        a.setToken('github', 't');
        a.setContent('<quiz/>');
        await a.publishToGist();
        eq(a.isPublishedStale(), false);
        a.setContent('<quiz><x/></quiz>');
        eq(a.isPublishedStale(), true);
        eq(a.getLastPublish().target, 'gist');
    });

    await test('resetPublishState: обнуляет привязку', async () => {
        resetFetch();
        route('/gists', () => jsonResponse(201, {
            id: 'r1', html_url: 'https://gist.github.com/u/r1',
            files: { 'quiz.xml': { raw_url: 'https://x/raw.xml' } },
        }));
        const a = FilesApi.create();
        a.setToken('github', 't');
        a.setContent('<quiz/>');
        await a.publishToGist();
        a.resetPublishState();
        eq(a.getGistInfo().gistId, null);
        eq(a.getLastPublish(), null);
        eq(a.getTaskUrl(), '');
    });

    await test('getTaskUrl до публикации → пустая строка', () => {
        const a = FilesApi.create();
        eq(a.getTaskUrl({ checkmode: true }), '');
    });

    /* ---------- Диалекты ссылки на приложение тестирования ---------- */

    await test('buildTaskUrl: rt_v2 читает ?file= (объект taskApp)', () => {
        const url = FilesApi.buildTaskUrl('https://x/raw.xml', { checkmode: true }, FilesApi.TASK_APPS.rt_v2);
        eq(url, 'https://tregubovvn.github.io/rt_v2/index.html?file=' +
            encodeURIComponent('https://x/raw.xml') + '&checkmode=true');
    });

    await test('buildTaskUrl: строка как baseUrl — обратная совместимость (?name=)', () => {
        const url = FilesApi.buildTaskUrl('https://x/raw.xml', {}, 'https://app/');
        eq(url.indexOf('?name=') > 0, true);
    });

    await test('getTaskApp: taskApp из конфига важнее testAppUrl', () => {
        const a = FilesApi.create({ taskApp: FilesApi.TASK_APPS.rt_v2 });
        eq(a.getTaskApp().paramName, 'file');
        const b = FilesApi.create();
        eq(b.getTaskApp().paramName, 'name');
    });

    await test('getTaskUrl: после публикации ссылка собирается с ?file= для rt_v2', async () => {
        resetFetch();
        route('/gists', () => jsonResponse(201, {
            id: 'rt1', html_url: 'https://gist.github.com/u/rt1',
            files: { 'quiz.xml': { raw_url: 'https://x/rt1.xml' } },
        }));
        const a = FilesApi.create({ taskApp: FilesApi.TASK_APPS.rt_v2 });
        a.setToken('github', 't');
        a.setContent('<quiz/>');
        await a.publishToGist();
        const url = a.getTaskUrl();
        eq(url.indexOf('?file=') > 0, true);
        eq(url.indexOf('?name='), -1);
    });

    /* ---------- Коллекции ---------- */

    await test('parseCollectionMarkdown: секции, id и повторы', () => {
        const md = '## Alpha\n\none\n\n## Тест\n\nдва\n\n## Alpha\n\nthree\n';
        const items = FilesApi.parseCollectionMarkdown(md);
        eq(items.length, 3);
        eq(items[0], { id: 'alpha', name: 'Alpha', text: 'one' });
        eq(items[1].id, 'тест');
        eq(items[1].text, 'два');
        eq(items[2].id, 'alpha-2');
    });

    await test('serializeCollectionMarkdown: round-trip', () => {
        const src = [{ id: 'a', name: 'Alpha', text: 'one\n\ntwo' }];
        const items = FilesApi.parseCollectionMarkdown(FilesApi.serializeCollectionMarkdown(src));
        eq(items.length, 1);
        eq(items[0].text, 'one\n\ntwo');
    });

    await test('saveCollection: создаёт Gist с MD-секциями', async () => {
        resetFetch();
        route('/gists', () => jsonResponse(201, {
            id: 'col1', html_url: 'https://gist.github.com/u/col1',
            files: { 'collection.md': { raw_url: 'https://x/col1.md' } },
        }));
        const a = FilesApi.create();
        a.setToken('github', 't');
        const r = await a.saveCollection({
            items: [{ id: 'a', name: 'Alpha', text: 'one' }, { id: 'b', name: 'Beta', text: 'two' }],
        });
        eq(r.count, 2);
        eq(r.gistId, 'col1');
        const body = bodyOf(calls[0]);
        eq(body.public, false);
        eq(body.files['collection.md'].content.includes('## Alpha'), true);
        eq(body.files['collection.md'].content.includes('two'), true);
    });

    await test('saveCollection: обновляет Gist и убирает старый .md', async () => {
        resetFetch();
        route('/gists/col1', (call) => {
            if (!call.opts.method || call.opts.method === 'GET') {
                return jsonResponse(200, { id: 'col1', files: { 'old.md': { content: '## Old\n\ntext' } } });
            }
            return jsonResponse(200, {
                id: 'col1', html_url: 'https://gist.github.com/u/col1',
                files: { 'collection.md': { raw_url: 'https://x/col1.md' } },
            });
        });
        const a = FilesApi.create();
        a.setToken('github', 't');
        const r = await a.saveCollection({ gistId: 'col1', items: [{ name: 'Alpha', text: 'one' }] });
        eq(r.fileName, 'collection.md');
        const patch = calls[1];
        eq(patch.opts.method, 'PATCH');
        eq(bodyOf(patch).files['old.md'], null);
    });

    await test('saveCollection: пустая коллекция → EMPTY', async () => {
        const a = FilesApi.create();
        a.setToken('github', 't');
        await assert.rejects(() => a.saveCollection({ items: [] }), e => e.code === 'EMPTY');
    });

    await test('loadCollection: разбирает файл и запоминает Gist', async () => {
        resetFetch();
        route('/gists/c01d2ab', () => jsonResponse(200, {
            id: 'c01d2ab', html_url: 'https://gist.github.com/u/c01d2ab', description: 'Промпты',
            files: { 'collection.md': { content: '## Alpha\n\none\n\n## Beta\n\ntwo', raw_url: 'https://x/c01d2ab.md' } },
        }));
        const a = FilesApi.create();
        const r = await a.loadCollection('https://gist.github.com/u/c01d2ab');
        eq(r.items.length, 2);
        eq(r.items[1].name, 'Beta');
        eq(r.gist.gistId, 'c01d2ab');
        eq(a.getCollectionInfo().gistUrl, 'https://gist.github.com/u/c01d2ab');
    });

    /* ---------- Черновики ---------- */

    await test('черновики: set/get/list/clear и наложение', () => {
        const a = FilesApi.create({ storagePrefix: 'draftTest' });
        eq(a.getDraft('alpha'), '');
        a.setDraft('alpha', 'локальная правка');
        eq(a.getDraft('alpha'), 'локальная правка');
        eq(a.listDrafts(), { alpha: 'локальная правка' });

        const applied = a.applyDrafts([
            { id: 'alpha', name: 'Alpha', text: 'из Gist' },
            { id: 'beta', name: 'Beta', text: 'beta' },
        ]);
        eq(applied[0].text, 'локальная правка');
        eq(applied[0].draft, true);
        eq(applied[1].draft, false);

        a.clearDraft('alpha');
        eq(a.getDraft('alpha'), '');
        a.setDraft('beta', 'x');
        a.clearDrafts();
        eq(a.listDrafts(), {});
    });

    /* ---------- Очередь публикаций ---------- */

    await test('очередь: три параллельных publishToGist → два запроса', async () => {
        resetFetch();
        route('/gists', () => jsonResponse(201, {
            id: 'q1', html_url: 'https://gist.github.com/u/q1',
            files: { 'quiz.xml': { raw_url: 'https://x/q1.xml' } },
        }));
        const a = FilesApi.create();
        a.setToken('github', 't');
        a.setContent('<quiz/>');
        const [r1, r2, r3] = await Promise.all([
            a.publishToGist(), a.publishToGist(), a.publishToGist(),
        ]);
        eq(calls.length, 2);
        eq([r1, r2, r3].every(r => r && r.gistId === 'q1'), true);
    });

    await test('очередь: singleFlight:false — три запроса', async () => {
        resetFetch();
        route('/gists', () => jsonResponse(201, {
            id: 'q2', html_url: 'https://gist.github.com/u/q2',
            files: { 'quiz.xml': { raw_url: 'https://x/q2.xml' } },
        }));
        const a = FilesApi.create({ singleFlight: false });
        a.setToken('github', 't');
        a.setContent('<quiz/>');
        await Promise.all([a.publishToGist(), a.publishToGist(), a.publishToGist()]);
        eq(calls.length, 3);
    });

    /* ---------- Итог ---------- */

    console.log('\nИтого: ' + results.passed + ' passed, ' + results.failed + ' failed\n');
    if (results.failed) {
        for (const f of failures) {
            console.error('--- ' + f.name + '\n' + (f.error && f.error.stack || f.error) + '\n');
        }
        process.exitCode = 1;
    }
})();
