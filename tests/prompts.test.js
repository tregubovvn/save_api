'use strict';

/* =========================================================================
   Тесты Prompts API (prompts-api.js).
   Запуск: node tests/prompts.test.js
   Без зависимостей: node:assert, подмена fetch и localStorage в памяти.
   ========================================================================= */

const assert = require('node:assert');
const path = require('node:path');

const LIB = path.join(__dirname, '..', 'prompts-api.js');
const PromptsApi = require(LIB);

/* --------------------------- Окружение браузера --------------------------- */

// localStorage в памяти: проверяем сохранение выбранного режима и токена
// между экземплярами API.
function installStorage() {
    const data = new Map();
    globalThis.localStorage = {
        getItem: key => (data.has(key) ? data.get(key) : null),
        setItem: (key, value) => data.set(key, String(value)),
        removeItem: key => data.delete(key),
        clear: () => data.clear(),
        key: i => Array.from(data.keys())[i] || null,
        get length() { return data.size; },
    };
    return data;
}
installStorage();

/* ------------------------------ Заглушка сети ------------------------------ */

let calls = [];
let routes = [];

function jsonResponse(status, data) {
    return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => JSON.stringify(data),
        json: async () => data,
    };
}

function route(match, handler) { routes.push({ match, handler }); }

async function fetchMock(url, opts) {
    const call = { url: String(url), opts: opts || {} };
    calls.push(call);
    for (const r of routes) {
        if (call.url.includes(r.match)) return r.handler(call);
    }
    throw new Error('unexpected fetch: ' + call.url);
}

function resetFetch() {
    calls = [];
    routes = [];
}

function gistPayload(id, content, filename) {
    const name = filename || 'prompts.md';
    return {
        id: id,
        html_url: 'https://gist.github.com/tregubovvn/' + id,
        description: 'test',
        files: {
            [name]: {
                filename: name,
                content: content,
                raw_url: 'https://gist.githubusercontent.com/tregubovvn/' + id + '/raw/' + name,
                truncated: false,
            },
        },
    };
}

function makeApi(options) {
    return PromptsApi.create(Object.assign({
        fetch: fetchMock,
        storagePrefix: 'test' + Math.random().toString(36).slice(2, 8),
        builtins: [
            { id: 'one', name: 'Первый', text: '# Промпт первый\n\nТекст первого промпта.' },
            { id: 'two', name: 'Второй', text: '# Промпт второй\n\nТекст второго промпта.' },
        ],
    }, options || {}));
}

/* --------------------------------- Раннер --------------------------------- */

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

async function throwsCode(fn, code) {
    let caught = null;
    try { await fn(); } catch (e) { caught = e; }
    assert.ok(caught, 'ожидалась ошибка ' + code);
    eq(caught.code, code, 'код ошибки: ' + caught.message);
    return caught;
}

/* --------------------------------- Тесты --------------------------------- */

