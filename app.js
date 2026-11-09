'use strict';

/* =========================================================================
   Тестовая страница Moodle File API.
   Проверяются ВСЕ возможности библиотеки — страница общается с ней
   исключительно через публичное API (FilesApi.create, методы, события).
   ========================================================================= */

// --- Пример Moodle XML (из исходного редактора: вопрос с формулой) ---
const SAMPLE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<quiz>
    <question type="multichoice">
        <name>
            <text>Пример: вопрос с формулой</text>
        </name>
        <questiontext format="html">
            <text><![CDATA[<p>Выберите правильную формулу: \\( \\alpha_{н} = \\frac{АД_{сэ}}{АД_{с}} \\)</p>]]></text>
        </questiontext>
        <answer fraction="100" format="html">
            <text><![CDATA[\\( \\alpha_{н} = \\frac{АД_{сэ}}{АД_{с}} \\)]]></text>
        </answer>
        <answer fraction="0" format="html">
            <text><![CDATA[\\( \\alpha_{н} = \\frac{АД_{с}}{АД_{сэ}} \\)]]></text>
        </answer>
        <answer fraction="0" format="html">
            <text><![CDATA[\\( \\alpha_{н} = АД_{сэ} + АД_{с} \\)]]></text>
        </answer>
    </question>
