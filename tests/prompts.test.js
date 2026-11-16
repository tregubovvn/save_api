'use strict';

/* =========================================================================
   Тесты Prompts API (prompts-api.js, v2 — хранение в одном XML на Gist).
   Запуск: node tests/prompts.test.js
   Без зависимостей: node:assert, подмена fetch и localStorage в памяти.
   ========================================================================= */

const assert = require('node:assert');
const path = require('node:path');

const LIB = path.join(__dirname, '..', 'prompts-api.js');
const PromptsApi = require(LIB);

/* --------------------------- Окружение браузера --------------------------- */

// localStorage в памяти: проверяем кэш XML, выбранный режим и токен
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
    const name = filename || 'prompts.xml';
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

// Пример файла из трёх промптов разных видов тестов.
function sampleXml() {
    return PromptsApi.buildPromptsXml([
        { name: 'Промпт READ', type: 'rt', text: 'Тело READ.' },
        { name: 'Промпт READ 2', type: 'rt', text: 'Тело READ 2.' },
        { name: 'Промпт Moodle', type: 'mt', text: 'Тело Moodle.' },
    ]);
}

function makeApi(options) {
    return PromptsApi.create(Object.assign({
        fetch: fetchMock,
        type: 'rt',
        storagePrefix: 'test' + Math.random().toString(36).slice(2, 8),
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

    await test('parsePromptsXml: записи с атрибутами type/name и CDATA-телом', () => {
        const xml = [
            '<?xml version="1.0" encoding="UTF-8"?>',
            '<prompts version="1">',
            '  <prompt type="rt" name="Режим А"><![CDATA[Текст А.\n## Подзаголовок]]></prompt>',
            '  <prompt type="mt" name="Режим Б"><![CDATA[Текст Б.]]></prompt>',
            '</prompts>',
        ].join('\n');
        const modes = PromptsApi.parsePromptsXml(xml);
        eq(modes.map(m => m.name), ['Режим А', 'Режим Б']);
        eq(modes.map(m => m.type), ['rt', 'mt']);
        eq(modes[0].text, 'Текст А.\n## Подзаголовок', 'внутренние H1/H2 не трогаются');
        eq(modes[0].id, 'режим-а');
    });

    await test('parsePromptsXml: экранирование ]]>, сущности в атрибутах', () => {
        const xml = '  <prompt type="ft" name="A &quot;B&quot; &amp; C"><![CDATA[до ]]]]><![CDATA[> после]]></prompt>';
        const modes = PromptsApi.parsePromptsXml(xml);
        eq(modes.length, 1);
        eq(modes[0].name, 'A "B" & C');
        eq(modes[0].text, 'до ]]> после');
    });

    await test('parsePromptsXml: запись без названия пропускается', () => {
        const xml = '<prompts>' +
            '<prompt type="rt" name=""><![CDATA[Без имени]]></prompt>' +
            '<prompt type="rt" name="Есть"><![CDATA[Тело]]></prompt>' +
            '</prompts>';
        const modes = PromptsApi.parsePromptsXml(xml);
        eq(modes.map(m => m.name), ['Есть']);
    });

    await test('buildPromptsXml: декларация, подсказка-комментарий, round-trip', () => {
        const xml = PromptsApi.buildPromptsXml([
            { name: 'Режим А', type: 'rt', text: 'Первая строка\n# Внутренний заголовок\nещё ]]> тут' },
            { name: 'Без вида', type: '', text: 'Тело' },
        ]);
        assert.ok(xml.startsWith('<?xml version="1.0"'), 'декларация XML');
        assert.ok(xml.includes('<prompts version="1">'), 'корень prompts');
        assert.ok(xml.includes('<!--'), 'комментарий-подсказка для ручной правки');
        assert.ok(xml.includes(']]]]><![CDATA[>'), ']]> экранируется внутри CDATA');

        const back = PromptsApi.parsePromptsXml(xml);
        eq(back.length, 2);
        eq(back[0].name, 'Режим А');
        eq(back[0].type, 'rt');
        eq(back[0].text, 'Первая строка\n# Внутренний заголовок\nещё ]]> тут');
        eq(back[1].type, '', 'пустой вид теста сохраняется без потерь');
    });

    await test('build → parse: полный round-trip образца файла', () => {
        const back = PromptsApi.parsePromptsXml(sampleXml());
        eq(back.map(m => m.name), ['Промпт READ', 'Промпт READ 2', 'Промпт Moodle']);
        eq(back.map(m => m.type), ['rt', 'rt', 'mt']);
        eq(back[2].text, 'Тело Moodle.');
    });

    await test('промпт-идентификатор по названию', () => {
        eq(PromptsApi.promptIdFromTitle('Тесты с формулами'), 'тесты-с-формулами');
        eq(PromptsApi.promptIdFromTitle('  A / B  '), 'a-b');
        eq(PromptsApi.promptIdFromTitle('***'), '');
    });

    await test('gistIdFromRef: ссылка, raw-ссылка, ID', () => {
        eq(PromptsApi.gistIdFromRef('https://gist.github.com/u/abc1234'), 'abc1234');
        eq(PromptsApi.gistIdFromRef('https://gist.githubusercontent.com/u/abc1234/raw/f.xml'), 'abc1234');
        eq(PromptsApi.gistIdFromRef('abc1234'), 'abc1234');
        eq(PromptsApi.gistIdFromRef('https://example.com/x'), '');
    });

    await test('normalizeType: виды тестов и старые имена пресетов', () => {
        eq(PromptsApi.normalizeType('rt'), 'rt');
        eq(PromptsApi.normalizeType('rt_v2'), 'rt');
        eq(PromptsApi.normalizeType('mt_v2'), 'mt');
        eq(PromptsApi.normalizeType('ft_v2'), 'ft');
        eq(PromptsApi.normalizeType(''), '');
        eq(PromptsApi.TYPE_LABELS.mt, 'Moodle Quiz');
    });

    await test('create: старая опция preset понимается как вид теста', () => {
        const api = PromptsApi.create({
            fetch: fetchMock,
            preset: 'mt_v2',
            storagePrefix: 'preset' + Math.random().toString(36).slice(2, 8),
        });
        eq(api.config.type, 'mt');
    });

    await test('load без токена: публичный Gist читается, промпты видны', async () => {
        resetFetch();
        route('/gists/feed0001', () => jsonResponse(200, gistPayload('feed0001', sampleXml())));
        const api = makeApi({ gistUrl: 'https://gist.github.com/u/feed0001' });
        const result = await api.load();

        eq(result.modes.length, 2, 'rt-экземпляр видит только свои промпты');
        eq(result.modes.map(m => m.name), ['Промпт READ', 'Промпт READ 2']);
        eq(calls.length, 1, 'один запрос к Gist');
        eq(api.getPromptText(), 'Тело READ.');
        eq(api.hasToken(), false);
    });

    await test('load: режимы другого вида не видны, но не теряются', async () => {
        resetFetch();
        route('/gists/feed0002', () => jsonResponse(200, gistPayload('feed0002', sampleXml())));
        const api = makeApi({ gistUrl: 'https://gist.github.com/u/feed0002' });
        await api.load();

        api.setToken('github', 't');
        const updated = api.updateMode('промпт-read', { name: 'Переименован', text: 'Новое тело' });
        eq(updated.name, 'Переименован');
        const result = await api.save();

        eq(result.count, 3, 'в файле остаются промпты всех видов');
        const patchCall = calls[calls.length - 1];
        const content = JSON.parse(patchCall.opts.body).files['prompts.xml'].content;
        const back = PromptsApi.parsePromptsXml(content);
        eq(back.map(m => m.name), ['Переименован', 'Промпт READ 2', 'Промпт Moodle']);
        eq(back[2].type, 'mt', 'промпт другого вида записывается без изменений');
    });

    await test('load: сбой сети → промпты из кэша', async () => {
        const prefix = 'cache' + Math.random().toString(36).slice(2, 8);
        resetFetch();
        route('/gists/feed0003', () => jsonResponse(200, gistPayload('feed0003', sampleXml())));
        const first = makeApi({ storagePrefix: prefix, gistUrl: 'https://gist.github.com/u/feed0003' });
        await first.load();
        eq(first.listModes().length, 2);

        resetFetch();
        route('/gists/feed0003', () => jsonResponse(500, { message: 'boom' }));
        const second = makeApi({ storagePrefix: prefix, gistUrl: 'https://gist.github.com/u/feed0003' });
        eq(second.listModes().length, 2, 'стартовый стуб из кэша — ещё до сети');
        const result = await second.load();
        eq(second.getPrompt('промпт-read').text, 'Тело READ.');
        assert.ok(result.errors.some(e => /кэша/.test(e)), 'замечание про кэш');
    });

    await test('load: в Gist нет XML-файла — понятная ошибка', async () => {
        resetFetch();
        route('/gists/feed0004', () => jsonResponse(200, gistPayload('feed0004', '# Не XML', 'readme.md')));
        const api = makeApi({ gistUrl: 'https://gist.github.com/u/feed0004' });
        const result = await api.load();
        eq(result.modes.length, 0);
        assert.ok(result.errors.some(e => /нет ни одного промпта/.test(e)));
    });

    await test('токен: tokenProvider и явное переопределение из окна', async () => {
        const api = makeApi({ tokenProvider: () => 'ghp_from_settings' });
        eq(api.hasToken(), true);
        eq(api.getToken(), 'ghp_from_settings');
        api.setToken('github', 'ghp_from_dialog');
        eq(api.getToken(), 'ghp_from_dialog', 'токен из окна важнее настроек');
    });

    await test('addMode без токена → TOKEN_REQUIRED', async () => {
        const api = makeApi();
        await throwsCode(() => api.addMode({ name: 'Свой' }), 'TOKEN_REQUIRED');
        await throwsCode(() => api.updateMode('x', { text: 'y' }), 'TOKEN_REQUIRED');
        await throwsCode(() => api.removeMode('x'), 'TOKEN_REQUIRED');
    });

    await test('addMode с токеном: id по названию, вид теста по умолчанию', async () => {
        const api = makeApi();
        api.setToken('github', 't');
        const mode = api.addMode({ name: 'Мой режим', text: '# Внутренний H1\n\nТекст' });
        eq(mode.id, 'мой-режим');
        eq(mode.type, 'rt', 'тип берётся из config.type');
        eq(mode.text, '# Внутренний H1\n\nТекст', 'markdown хранится дословно');
        eq(api.listModes().length, 1);
        eq(api.hasUnsavedChanges(), true);
        api.setMode(mode.id);
        eq(api.getPromptText(), '# Внутренний H1\n\nТекст');
    });

    await test('addMode: повтор названия в одном виде теста → VALIDATION', async () => {
        const api = makeApi();
        api.setToken('github', 't');
        api.addMode({ name: 'Свой', type: 'rt' });
        await throwsCode(() => api.addMode({ name: 'свой', type: 'rt' }), 'VALIDATION');
        const other = api.addMode({ name: 'Свой', type: 'mt' });
        eq(other.type, 'mt', 'то же имя в другом виде теста допустимо');
    });

    await test('updateMode: переименование меняет id, активный режим следует', async () => {
        const api = makeApi();
        api.setToken('github', 't');
        const mode = api.addMode({ name: 'Старое имя' });
        api.setMode(mode.id);
        const updated = api.updateMode(mode.id, { name: 'Новое имя', text: 'Тело' });
        eq(updated.id, 'новое-имя');
        eq(api.getModeId(), 'новое-имя');
        eq(api.getPrompt('новое-имя').text, 'Тело');
    });

    await test('updateMode: смена вида теста уводит режим из списка', async () => {
        const api = makeApi();
        api.setToken('github', 't');
        const mode = api.addMode({ name: 'Переезд' });
        api.setMode(mode.id);
        api.updateMode(mode.id, { type: 'mt' });
        eq(api.listModes().length, 0, 'в rt-экземпляре видимых промптов больше нет');
        eq(api.getModeId(), '');
        eq(api.getPrompt('переезд').type, 'mt', 'но сам промпт жив');
    });

    await test('removeMode: режим удаляется, активный переключается', async () => {
        const api = makeApi();
        api.setToken('github', 't');
        const a = api.addMode({ name: 'Один' });
        api.addMode({ name: 'Два' });
        api.setMode(a.id);
        api.removeMode(a.id);
        eq(api.listModes().length, 1);
        eq(api.getModeId(), 'два');
    });

    await test('setMode: неизвестный режим → NOT_FOUND, событие mode-change', async () => {
        const api = makeApi();
        api.setToken('github', 't');
        let event = null;
        api.on('mode-change', e => { event = e; });
        await throwsCode(() => api.setMode('нет-такого'), 'NOT_FOUND');
        const mode = api.addMode({ name: 'Свой' });
        api.setMode(mode.id);
        eq(event.id, 'свой');
        eq(event.name, 'Свой');
    });

    await test('выбранный режим сохраняется между экземплярами', async () => {
        const prefix = 'persist' + Math.random().toString(36).slice(2, 8);
        resetFetch();
        route('/gists/feed0005', () => jsonResponse(200, gistPayload('feed0005', sampleXml())));
        const first = makeApi({ storagePrefix: prefix, gistUrl: 'https://gist.github.com/u/feed0005' });
        await first.load();
        first.setMode('промпт-read-2');

        const second = makeApi({ storagePrefix: prefix, gistUrl: 'https://gist.github.com/u/feed0005' });
        eq(second.getModeId(), 'промпт-read-2', 'выбор восстановлен ещё до сети');
        const result = await second.load();
        eq(second.getModeId(), 'промпт-read-2');
        eq(result.modes.length, 2);
    });

    await test('save без токена → TOKEN_REQUIRED', async () => {
        const api = makeApi({ gistUrl: 'https://gist.github.com/u/feed0006' });
        await throwsCode(() => api.save(), 'TOKEN_REQUIRED');
    });

    await test('save: создаёт публичный Gist с prompts.xml', async () => {
        resetFetch();
        route('api.github.com/gists', () => jsonResponse(201, gistPayload('d00d0007', 'ok')));
        const api = makeApi({ gistUrl: '' });
        api.setToken('github', 't');
        api.addMode({ name: 'Свой', text: 'Своё тело' });
        const result = await api.save();

        eq(result.gistId, 'd00d0007');
        eq(api.hasUnsavedChanges(), false);
        const body = JSON.parse(calls[0].opts.body);
        eq(body.public, true, 'публичный: читается без токена');
        const content = body.files['prompts.xml'].content;
        const back = PromptsApi.parsePromptsXml(content);
        eq(back.length, 1);
        eq(back[0].name, 'Свой');
    });

    await test('save: обновляет существующий Gist и обновляет кэш', async () => {
        const prefix = 'savecache' + Math.random().toString(36).slice(2, 8);
        resetFetch();
        route('/gists/e0dd0008', () => jsonResponse(200, gistPayload('e0dd0008', 'ok')));
        const api = makeApi({ storagePrefix: prefix, gistUrl: 'https://gist.github.com/u/e0dd0008' });
        api.setToken('github', 't');
        api.addMode({ name: 'Только свой', text: 'Тело', type: 'ft' });
        const result = await api.save();

        eq(result.count, 1);
        eq(calls[0].opts.method, 'PATCH');
        const content = JSON.parse(calls[0].opts.body).files['prompts.xml'].content;
        assert.ok(content.includes('type="ft"'), 'вид теста записан в атрибут');

        // Кэш обновился: новый экземпляр видит промпт без сети.
        resetFetch();
        const next = makeApi({ storagePrefix: prefix, gistUrl: 'https://gist.github.com/u/e0dd0008' });
        eq(next.listModes().length, 0, 'ft-промпт не виден rt-экземпляру');
        eq(next.getPrompt('только-свой').text, 'Тело', 'но доступен через getPrompt');
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
        route('/gists/feed0009', () => jsonResponse(200, gistPayload('feed0009', sampleXml())));
        const api = makeApi({ gistUrl: 'https://gist.github.com/u/feed0009' });
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