(async function main() {
    console.log('\nPromptsApi v' + PromptsApi.VERSION + '\n');

    await test('parsePromptsMarkdown: секции по H1, преамбула игнорируется', () => {
        const md = [
            '<!-- prompts-api: каждый режим — заголовок первого уровня -->',
            '',
            '# Режим А',
            '',
            'Текст А.',
            '## Внутренний подзаголовок',
            '',
            '# Режим Б',
            '',
            'Текст Б.',
        ].join('\n');
        const modes = PromptsApi.parsePromptsMarkdown(md);
        eq(modes.map(m => m.name), ['Режим А', 'Режим Б']);
        eq(modes[0].text, 'Текст А.\n## Внутренний подзаголовок');
        eq(modes[0].legacy, false);
    });

    await test('parsePromptsMarkdown: старый формат «## Название»', () => {
        const md = [
            '# Промпты для редактора',
            '',
            'Каждая секция «## Название» — промпт.',
            '',
            '## Абзацы',
            '',
            '# Промпт для создания заданий READ',
            '',
            'Тело промпта.',
            '',
            '## Предложения',
            '',
            'Другое тело.',
        ].join('\n');
        const modes = PromptsApi.parsePromptsMarkdown(md);
        eq(modes.map(m => m.name), ['Абзацы', 'Предложения']);
        eq(modes[0].text, 'Тело промпта.', 'заголовок H1 промпта становится телом без заголовка');
        eq(modes[0].legacy, true);
    });

    await test('parsePromptsMarkdown: разделители --- не попадают в текст', () => {
        const md = '## А\n\nтекст\n\n---\n\n## Б\n\nещё';
        const modes = PromptsApi.parsePromptsMarkdown(md);
        eq(modes.map(m => m.text), ['текст', 'ещё']);
    });

    await test('buildPromptsMarkdown: H1-секции, маркер, внутренние H1 понижаются', () => {
        const md = PromptsApi.buildPromptsMarkdown([
            { name: 'Режим А', text: 'Первая строка\n# Внутренний заголовок\nещё' },
        ]);
        assert.ok(md.includes('prompts-api:'), 'маркер формата');
        assert.ok(md.startsWith('<!--'), 'файл начинается с маркера');
        assert.ok(md.includes('# Режим А'), 'название режима — H1');
        assert.ok(md.includes('## Внутренний заголовок'), 'внутренний H1 понижен до H2');
        const back = PromptsApi.parsePromptsMarkdown(md);
        eq(back.map(m => m.name), ['Режим А']);
        eq(back[0].text, 'Первая строка\n## Внутренний заголовок\nещё');
    });

    await test('splitTitle: заголовок режима из первой строки', () => {
        eq(PromptsApi.splitTitle('# Имя\n\nТело'), { title: 'Имя', body: 'Тело' });
        eq(PromptsApi.splitTitle('Без заголовка'), { title: '', body: 'Без заголовка' });
        eq(PromptsApi.splitTitle('## Не H1\n\nтекст'), { title: '', body: '## Не H1\n\nтекст' });
    });

    await test('splitTitle: ведущий служебный комментарий пропускается', () => {
        eq(PromptsApi.splitTitle('<!-- prompts-api: формат -->\n\n# Имя\n\nТело'), { title: 'Имя', body: 'Тело' });
    });

    await test('промпт-идентификатор по названию', () => {
        eq(PromptsApi.promptIdFromTitle('Тесты с формулами'), 'тесты-с-формулами');
        eq(PromptsApi.promptIdFromTitle('  A / B  '), 'a-b');
        eq(PromptsApi.promptIdFromTitle('***'), '');
    });

    await test('gistIdFromRef: ссылка, raw-ссылка, ID', () => {
        eq(PromptsApi.gistIdFromRef('https://gist.github.com/u/abc1234'), 'abc1234');
        eq(PromptsApi.gistIdFromRef('https://gist.githubusercontent.com/u/abc1234/raw/f.md'), 'abc1234');
        eq(PromptsApi.gistIdFromRef('abc1234'), 'abc1234');
        eq(PromptsApi.gistIdFromRef('https://example.com/x'), '');
    });

    await test('preset: два базовых режима rt_v2', () => {
        const api = makeApi({ preset: 'rt_v2', builtins: [] });
        const modes = api.listModes();
        eq(modes.length, 2);
        eq(modes.map(m => m.id), ['paragraphs', 'proposals']);
    });

    await test('load без токена: только два базовых режима, Gist не читается', async () => {
        resetFetch();
        const api = makeApi({ gistUrl: 'https://gist.github.com/u/abc1234' });
        const result = await api.load();
        eq(result.modes.length, 2);
        eq(result.modes.map(m => m.name), ['Промпт первый', 'Промпт второй']);
        eq(calls.length, 0, 'сетевых запросов без токена нет');
        eq(api.getPromptText(), 'Текст первого промпта.');
    });

    await test('load с токеном: базовые + пользовательские из одного Gist', async () => {
        resetFetch();
        route('/gists/aaaaaaa1', () => jsonResponse(200, gistPayload('aaaaaaa1', '# Промпт один\n\nТело один', 'p.md')));
        route('/gists/bbbbbbb2', () => jsonResponse(200, gistPayload('bbbbbbb2', '# Промпт два\n\nТело два', 'p.md')));
        const gistMd = PromptsApi.buildPromptsMarkdown([
            { name: 'Промпт один', text: 'Тело один' },       // копия базового — отсекается
            { name: 'Свой режим', text: 'Своё тело' },
        ]);
        route('/gists/c0ffee03', () => jsonResponse(200, gistPayload('c0ffee03', gistMd)));

        const api = makeApi({
            gistUrl: 'https://gist.github.com/u/c0ffee03',
            builtins: [
                { id: 'one', name: 'Один', gistUrl: 'https://gist.github.com/u/aaaaaaa1' },
                { id: 'two', name: 'Два', gistUrl: 'https://gist.github.com/u/bbbbbbb2' },
            ],
        });
        api.setToken('github', 'ghp_test');
        const result = await api.load();

        eq(result.modes.map(m => m.name), ['Промпт один', 'Промпт два', 'Свой режим']);
        eq(api.getPrompt('свой-режим').text, 'Своё тело');
        eq(result.errors, []);
    });

    await test('load: старый файл «## Абзацы» не дублирует базовые режимы', async () => {
        resetFetch();
        const legacy = [
            '# Промпты для редактора',
            '## Абзацы',
            '# Базовый промпт',
            'Тело базового',
            '## Свой',
            'Своё тело',
        ].join('\n');
        route('/gists/c0ffee04', () => jsonResponse(200, gistPayload('c0ffee04', legacy)));

        const api = makeApi({
            gistUrl: 'https://gist.github.com/u/c0ffee04',
            builtins: [{ id: 'one', name: 'Абзацы', text: '# Базовый промпт\n\nТело базового' }],
        });
        api.setToken('github', 't');
        const result = await api.load();
        eq(result.modes.map(m => m.name), ['Базовый промпт', 'Свой']);
        assert.ok(result.errors.some(e => /старом формате/.test(e)), 'предупреждение о старом формате');
    });

    await test('load: ошибка Gist не ломает базовые режимы', async () => {
        resetFetch();
        route('/gists/c0ffee05', () => jsonResponse(404, { message: 'Not Found' }));
        const api = makeApi({ gistUrl: 'https://gist.github.com/u/c0ffee05' });
        api.setToken('github', 't');
        const result = await api.load();
        eq(result.modes.length, 2);
        assert.ok(result.errors[0].includes('Not Found'));
    });

    await test('load: текст базового режима кэшируется при сбое сети', async () => {
        const prefix = 'cache' + Math.random().toString(36).slice(2, 8);
        resetFetch();
        route('/gists/aaaaaaa1', () => jsonResponse(200, gistPayload('aaaaaaa1', '# Кэш\n\nТело кэша', 'p.md')));
        const first = makeApi({
            storagePrefix: prefix,
            builtins: [{ id: 'one', name: 'Один', gistUrl: 'https://gist.github.com/u/aaaaaaa1' }],
        });
        await first.load();
        eq(first.getPrompt('one').text, 'Тело кэша');

        resetFetch();
        route('/gists/aaaaaaa1', () => jsonResponse(500, { message: 'boom' }));
        const second = makeApi({
            storagePrefix: prefix,
            builtins: [{ id: 'one', name: 'Один', gistUrl: 'https://gist.github.com/u/aaaaaaa1' }],
        });
        const result = await second.load();
        eq(second.getPrompt('one').text, 'Тело кэша', 'текст из кэша');
        assert.ok(result.errors[0].includes('кэш'));
    });

    await test('токен: tokenProvider и явное переопределение из окна', async () => {
        const api = makeApi({ tokenProvider: () => 'ghp_from_settings' });
        eq(api.hasToken(), true);
        await api.load();
        eq(api.getToken(), 'ghp_from_settings');
        api.setToken('github', 'ghp_from_dialog');
        eq(api.getToken(), 'ghp_from_dialog', 'токен из окна важнее настроек');
    });

    await test('addMode без токена → TOKEN_REQUIRED', () => {
        const api = makeApi();
        return throwsCode(() => api.addMode({ name: 'Свой' }), 'TOKEN_REQUIRED');
    });

    await test('addMode с токеном: id по названию, режим становится активным', async () => {
        resetFetch();
        const api = makeApi();
        api.setToken('github', 't');
        const mode = api.addMode({ name: 'Мой режим', text: '# Другое\n\nТекст' });
        eq(mode.id, 'мой-режим');
        eq(mode.text, '## Другое\n\nТекст', 'внутренний H1 понижается, текст не теряется');
        eq(api.listModes().length, 3);
        eq(api.hasUnsavedChanges(), true);
        api.setMode(mode.id);
        eq(api.getPromptText(), '## Другое\n\nТекст');
    });

    await test('addMode: повтор названия → VALIDATION', async () => {
        const api = makeApi();
        api.setToken('github', 't');
        api.addMode({ name: 'Свой' });
        await throwsCode(() => api.addMode({ name: 'свой' }), 'VALIDATION');
    });

    await test('updateMode: переименование меняет id и активный режим', async () => {
        const api = makeApi();
        api.setToken('github', 't');
        const mode = api.addMode({ name: 'Старое имя' });
        api.setMode(mode.id);
        const updated = api.updateMode(mode.id, { name: 'Новое имя', text: 'Тело' });
        eq(updated.id, 'новое-имя');
        eq(api.getModeId(), 'новое-имя');
        eq(api.getPrompt('новое-имя').text, 'Тело');
    });

    await test('updateMode/removeMode: базовый режим защищён', async () => {
        const api = makeApi();
        await throwsCode(() => api.updateMode('one', { text: 'x' }), 'READONLY_BUILTIN');
        await throwsCode(() => api.removeMode('one'), 'READONLY_BUILTIN');
    });

    await test('removeMode: свой режим удаляется, активный переключается', async () => {
        const api = makeApi();
        api.setToken('github', 't');
        const mode = api.addMode({ name: 'Свой' });
        api.setMode(mode.id);
        api.removeMode(mode.id);
        eq(api.listModes().length, 2);
        eq(api.getModeId(), 'one');
    });

    await test('setMode: неизвестный режим → NOT_FOUND, событие mode-change', async () => {
        const api = makeApi();
        let event = null;
        api.on('mode-change', e => { event = e; });
        await throwsCode(() => api.setMode('нет-такого'), 'NOT_FOUND');
        api.setMode('two');
        eq(event.id, 'two');
        eq(event.name, 'Промпт второй');
    });

    await test('выбранный режим сохраняется между экземплярами', async () => {
        const prefix = 'persist' + Math.random().toString(36).slice(2, 8);
        const first = makeApi({ storagePrefix: prefix });
        first.setMode('two');
        const second = makeApi({ storagePrefix: prefix });
        await second.load();
        eq(second.getModeId(), 'two');
    });

    await test('save без токена → TOKEN_REQUIRED', async () => {
        const api = makeApi();
        await throwsCode(() => api.save(), 'TOKEN_REQUIRED');
    });

    await test('save: создаёт приватный Gist с H1-секциями', async () => {
        resetFetch();
        route('api.github.com/gists', () => jsonResponse(201, gistPayload('d00d0007', 'ok')));
        const api = makeApi({ gistUrl: '' });
        api.setToken('github', 't');
        api.addMode({ name: 'Свой', text: 'Своё тело' });
        const result = await api.save();

        eq(result.count, 3, 'два базовых + свой');
        eq(result.gistId, 'd00d0007');
        eq(api.hasUnsavedChanges(), false);

        const body = JSON.parse(calls[0].opts.body);
        eq(body.public, false);
        const content = body.files['prompts.md'].content;
        assert.ok(content.includes('# Промпт первый'), 'базовый режим записан');
        assert.ok(content.includes('# Свой'), 'свой режим записан');
        assert.ok(content.includes('prompts-api:'), 'маркер формата');
    });

    await test('save: обновляет существующий Gist, includeBuiltinsInGist=false', async () => {
        resetFetch();
        route('/gists/e0dd0008', () => jsonResponse(200, gistPayload('e0dd0008', 'ok')));
        const api = makeApi({
            gistUrl: 'https://gist.github.com/u/e0dd0008',
            includeBuiltinsInGist: false,
        });
        api.setToken('github', 't');
        api.addMode({ name: 'Только свой', text: 'Тело' });
        const result = await api.save();

        eq(result.count, 1);
        eq(calls[0].opts.method, 'PATCH');
        const content = JSON.parse(calls[0].opts.body).files['prompts.md'].content;
        assert.ok(content.includes('# Только свой'));
        assert.ok(!content.includes('# Промпт первый'), 'базовые не пишутся');
    });

    await test('save: ошибка GitHub → понятный код и сообщение', async () => {
        resetFetch();
        route('api.github.com/gists', () => jsonResponse(401, { message: 'Bad credentials' }));
        const api = makeApi({ gistUrl: '' });
        api.setToken('github', 'bad');
        api.addMode({ name: 'Свой' });
        const err = await throwsCode(() => api.save(), 'TOKEN_INVALID');
        assert.ok(/Bad credentials/.test(err.message));
    });

    await test('события: load, prompts-change, status', async () => {
        resetFetch();
        const api = makeApi();
        const events = [];
        api.on('load', () => events.push('load'));
        api.on('prompts-change', () => events.push('prompts-change'));
        api.on('status', e => events.push('status:' + !!e.message));
        await api.load();
        assert.ok(events.includes('load'));
        assert.ok(events.includes('prompts-change'));
        assert.ok(events.some(e => e.startsWith('status:')));
    });

    await test('openDialog вне браузера → DOM_REQUIRED', async () => {
        const api = makeApi();
        await throwsCode(() => api.openDialog(), 'DOM_REQUIRED');
    });

    console.log('\nИтого: ' + results.passed + ' passed, ' + results.failed + ' failed\n');
    if (failures.length) {
        failures.forEach(f => {
            console.log('--- ' + f.name);
            console.log(f.error && f.error.stack ? f.error.stack : f.error);
        });
        process.exitCode = 1;
    }
})();