</quiz>`;

// Параметр ?no-fs отключает File System Access API (тестирование fallback-пути)
const NO_FS = new URLSearchParams(location.search).has('no-fs');

// --- Экземпляр API ---
// window.api — отладочный доступ из консоли браузера (как window.editorState в редакторе)
const api = FilesApi.create({
    gistFilename: 'quiz.xml',
    fileName: 'quiz.xml',
    autoSaveDebounceMs: 1500,
    // Демонстрация хука validate: проверяем, что загруженное — Moodle XML
    validate: validateMoodleXml,
    // Демонстрация хука beforePublish: как в редакторе — у всех вопросов
    // должен быть выбран правильный ответ (fraction > 0)
    beforePublish: checkQuizAnswers,
});

// --- Настройки сервера публикации (адрес эндпоинта и папка) ---
// Хранятся в localStorage этой страницы; пароль — через api.setToken('server', …)
const SERVER_SETTINGS_KEY = 'moodleFileApiTest.server';

function loadServerSettings() {
    try { return JSON.parse(localStorage.getItem(SERVER_SETTINGS_KEY) || '{}'); }
    catch (e) { return {}; }
}

function saveServerSettings(patch) {
    try {
        const next = Object.assign(loadServerSettings(), patch);
        localStorage.setItem(SERVER_SETTINGS_KEY, JSON.stringify(next));
    } catch (e) { /* приватный режим — настройки не сохранятся */ }
}

// Отладочный доступ из консоли браузера (как window.editorState в редакторе)
window.api = api;

// --- DOM ---
const els = {};
['fsSupport', 'contentEditor', 'contentMeta', 'btnSample', 'btnLoadFile', 'btnSaveFile', 'btnCopyContent',
 'autosaveToggle', 'lastSaveTime', 'stateFile', 'stateDirty', 'stateStale', 'gistRef', 'btnLoadGist',
 'publishDescription', 'btnPublishGist', 'btnResetPublish', 'gvRepo', 'gvFileName', 'btnPublishGitverse',
 'serverTaskType', 'serverDescription', 'btnPublishServer', 'btnListServer',
 'publishInfo', 'flCheckMode', 'flShowHeader', 'flCrushMode', 'flRandomMode', 'taskUrl', 'btnCopyTaskUrl',
 'log', 'btnClearLog', 'statusText', 'statusMeta', 'settingsModal', 'btnSettings', 'btnSettingsClose',
 'btnSettingsDone', 'githubToken', 'gitverseToken', 'serverPassword', 'serverEndpoint', 'serverFolder', 'toast',
].forEach(id => { els[id] = document.getElementById(id); });

/* ====================== Проверки (хуки API) ====================== */

// Мягкая проверка Moodle XML: корневой <quiz> + хотя бы один <question type>
function validateMoodleXml(text) {
    const t = String(text || '');
    if (!/<quiz[\s>]/i.test(t)) return 'Это не Moodle XML: отсутствует корневой элемент <quiz>';
    const doc = new DOMParser().parseFromString(t, 'text/xml');
    if (doc.querySelector('parsererror')) return 'Некорректный XML (ошибка разбора)';
    if (!doc.querySelectorAll('question[type]').length) return 'В XML нет ни одного <question type="…">';
    return null;
}

// Проверка перед публикацией (логика исходного редактора): у каждого вопроса
// должны быть заполнены ответы и выбран правильный (fraction > 0)
function checkQuizAnswers(xml) {
    const doc = new DOMParser().parseFromString(String(xml || ''), 'text/xml');
    if (doc.querySelector('parsererror')) return 'Некорректный XML — публикация невозможна';
    const issues = [];
    doc.querySelectorAll('question[type]').forEach((q, i) => {
        const type = q.getAttribute('type');
        if (type === 'category' || type === 'description') return;
        const answers = q.querySelectorAll(':scope > answer');
        if (!answers.length) { issues.push('Q' + (i + 1) + ' (' + type + '): нет вариантов ответа'); return; }
        const hasText = Array.from(answers).some(a => ((a.querySelector('text') || {}).textContent || '').trim());
        const hasPositive = Array.from(answers).some(a => parseFloat(a.getAttribute('fraction') || '0') > 0);
        if (!hasText) issues.push('Q' + (i + 1) + ' (' + type + '): тексты ответов пусты');
        else if (!hasPositive) issues.push('Q' + (i + 1) + ' (' + type + '): не выбран правильный ответ (fraction > 0)');
    });
    return issues.length
        ? { ok: false, reason: 'Проверка перед публикацией не пройдена:\n' + issues.join('\n') }
        : null;
}

/* ====================== Вспомогательные ====================== */

function escHtml(s) {
    const d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
}

function toast(msg, isErr = false) {
    els.toast.textContent = msg;
    els.toast.classList.toggle('error', !!isErr);
    els.toast.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => els.toast.classList.remove('show'), 3500);
}

// Запись в журнал: kind = call | ok | err | evt | info
function log(kind, title, detail) {
    const el = document.createElement('div');
    el.className = 'log-entry log-' + kind;
    const time = new Date().toLocaleTimeString();
    el.innerHTML = '<span class="log-time">' + time + '</span>' +
        '<span class="log-kind">' + kind.toUpperCase() + '</span>' +
        '<span class="log-text"><strong>' + escHtml(title) + '</strong>' +
        (detail ? ' — ' + escHtml(detail) : '') + '</span>';
    els.log.appendChild(el);
    els.log.scrollTop = els.log.scrollHeight;
    while (els.log.children.length > 250) els.log.firstChild.remove();
}

// Краткое представление результата вызова для журнала
function summarize(r) {
    if (r == null) return '';
    if (typeof r !== 'object') return String(r).slice(0, 160);
    const copy = {};
    for (const [k, v] of Object.entries(r)) {
        if (k === 'content') copy[k] = '<' + String(v).length + ' символов>';
        else if (typeof v === 'object' && v !== null) copy[k] = v.gistId ? '{gistId: ' + v.gistId + '}' : '{…}';
        else copy[k] = v;
    }
    const s = JSON.stringify(copy);
    return s.length > 200 ? s.slice(0, 200) + '…' : s;
}

// Обёртка для кнопок: журналирует вызов, результат и ошибку
async function runApi(title, fn) {
    log('call', title);
    try {
        const r = await fn();
        if (r !== undefined && r !== null) log('ok', title, summarize(r));
        return r;
    } catch (e) {
        log('err', title, e.message);
        toast(e.message, true);
        return null;
    }
}

/* ====================== Обновление интерфейса ====================== */

function updateContentMeta() {
    const len = api.getContent().length;
    els.contentMeta.textContent = len
        ? (len.toLocaleString('ru-RU') + ' символов')
        : 'пусто';
    els.statusMeta.textContent = 'файл: ' + api.getFileName() + ' · символов: ' + len.toLocaleString('ru-RU');
}

function updateStateChips() {
    els.stateDirty.classList.toggle('hidden', !api.isDirty());
    els.stateStale.classList.toggle('hidden', !api.isPublishedStale());
}

function updateLastSaveTimeLabel() {
    const ts = api.getLastSaveTime();
    if (ts) {
        const d = new Date(ts);
        els.lastSaveTime.textContent = 'Последнее сохранение: ' + d.toLocaleDateString() + ' ' + d.toLocaleTimeString();
    } else {
        els.lastSaveTime.textContent = '';
    }
}

function flagsFromCheckboxes() {
    return {
        checkmode: els.flCheckMode.checked,
        headershow: els.flShowHeader.checked,
        crushmode: els.flCrushMode.checked,
        randommode: els.flRandomMode.checked,
    };
}

function updateTaskUrlDisplay() {
    const url = api.getTaskUrl(flagsFromCheckboxes());
    if (url) {
        els.taskUrl.href = url;
        els.taskUrl.textContent = url;
    } else {
        els.taskUrl.href = '#';
        els.taskUrl.textContent = '— ещё не публиковалось —';
    }
}

function updatePublishInfo() {
    const lp = api.getLastPublish();
    if (!lp) { els.publishInfo.textContent = 'ещё не публиковалось'; return; }
    if (lp.target === 'gist') els.publishInfo.textContent = 'Gist привязан: ' + lp.url;
    else if (lp.target === 'server') els.publishInfo.textContent = 'Сервер: ' + lp.rawUrl;
    else els.publishInfo.textContent = 'GitVerse: ' + lp.project + ' → ' + lp.fileName;
}

// Параметры публикации на сервер из полей страницы (переопределяют config API)
function serverOptsFromFields() {
    return {
        endpoint: els.serverEndpoint.value.trim() || undefined,
        folder: els.serverFolder.value.trim() || undefined,
        taskType: els.serverTaskType.value || undefined,
        description: els.serverDescription.value.trim() || undefined,
    };
}

/* ====================== События API ====================== */

api.on('status', e => { els.statusText.textContent = e.message; });

api.on('load', e => {
    els.contentEditor.value = e.content;
    if (e.gist && e.gist.description &&
        !['Moodle XML Quiz', 'Reading Test'].includes(e.gist.description) &&
        !els.publishDescription.value.trim()) {
        els.publishDescription.value = e.gist.description;   // как в редакторе: название из описания Gist
    }
    updateContentMeta(); updateStateChips(); updateTaskUrlDisplay(); updatePublishInfo();
    log('evt', 'load', e.source + ' → ' + e.fileName);
});

api.on('content-change', () => { updateContentMeta(); });
api.on('dirty-change', e => { updateStateChips(); if (!e.dirty) updateLastSaveTimeLabel(); });

api.on('save', e => {
    log('evt', 'save', e.method + ' → ' + e.fileName);
    els.stateFile.textContent = 'файл: ' + e.fileName;
    updateLastSaveTimeLabel(); updateStateChips();
});

api.on('autosave', e => {
    log('evt', 'autosave', e.fileName + ' в ' + new Date(e.at).toLocaleTimeString());
    updateLastSaveTimeLabel(); updateStateChips();
});

api.on('autosave-skip', e => { log('evt', 'autosave-skip', e.reason); });

api.on('publish', e => {
    log('evt', 'publish', summarize(e));
    updateTaskUrlDisplay(); updatePublishInfo(); updateStateChips();
    toast('Опубликовано: ' + (e.rawUrl || e.gistUrl || ''));
});

api.on('publish-reset', () => { updateTaskUrlDisplay(); updatePublishInfo(); updateStateChips(); });

api.on('autosave-change', e => { els.autosaveToggle.checked = e.enabled; });

/* ====================== Кнопки ====================== */

els.btnSample.addEventListener('click', async () => {
    await runApi('setContent(пример)', () => api.setContent(SAMPLE_XML, { fileName: 'quiz.xml' }));
    els.contentEditor.value = SAMPLE_XML;
    els.publishDescription.value = 'Тестовый пример (формулы)';
    toast('Пример загружен в редактор содержимого');
});

els.contentEditor.addEventListener('input', () => {
    api.setContent(els.contentEditor.value);   // dirty + автосохранение + события
});

els.btnLoadFile.addEventListener('click', () =>
    runApi('loadFromFile()', () => api.loadFromFile(NO_FS ? { fsAccess: false } : {})));

els.btnSaveFile.addEventListener('click', () =>
    runApi('saveToFile()', () => api.saveToFile(Object.assign(
        { fileName: els.publishDescription.value.trim() || undefined },
        NO_FS ? { fsAccess: false } : {}))));

els.btnCopyContent.addEventListener('click', async () => {
    await navigator.clipboard.writeText(api.getContent());
    toast('Содержимое скопировано в буфер обмена');
});

els.autosaveToggle.addEventListener('change', () =>
    runApi('setAutosave(' + els.autosaveToggle.checked + ')', () => api.setAutosave(els.autosaveToggle.checked)));

els.btnLoadGist.addEventListener('click', () => {
    const ref = els.gistRef.value.trim();
    if (!ref) { toast('Вставьте ссылку на Gist или его ID', true); return; }
    return runApi('loadFromGist(' + JSON.stringify(ref.slice(0, 60)) + '…)', () => api.loadFromGist(ref));
});

els.btnPublishGist.addEventListener('click', () =>
    runApi('publishToGist({description})', () =>
        api.publishToGist({ description: els.publishDescription.value.trim() || undefined })));

els.btnPublishGitverse.addEventListener('click', () =>
    runApi('publishToGitverse({repo, fileName, description})', () =>
        api.publishToGitverse({
            repo: els.gvRepo.value.trim() || undefined,
            fileName: els.gvFileName.value.trim() || undefined,
            description: els.publishDescription.value.trim() || undefined,
        })));

els.btnPublishServer.addEventListener('click', () => {
    if (!api.hasToken('server')) {
        toast('Задайте пароль сервера: ⚙ Настройки → «Пароль публикации»', true);
        showSettings();
        return;
    }
    return runApi('publishToServer({taskType, description})', () =>
        api.publishToServer(serverOptsFromFields()));
});

els.btnListServer.addEventListener('click', async () => {
    if (!api.hasToken('server')) {
        toast('Задайте пароль сервера: ⚙ Настройки → «Пароль публикации»', true);
        showSettings();
        return;
    }
    log('call', 'listServerFiles()');
    try {
        const r = await api.listServerFiles({
            endpoint: els.serverEndpoint.value.trim() || undefined,
            folder: els.serverFolder.value.trim() || undefined,
        });
        const names = r.files.map(f => f.name);
        log('ok', 'listServerFiles()', r.files.length + ' шт.' + (names.length ? ': ' + names.slice(0, 8).join(', ') + (names.length > 8 ? ' …' : '') : ''));
        toast('На сервере файлов: ' + r.files.length);
    } catch (e) {
        log('err', 'listServerFiles()', e.message);
        toast(e.message, true);
    }
});

els.btnResetPublish.addEventListener('click', () => runApi('resetPublishState()', () => api.resetPublishState()));

['flCheckMode', 'flShowHeader', 'flCrushMode', 'flRandomMode'].forEach(id =>
    els[id].addEventListener('change', updateTaskUrlDisplay));

els.btnCopyTaskUrl.addEventListener('click', () => {
    const url = api.getTaskUrl(flagsFromCheckboxes());
    if (!url) { toast('Задание ещё не опубликовано', true); return; }
    navigator.clipboard.writeText(url);
    toast('Ссылка на тест скопирована');
});

els.btnClearLog.addEventListener('click', () => { els.log.innerHTML = ''; log('info', 'журнал очищен'); });

/* ====================== Настройки (токены) ====================== */

function showSettings() {
    els.githubToken.value = api.getToken('github');
    els.gitverseToken.value = api.getToken('gitverse');
    els.serverPassword.value = api.getToken('server');
    els.settingsModal.classList.add('show');
    els.githubToken.focus();
}
function hideSettings() { els.settingsModal.classList.remove('show'); }

els.btnSettings.addEventListener('click', showSettings);
els.btnSettingsClose.addEventListener('click', hideSettings);
els.btnSettingsDone.addEventListener('click', hideSettings);
els.settingsModal.addEventListener('click', e => { if (e.target === els.settingsModal) hideSettings(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') hideSettings(); });

els.githubToken.addEventListener('change', () => api.setToken('github', els.githubToken.value));
els.gitverseToken.addEventListener('change', () => api.setToken('gitverse', els.gitverseToken.value));
els.serverPassword.addEventListener('change', () => {
    api.setToken('server', els.serverPassword.value);
    toast(els.serverPassword.value ? 'Пароль сервера сохранён' : 'Пароль сервера удалён');
});
els.serverEndpoint.addEventListener('change', () => saveServerSettings({ endpoint: els.serverEndpoint.value.trim() }));
els.serverFolder.addEventListener('change', () => saveServerSettings({ folder: els.serverFolder.value.trim() }));

/* ====================== Инициализация ====================== */

document.addEventListener('DOMContentLoaded', () => {
    // Поддержка File System Access API определяет способ сохранения
    const fs = FilesApi.isFsAccessSupported() && !NO_FS;
    els.fsSupport.textContent = NO_FS
        ? 'FS Access API отключён (?no-fs) — сохранение через скачивание'
        : ('FS Access API: ' + (fs ? 'да' : 'нет — сохранение через скачивание'));
    els.fsSupport.classList.add(fs ? 'ok' : 'warn');

    els.autosaveToggle.checked = api.isAutosaveEnabled();

    // Настройки сервера публикации: сохранённые значения или умолчания API
    const srv = loadServerSettings();
    els.serverEndpoint.value = srv.endpoint || api.config.serverEndpoint;
    els.serverFolder.value = srv.folder || api.config.serverFolder;

    // Сразу загружаем пример — можно тестировать сохранение/публикацию без подготовки
    els.contentEditor.value = SAMPLE_XML;
    api.setContent(SAMPLE_XML, { fileName: 'quiz.xml' });
    els.publishDescription.value = 'Тестовый пример (формулы)';

    updateContentMeta(); updateStateChips(); updateLastSaveTimeLabel(); updateTaskUrlDisplay(); updatePublishInfo();

    log('info', 'API готов', 'FilesApi v' + FilesApi.VERSION +
        ' · методы: setContent, loadFromFile, loadFromGist, saveToFile, setAutosave, publishToGist, publishToGitverse, publishToServer, listServerFiles, getTaskUrl…');
    els.statusText.textContent = 'Готово: загружен пример, можно сохранять и публиковать';
});
