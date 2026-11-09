'use strict';

/* =========================================================================
   Moodle File API — файловый сервис для работы с XML-заданиями.
   Рефакторинг Moodle XML Редактора: оставлены ТОЛЬКО возможности,
   связанные с файлами:
     1. ЗАГРУЗКА    — файл с диска (File System Access API + fallback),
                      GitHub Gist (ссылка / raw / ID).
     2. СОХРАНЕНИЕ  — файл на диске (запись в выбранный файл, диалог
                      сохранения, скачивание), автосохранение с задержкой.
     3. ПУБЛИКАЦИЯ  — GitHub Gist (создание / обновление), GitVerse
                      (коммит XML-файла в репозиторий), собственный сервер
                      (PHP-эндпоинт, папка архива заданий, доступ по паролю,
                      имя файла <Тип>_<10 цифр>.xml), сборка ссылки на
                      приложение тестирования (mt_v2).

   Библиотека не зависит от UI редактора: содержимое — произвольный текст
   (обычно Moodle XML), все события отдаются подписчикам через api.on().

   Подключение:
     <script src="file-api.js"></script>
     const api = FilesApi.create({ gistFilename: 'quiz.xml' });
   ========================================================================= */

(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();          // CommonJS (Node, сборщики)
    } else {
        root.FilesApi = factory();           // глобальная переменная (браузер)
    }
})(typeof self !== 'undefined' ? self : this, function () {

    const VERSION = '1.1.0';
    const GITHUB_API = 'https://api.github.com';
    const GITVERSE_API = 'https://gitverse.ru/api/v2';
    // Приложение тестирования: ссылка собирается из raw-ссылки опубликованного XML
    const DEFAULT_TEST_APP_URL = 'https://tregubovvn.github.io/mt_v2/index.html';
    // Собственный сервер публикации (PHP-эндпоинт из server/publish.php)
    const DEFAULT_SERVER_ENDPOINT = 'https://tregubovvn.ru/publish.php';
    const DEFAULT_SERVER_FOLDER = 'Task_Arhive';
    const DEFAULT_SERVER_BASE_URL = 'https://tregubovvn.ru';
    const DEFAULT_TASK_TYPES = ['ReadTest', 'MoodleTest', 'FormulaTest'];

    const DEFAULTS = {
        gistFilename: 'quiz.xml',     // имя файла внутри Gist
        fileName: 'quiz.xml',         // базовое имя файла на диске
        accept: { 'text/xml': ['.xml'], 'application/xml': ['.xml'] },
        autoSaveDebounceMs: 1500,     // задержка автосохранения после изменений
        storagePrefix: 'moodleFileApi',
        testAppUrl: DEFAULT_TEST_APP_URL,
        // --- Публикация на собственный сервер (server/publish.php) ---
        serverEndpoint: DEFAULT_SERVER_ENDPOINT,   // адрес PHP-эндпоинта
        serverFolder: DEFAULT_SERVER_FOLDER,       // папка архива на сервере
        serverBaseUrl: DEFAULT_SERVER_BASE_URL,    // адрес сайта (для публичной ссылки на файл)
        serverExt: '.xml',                         // расширение файла на сервере
        taskTypes: DEFAULT_TASK_TYPES,             // допустимые типы задания (префикс имени файла)
        defaultTaskType: 'ReadTest',
        validate: null,               // (content) => null | 'причина отказа' | false
        beforePublish: null,          // (content) => null | 'причина отказа' | false | {ok, reason}
    };

    class FilesApiError extends Error {
        constructor(message, code) {
            super(message);
            this.name = 'FilesApiError';
            this.code = code || 'ERROR';
        }
    }

    /* ---------- Служебные функции (без привязки к экземпляру) ---------- */

    // localStorage с запасным вариантом в памяти (Node, приватные режимы и т.п.)
    function safeStorage() {
        try {
            const t = '__mfa_probe__';
            globalThis.localStorage.setItem(t, '1');
            globalThis.localStorage.removeItem(t);
            return globalThis.localStorage;
        } catch (e) {
            const mem = new Map();
            return {
                getItem: k => (mem.has(k) ? mem.get(k) : null),
                setItem: (k, v) => mem.set(k, String(v)),
                removeItem: k => mem.delete(k),
            };
        }
    }

    // base64 из Unicode-строки (для GitVerse). Порциями — чтобы не переполнить
    // стек на больших файлах (в отличие от String.fromCharCode(...bytes)).
    function btoaUtf8(str) {
        const bytes = new TextEncoder().encode(String(str || ''));
        if (typeof btoa === 'function') {
            let bin = '';
            const CHUNK = 0x8000;
            for (let i = 0; i < bytes.length; i += CHUNK) {
                bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
            }
            return btoa(bin);
        }
        if (typeof Buffer === 'function') return Buffer.from(bytes).toString('base64');
        throw new FilesApiError('Среда не поддерживает base64-кодирование', 'NO_BASE64');
    }

    // Человекочитаемое описание HTTP-ошибки (текст/JSON из ответа).
    // ВАЖНО: если тело ответа уже прочитано (res.json() выше), передайте
    // разобранный объект вторым аргументом — иначе detail будет пустым.
    async function describeHttpError(res, parsed) {
        if (!res) return '';
        const fromParsed = parsed && (parsed.message || parsed.error);
        if (fromParsed) return `HTTP ${res.status}: ${fromParsed}`;
        if (typeof res.text !== 'function') return `HTTP ${res.status}`;
        let detail = '';
        try {
            const text = await res.text();
            try {
                const j = JSON.parse(text);
                detail = j.message || j.error || text.slice(0, 120);
            } catch (e) { detail = text.slice(0, 120); }
        } catch (e) { /* тело недоступно — игнорируем */ }
        return `HTTP ${res.status}${detail ? ': ' + detail : ''}`;
    }

    // Очистка имени файла от запрещённых символов
    function sanitizeFileName(name, fallback) {
        return String(name || '').replace(/[\\/:*?"<>|]+/g, '_').trim().slice(0, 80) || (fallback || 'quiz');
    }

    function withXmlExt(name) {
        return /\.xml$/i.test(name) ? name : name + '.xml';
    }

    // Случайный суффикс из 10 цифр для имени файла на сервере
    // (первая цифра 1–9, чтобы число гарантированно было 10-значным)
    function randomTaskNumber() {
        let s = String(1 + Math.floor(Math.random() * 9));
        for (let i = 1; i < 10; i++) s += String(Math.floor(Math.random() * 10));
        return s;
    }

    // Публичная ссылка на файл, лежащий в папке архива на сервере
    function buildServerFileUrl(baseUrl, folder, fileName) {
        const base = String(baseUrl || '').replace(/\/+$/, '');
        if (!base) return '';
        const dir = String(folder || '').replace(/^\/+|\/+$/g, '');
        return (dir ? base + '/' + dir : base) + '/' + fileName;
    }

    // Извлечение ID Gist из ссылки (gist.github.com/user/id, raw-ссылка,
    // ссылка приложения тестирования с ?name=<raw>, ?file=…) или из самого ID
    function extractGistId(input) {
        input = String(input || '').trim();
        if (!input) return null;
        // Если передали ссылку приложения — достаём raw-ссылку из параметра name/file
        try {
            const u = new URL(input);
            const f = u.searchParams.get('name') || u.searchParams.get('file');
            if (f) input = f;
        } catch (e) { /* не URL — работаем как со строкой */ }
        const m = input.match(/(?:gist\.github\.com|gist\.githubusercontent\.com)\/(?:[^/\s]+\/)?([0-9a-f]{7,})/i);
        if (m) return m[1];
        if (/^[0-9a-f]{7,}$/i.test(input)) return input;
        return null;
    }

    function isFsAccessSupported() {
        return typeof window !== 'undefined' &&
            typeof window.showOpenFilePicker === 'function' &&
            typeof window.showSaveFilePicker === 'function';
    }

    // Сборка ссылки на приложение тестирования из raw-ссылки на XML и флагов.
    // Названия флагов согласованы с mt_v2 (getUrlFlag): checkmode, headershow,
    // crushmode, randommode.
    function buildTaskUrlStatic(rawUrl, flags, baseUrl) {
        const base = String(baseUrl || '').trim();
        if (!rawUrl || !base) return '';
        let f = '';
        flags = flags || {};
        if (flags.checkmode) f += '&checkmode=true';
        if (flags.headershow) f += '&headershow=true';
        if (flags.crushmode) f += '&crushmode=true';
        if (flags.randommode) f += '&randommode=true';
        return base + (base.includes('?') ? '&' : '?') + 'name=' + encodeURIComponent(rawUrl) + f;
    }

    /* ====================== Фабрика экземпляра API ====================== */

    function create(options = {}) {
        const config = Object.assign({}, DEFAULTS, options);
        const store = safeStorage();
        const K = {
            gh: config.storagePrefix + '_gh_token',
            gv: config.storagePrefix + '_gv_token',
            srv: config.storagePrefix + '_srv_password',
            autosave: config.storagePrefix + '_autosave',
            lastSave: config.storagePrefix + '_last_save_time',
            gvProject: config.storagePrefix + '_gv_project',
        };

        const state = {
            content: '',
            fileName: config.fileName,
            dirty: false,                 // есть изменения, не записанные на диск
            fileHandle: null,             // FileSystemFileHandle выбранного файла
            autosaveEnabled: store.getItem(K.autosave) === '1',
            autoSaveTimeout: null,
            lastSaveTime: parseInt(store.getItem(K.lastSave) || '0', 10) || null,
            // Публикация
            gistId: null,
            gistUrl: null,
            gistFilename: config.gistFilename,
            rawUrl: null,
            gitverseProject: null,
            gitverseRawUrl: null,
            serverEndpoint: config.serverEndpoint,
            lastPublish: null,            // {target, url, rawUrl, content, at, ...}
            listeners: {},                // событие -> Set<fn>
        };

        /* ------------------------- События ------------------------- */

        function emit(event, payload) {
            const set = state.listeners[event];
            if (!set) return;
            set.forEach(fn => {
                try { fn(payload); } catch (e) {
                    if (typeof console !== 'undefined') console.error('[FilesApi] ошибка подписчика "' + event + '":', e);
                }
            });
        }

        function status(message) { emit('status', { message }); }

        // Единая точка ошибки: создаёт FilesApiError и БРОСАЕТ её.
        // Вызывающий код обязан перехватить (try/catch или .catch).
        function fail(err, context) {
            const e = err instanceof Error ? err : new FilesApiError(String(err));
            if (context) e.context = context;
            throw e;
        }

        function hasDom() { return typeof document !== 'undefined'; }

        /* --------------------- Работа с файлами --------------------- */

        // Проверка/запрос права записи в файл (File System Access API)
        async function ensureFilePermission(handle, requestWrite = true) {
            if (!handle || !handle.queryPermission) return true;   // Firefox и т.п.
            try {
                const opts = { mode: 'readwrite' };
                let st = await handle.queryPermission(opts);
                if (st === 'granted') return true;
                if (!requestWrite) return false;
                st = await handle.requestPermission(opts);
                return st === 'granted';
            } catch (e) {
                return false;
            }
        }

        async function writeFileHandle(handle, content) {
            const writable = await handle.createWritable();
            await writable.write(content);
            await writable.close();
        }

        // Скачивание как fallback для браузеров без File System Access API
        function downloadBlob(content, fileName) {
            if (!hasDom()) fail(new FilesApiError('Скачивание доступно только в браузере', 'DOM_REQUIRED'), 'download');
            const blob = new Blob([content], { type: 'text/xml;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = fileName;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        }

        // Общая фиксация успешной записи на диск (ручное или автосохранение)
        function recordDiskSave() {
            state.lastSaveTime = Date.now();
            try { store.setItem(K.lastSave, String(state.lastSaveTime)); } catch (e) { /* ignore */ }
        }

        function finishDiskSave(method, fileName) {
            state.dirty = false;
            recordDiskSave();
            emit('dirty-change', { dirty: false });
            emit('save', { method, fileName, at: state.lastSaveTime, content: state.content });
            status('Сохранено на диск (' + method + '): ' + fileName);
        }

        /* ==================== СОДЕРЖИМОЕ ==================== */

        // Установить содержимое. Без {silent:true} помечает задание изменённым
        // (dirty), эмитит 'content-change' и планирует автосохранение.
        function setContent(text, opts2 = {}) {
            state.content = String(text ?? '');
            if (opts2.fileName) state.fileName = sanitizeFileName(opts2.fileName, 'quiz');
            if (!opts2.silent) {
                state.dirty = true;
                emit('content-change', { content: state.content, fileName: state.fileName });
                emit('dirty-change', { dirty: true });
                scheduleAutosave();
            }
            return state.content;
        }

        /* ==================== ЗАГРУЗКА ==================== */

        // Загрузка из файла на диске. Файл становится «рабочим»: дальнейшие
        // сохранения (ручные и автосохранение) пишутся именно в него.
        async function loadFromFile(opts2 = {}) {
            let handle = null;
            let content = null;
            let fileName = null;

            if (hasDom() && typeof window.showOpenFilePicker === 'function' && opts2.fsAccess !== false) {
                try {
                    [handle] = await window.showOpenFilePicker({
                        multiple: false,
                        types: [{ description: 'XML-задание', accept: config.accept }],
                    });
                } catch (e) {
                    if (e && e.name === 'AbortError') { status('Выбор файла отменён'); return null; }
                    // прочие ошибки — падаем на <input type="file">
                }
            }

            if (!handle) {
                const picked = await pickFileViaInput();
                if (!picked) { status('Выбор файла отменён'); return null; }
                content = picked.content;
                fileName = picked.name;
            } else {
                if (!(await ensureFilePermission(handle, true))) {
                    fail(new FilesApiError('Нет доступа на запись к выбранному файлу', 'PERMISSION'), 'loadFromFile');
                }
                const fileObj = await handle.getFile();
                content = await fileObj.text();
                fileName = handle.name;
            }

            const result = await applyLoadedContent(content, fileName, { source: 'file', handle });
            if (handle) emit('file-selected', { fileName: handle.name });
            return result;
        }

        // Fallback: стандартный <input type="file">
        function pickFileViaInput() {
            return new Promise((resolve) => {
                if (!hasDom()) return resolve(null);
                const input = document.createElement('input');
                input.type = 'file';
                input.accept = '.xml,text/xml,application/xml';
                input.style.display = 'none';
                document.body.appendChild(input);
                let settled = false;
                const finish = (val) => {
                    if (settled) return;
                    settled = true;
                    input.remove();
                    window.removeEventListener('focus', onFocus);
                    resolve(val);
                };
                input.addEventListener('change', async () => {
                    const f = input.files && input.files[0];
                    if (!f) return finish(null);
                    finish({ name: f.name, content: await f.text() });
                });
                // Отмена диалога в некоторых браузерах отслеживается фокусом окна
                const onFocus = () => setTimeout(() => {
                    if (!input.files || !input.files.length) finish(null);
                }, 500);
                window.addEventListener('focus', onFocus);
                input.click();
            });
        }

        // Загрузка из GitHub Gist. Принимает ссылку на Gist, raw-ссылку или ID.
        // Приватные Gist требуют GitHub Token (публичные читаются и без него).
        async function loadFromGist(ref, opts2 = {}) {
            const token = opts2.token !== undefined ? opts2.token : getToken('github');
            const id = extractGistId(ref);
            if (!id) fail(new FilesApiError('Не удалось определить ID Gist по ссылке: ' + ref, 'BAD_REF'), 'loadFromGist');

            status('Загрузка Gist ' + id + '…');
            let res, data;
            try {
                res = await fetch(GITHUB_API + '/gists/' + id,
                    token ? { headers: { Authorization: 'Bearer ' + token } } : {});
                data = await res.json().catch(() => ({}));
            } catch (e) {
                fail(new FilesApiError('Сеть: ' + e.message, 'NETWORK'), 'loadFromGist');
            }
            if (!res.ok) fail(new FilesApiError(await describeHttpError(res, data), 'HTTP'), 'loadFromGist');

            const files = data.files || {};
            let fileName = null;
            if (files[config.gistFilename]) {
                fileName = config.gistFilename;
            } else {
                const names = Object.keys(files);
                fileName = names.find(n => /\.xml$/i.test(n)) || names[0];
            }
            const file = files[fileName];
            if (!file) fail(new FilesApiError('В Gist нет файлов', 'EMPTY'), 'loadFromGist');

            if (typeof file.content !== 'string' && file.raw_url) {
                // содержимое не вложено в ответ — читаем по raw-ссылке
                try {
                    const rawRes = await fetch(file.raw_url);
                    if (!rawRes.ok) fail(new FilesApiError('HTTP ' + rawRes.status + ' при чтении файла Gist', 'HTTP'), 'loadFromGist');
                    file.content = await rawRes.text();
                } catch (e) {
                    if (e instanceof FilesApiError) fail(e, 'loadFromGist');
                    fail(new FilesApiError('Сеть: ' + e.message, 'NETWORK'), 'loadFromGist');
                }
            }

            return await applyLoadedContent(file.content, fileName, {
                source: 'gist',
                gist: {
                    gistId: data.id,
                    gistUrl: data.html_url || ('https://gist.github.com/' + data.id),
                    fileName,
                    rawUrl: file.raw_url || null,
                    description: data.description || '',
                },
            });
        }

        // Общая обработка загруженного содержимого: проверка -> состояние -> событие
        async function applyLoadedContent(content, fileName, meta) {
            if (!content || !String(content).trim()) {
                fail(new FilesApiError('Файл пуст', 'EMPTY'), 'load:' + meta.source);
            }
            if (typeof config.validate === 'function') {
                let v = null;
                try { v = config.validate(content); } catch (e) { v = 'Ошибка проверки содержимого: ' + e.message; }
                if (v === false) v = 'Содержимое не прошло проверку validate';
                if (typeof v === 'string' && v) {
                    fail(new FilesApiError(v, 'VALIDATION'), 'load:' + meta.source);
                }
            }

            state.content = String(content);
            if (fileName) state.fileName = sanitizeFileName(fileName, 'quiz');
            if (meta.handle !== undefined) state.fileHandle = meta.handle;
            if (meta.gist) {
                state.gistId = meta.gist.gistId;
                state.gistUrl = meta.gist.gistUrl;
                state.gistFilename = meta.gist.fileName;
                state.rawUrl = meta.gist.rawUrl;
                state.lastPublish = {
                    target: 'gist', url: state.gistUrl, rawUrl: state.rawUrl,
                    content: state.content, at: Date.now(),
                };
            }
            state.dirty = false;

            const payload = {
                source: meta.source,
                fileName: state.fileName,
                content: state.content,
                gist: meta.gist || null,
            };
            emit('load', payload);
            status('Загружено (' + meta.source + '): ' + state.fileName);
            return payload;
        }

        /* ==================== СОХРАНЕНИЕ ==================== */

        // Сохранение на диск. Порядок: уже выбранный файл -> диалог сохранения
        // (File System Access API) -> скачивание (Firefox/Safari).
        async function saveToFile(opts2 = {}) {
            const suggested = withXmlExt(sanitizeFileName(opts2.fileName || state.fileName, 'quiz'));

            // 1. Файл уже выбран — пишем прямо в него, без диалогов
            if (state.fileHandle && await ensureFilePermission(state.fileHandle)) {
                try {
                    await writeFileHandle(state.fileHandle, state.content);
                    finishDiskSave('handle', state.fileHandle.name);
                    return { ok: true, method: 'handle', fileName: state.fileHandle.name };
                } catch (e) { /* запись не удалась — пробуем диалог */ }
            }

            // 2. Диалог выбора места сохранения (Chrome/Edge). Файл запоминается:
            //    дальше автосохранение пишет в него без вопросов.
            if (hasDom() && typeof window.showSaveFilePicker === 'function' && opts2.fsAccess !== false) {
                try {
                    const handle = await window.showSaveFilePicker({
                        suggestedName: suggested,
                        types: [{ description: 'XML', accept: config.accept }],
                    });
                    await writeFileHandle(handle, state.content);
                    state.fileHandle = handle;
                    state.fileName = sanitizeFileName(handle.name, 'quiz');
                    emit('file-selected', { fileName: handle.name });
                    finishDiskSave('picker', handle.name);
                    return { ok: true, method: 'picker', fileName: handle.name };
                } catch (e) {
                    if (e && e.name === 'AbortError') { status('Сохранение отменено'); return { ok: false, method: 'cancelled', fileName: suggested }; }
                    // прочие ошибки — падаем на скачивание
                }
            }

            // 3. Браузер без File System Access API — стандартное скачивание
            downloadBlob(state.content, suggested);
            state.fileName = sanitizeFileName(suggested, 'quiz');
            finishDiskSave('download', suggested);
            return { ok: true, method: 'download', fileName: suggested };
        }

        /* --------------------- Автосохранение --------------------- */

        function setAutosave(enabled) {
            state.autosaveEnabled = !!enabled;
            try { store.setItem(K.autosave, enabled ? '1' : '0'); } catch (e) { /* ignore */ }
            emit('autosave-change', { enabled: state.autosaveEnabled });
            status(state.autosaveEnabled
                ? 'Автосохранение на диск включено'
                : 'Автосохранение выключено');
            if (state.autosaveEnabled && state.dirty) scheduleAutosave();
        }

        function scheduleAutosave() {
            clearTimeout(state.autoSaveTimeout);
            if (!state.autosaveEnabled) return;
            if (!state.fileHandle) {
                // Файл ещё не выбран — НЕ скачиваем молча новые файлы, а один раз
                // просим выбрать файл: дальше изменения пишутся в него сами.
                emit('autosave-skip', { reason: 'NO_FILE' });
                status('Автосохранение: нажмите «Сохранить в файл» и выберите файл — изменения будут записываться в него автоматически');
                return;
            }
            state.autoSaveTimeout = setTimeout(autoSaveToDisk, config.autoSaveDebounceMs);
        }

        // Автосохранение выполняется ТОЛЬКО в выбранный файл на диске.
        // Публикация на сервисы — только явным вызовом publishTo…().
        async function autoSaveToDisk() {
            if (!state.fileHandle) return;
            try {
                if (!(await ensureFilePermission(state.fileHandle))) {
                    state.fileHandle = null;   // доступ потерян (перезагрузка страницы)
                    emit('autosave-skip', { reason: 'NO_PERMISSION' });
                    status('Автосохранение приостановлено: выберите файл через «Сохранить в файл»');
                    return;
                }
                await writeFileHandle(state.fileHandle, state.content);
                state.dirty = false;
                recordDiskSave();
                emit('dirty-change', { dirty: false });
                emit('autosave', { fileName: state.fileHandle.name, at: state.lastSaveTime, content: state.content });
                status('Автосохранено на диск: ' + state.fileHandle.name + ' в ' + new Date().toLocaleTimeString());
            } catch (e) {
                emit('error', { error: e, context: 'autosave' });
                status('Ошибка автосохранения: ' + e.message);
            }
        }

        /* ==================== ПУБЛИКАЦИЯ ==================== */

        // Хук проверки перед публикацией (например, «у всех вопросов выбран
        // правильный ответ»). null/true — можно публиковать.
        function runBeforePublish() {
            if (typeof config.beforePublish !== 'function') return null;
            let r = null;
            try { r = config.beforePublish(state.content); } catch (e) {
                return 'Ошибка проверки перед публикацией: ' + e.message;
            }
            if (r === false) return 'Публикация заблокирована проверкой beforePublish';
            if (typeof r === 'string' && r) return r;
            if (r && typeof r === 'object') {
                if (r.ok === false) return r.reason || 'Публикация заблокирована проверкой beforePublish';
            }
            return null;
        }

        // GitHub Gist: если Gist уже привязан (загружен или публиковался) —
        // обновляем его, иначе создаём новый приватный.
        async function publishToGist(opts2 = {}) {
            const blocked = runBeforePublish();
            if (blocked) fail(new FilesApiError(blocked, 'VALIDATION'), 'publishToGist');

            const token = opts2.token !== undefined ? opts2.token : getToken('github');
            if (!token) {
                fail(new FilesApiError('Не задан GitHub Token — вызовите setToken("github", "ghp_…")', 'GITHUB_TOKEN_REQUIRED'), 'publishToGist');
            }

            const updating = !!(opts2.gistId || state.gistId);
            const filename = opts2.gistFilename || (updating ? state.gistFilename : config.gistFilename);
            const description = opts2.description || 'Moodle XML Quiz';
            const url = updating
                ? GITHUB_API + '/gists/' + (opts2.gistId || state.gistId)
                : GITHUB_API + '/gists';

            status(updating ? 'Обновление Gist…' : 'Создание нового Gist…');
            let res, data;
            try {
                res = await fetch(url, {
                    method: updating ? 'PATCH' : 'POST',
                    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        description,
                        public: false,
                        files: { [filename]: { content: state.content } },
                    }),
                });
                data = await res.json().catch(() => ({}));
            } catch (e) {
                fail(new FilesApiError('Сеть: ' + e.message, 'NETWORK'), 'publishToGist');
            }
            if (!res.ok) fail(new FilesApiError(await describeHttpError(res, data), 'HTTP'), 'publishToGist');

            state.gistId = data.id;
            state.gistUrl = data.html_url || ('https://gist.github.com/' + data.id);
            state.gistFilename = filename;
            const fd = data.files && data.files[filename];
            state.rawUrl = (fd && fd.raw_url) || null;
            state.lastPublish = {
                target: 'gist', url: state.gistUrl, rawUrl: state.rawUrl,
                content: state.content, at: Date.now(), gistId: data.id,
            };
            state.dirty = false;

            const result = {
                target: 'gist',
                gistId: state.gistId,
                gistUrl: state.gistUrl,
                rawUrl: state.rawUrl,
                taskUrl: getTaskUrl(),
            };
            emit('publish', result);
            status((updating ? 'Обновлено в Gist: ' : 'Опубликовано в Gist: ') + state.gistUrl);
            return result;
        }

        // GitVerse: коммит XML-файла в репозиторий. Репозиторий берётся из opts,
        // иначе из запомненного, иначе выбирается автоматически (предпочтение —
        // репозитории с moodle/quiz/test в названии).
        async function publishToGitverse(opts2 = {}) {
            const blocked = runBeforePublish();
            if (blocked) fail(new FilesApiError(blocked, 'VALIDATION'), 'publishToGitverse');

            const token = opts2.token !== undefined ? opts2.token : getToken('gitverse');
            if (!token) {
                fail(new FilesApiError('Не задан токен GitVerse — вызовите setToken("gitverse", "…")', 'GITVERSE_TOKEN_REQUIRED'), 'publishToGitverse');
            }

            const headers = { Authorization: 'Token ' + token, 'Content-Type': 'application/json' };
            const fileName = withXmlExt(sanitizeFileName(opts2.fileName || state.fileName, 'quiz'));
            status('Публикация на GitVerse…');

            // 1. Найти репозиторий для публикации
            let project = String(opts2.repo || store.getItem(K.gvProject) || '').trim();
            if (!project) {
                let resList;
                try {
                    resList = await fetch(GITVERSE_API + '/user/repos?per_page=100', { headers });
                } catch (e) {
                    fail(new FilesApiError('Сеть: ' + e.message, 'NETWORK'), 'publishToGitverse');
                }
                if (!resList.ok) fail(new FilesApiError(await describeHttpError(resList), 'HTTP'), 'publishToGitverse');
                const list = await resList.json().catch(() => ({}));
                const items = Array.isArray(list) ? list : (list.items || list.data || []);
                const preferred = items.find(p => /moodle|quiz|test/i.test(p.path || p.name || '')) || items[0];
                if (!preferred) {
                    fail(new FilesApiError('На GitVerse нет ни одного репозитория — создайте любой и повторите', 'NO_REPO'), 'publishToGitverse');
                }
                project = preferred.path || preferred.full_path || preferred.name;
                try { store.setItem(K.gvProject, project); } catch (e) { /* ignore */ }
            }

            // 2. Проверка существования файла (нужен blob_id для обновления)
            let branch = opts2.branch || 'master';
            let existingBlob = null;
            let resFile;
            const fileUrl = GITVERSE_API + '/repos/' + project + '/contents/' + encodeURIComponent(fileName);
            try {
                resFile = await fetch(fileUrl, { headers });
            } catch (e) {
                fail(new FilesApiError('Сеть: ' + e.message, 'NETWORK'), 'publishToGitverse');
            }
            if (resFile.ok) {
                const info = await resFile.json().catch(() => ({}));
                existingBlob = info.blob_id || info.sha || null;
                if (!opts2.branch && info.branch) branch = info.branch;
            } else if (resFile.status !== 404) {
                fail(new FilesApiError(await describeHttpError(resFile), 'HTTP'), 'publishToGitverse');
            }

            // 3. Создать или обновить файл
            const body = {
                content: btoaUtf8(state.content),
                commit_message: opts2.message ||
                    (existingBlob ? 'Обновление' : 'Публикация') + ' XML-файла: ' + (opts2.description || fileName),
                branch,
            };
            if (existingBlob) body.blob_id = existingBlob;

            let res;
            try {
                res = await fetch(fileUrl, {
                    method: existingBlob ? 'PUT' : 'POST',
                    headers,
                    body: JSON.stringify(body),
                });
            } catch (e) {
                fail(new FilesApiError('Сеть: ' + e.message, 'NETWORK'), 'publishToGitverse');
            }
            if (!res.ok) fail(new FilesApiError(await describeHttpError(res), 'HTTP'), 'publishToGitverse');

            state.gitverseProject = project;
            state.gitverseRawUrl = 'https://gitverse.ru/' + project + '/raw/branch/' + branch + '/' + encodeURIComponent(fileName);
            state.lastPublish = {
                target: 'gitverse', url: state.gitverseRawUrl, rawUrl: state.gitverseRawUrl,
                content: state.content, at: Date.now(), project, branch, fileName,
            };
            state.dirty = false;

            const result = {
                target: 'gitverse',
                project, branch, fileName,
                rawUrl: state.gitverseRawUrl,
                taskUrl: getTaskUrl(),
            };
            emit('publish', result);
            status('Опубликовано на GitVerse (' + project + ')');
            return result;
        }

        // Публикация на собственном сервере (PHP-эндпоинт из server/publish.php).
        // Файл <Тип>_<10 цифр>.xml уходит на эндпоинт, тот кладёт его в папку
        // архива заданий. Доступ защищён паролем: api.setToken('server', '…').
        async function publishToServer(opts2 = {}) {
            const blocked = runBeforePublish();
            if (blocked) fail(new FilesApiError(blocked, 'VALIDATION'), 'publishToServer');

            const password = opts2.password !== undefined ? String(opts2.password) : getToken('server');
            if (!password) {
                fail(new FilesApiError('Не задан пароль сервера — вызовите setToken("server", "…") или передайте {password}', 'SERVER_PASSWORD_REQUIRED'), 'publishToServer');
            }

            const endpoint = String(opts2.endpoint || config.serverEndpoint || '').trim();
            if (!endpoint) {
                fail(new FilesApiError('Не задан адрес эндпоинта сервера (serverEndpoint)', 'SERVER_URL_REQUIRED'), 'publishToServer');
            }

            const types = Array.isArray(config.taskTypes) && config.taskTypes.length ? config.taskTypes : DEFAULT_TASK_TYPES;
            const taskType = String(opts2.taskType || config.defaultTaskType || types[0]);
            if (!types.includes(taskType)) {
                fail(new FilesApiError('Неизвестный тип задания: ' + taskType + ' (допустимо: ' + types.join(', ') + ')', 'VALIDATION'), 'publishToServer');
            }

            const folder = String(opts2.folder || config.serverFolder || '').trim();
            const fileName = opts2.fileName
                ? withXmlExt(sanitizeFileName(opts2.fileName, taskType))
                : taskType + '_' + randomTaskNumber() + String(config.serverExt || '.xml');

            status('Публикация на сервер…');
            let res, data;
            try {
                res = await fetch(endpoint, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        action: 'publish',
                        password,
                        folder,
                        fileName,
                        content: state.content,
                        description: String(opts2.description || ''),
                    }),
                });
                data = await res.json().catch(() => ({}));
            } catch (e) {
                fail(new FilesApiError('Сеть: ' + e.message + ' — проверьте адрес эндпоинта и HTTPS', 'NETWORK'), 'publishToServer');
            }
            if (!res.ok) {
                const code = (res.status === 401 || res.status === 403) ? 'SERVER_AUTH' : 'HTTP';
                fail(new FilesApiError(await describeHttpError(res, data), code), 'publishToServer');
            }

            // Сервер возвращает url (считаем его истиной); иначе собираем ссылку сами
            const rawUrl = (typeof data.url === 'string' && data.url) ||
                buildServerFileUrl(config.serverBaseUrl, folder, fileName);
            state.serverEndpoint = endpoint;
            state.lastPublish = {
                target: 'server', url: rawUrl, rawUrl,
                content: state.content, at: Date.now(),
                endpoint, folder, fileName, taskType,
            };
            state.dirty = false;

            const result = {
                target: 'server',
                fileName,
                taskType,
                rawUrl,
                taskUrl: getTaskUrl(),
                updated: data.updated === true,
            };
            emit('publish', result);
            status((result.updated ? 'Обновлено на сервере: ' : 'Опубликовано на сервере: ') + rawUrl);
            return result;
        }

        // Список файлов в папке архива на сервере (действие list того же эндпоинта)
        async function listServerFiles(opts2 = {}) {
            const password = opts2.password !== undefined ? String(opts2.password) : getToken('server');
            if (!password) {
                fail(new FilesApiError('Не задан пароль сервера — вызовите setToken("server", "…")', 'SERVER_PASSWORD_REQUIRED'), 'listServerFiles');
            }
            const endpoint = String(opts2.endpoint || config.serverEndpoint || '').trim();
            if (!endpoint) {
                fail(new FilesApiError('Не задан адрес эндпоинта сервера (serverEndpoint)', 'SERVER_URL_REQUIRED'), 'listServerFiles');
            }
            const folder = String(opts2.folder || config.serverFolder || '').trim();

            status('Запрос списка файлов с сервера…');
            let res, data;
            try {
                res = await fetch(endpoint, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'list', password, folder }),
                });
                data = await res.json().catch(() => ({}));
            } catch (e) {
                fail(new FilesApiError('Сеть: ' + e.message, 'NETWORK'), 'listServerFiles');
            }
            if (!res.ok) {
                const code = (res.status === 401 || res.status === 403) ? 'SERVER_AUTH' : 'HTTP';
                fail(new FilesApiError(await describeHttpError(res, data), code), 'listServerFiles');
            }
            const files = Array.isArray(data.files) ? data.files : [];
            status('На сервере файлов: ' + files.length);
            return { files, url: data.url || null };
        }

        // Отвязать публикацию: следующий publishTo…() создаст новый Gist/файл
        function resetPublishState() {
            state.gistId = null;
            state.gistUrl = null;
            state.gistFilename = config.gistFilename;
            state.rawUrl = null;
            state.gitverseProject = null;
            state.gitverseRawUrl = null;
            state.lastPublish = null;
            emit('publish-reset', {});
            status('Привязка публикации сброшена — следующая публикация создаст новый Gist/файл');
        }

        /* ---------------- Ссылка на приложение тестирования ---------------- */

        // Ссылка на тест по raw-ссылке опубликованного XML (Gist или GitVerse)
        function getTaskUrl(flags) {
            const lp = state.lastPublish;
            if (!lp) return '';
            const raw = lp.rawUrl || lp.url || null;
            return buildTaskUrlStatic(raw, flags, config.testAppUrl);
        }

        /* --------------------------- Токены --------------------------- */

        function tokenKey(service) {
            if (service === 'github') return K.gh;
            if (service === 'gitverse') return K.gv;
            if (service === 'server') return K.srv;
            fail(new FilesApiError('Неизвестный сервис токена: ' + service + ' (github | gitverse | server)', 'BAD_SERVICE'), 'setToken');
            return null;
        }

        function setToken(service, value) {
            const key = tokenKey(service);
            const v = String(value || '').trim();
            try { if (v) store.setItem(key, v); else store.removeItem(key); } catch (e) { /* ignore */ }
            emit('token-change', { service, has: !!v });
        }

        function getToken(service) {
            try { return store.getItem(tokenKey(service)) || ''; } catch (e) { return ''; }
        }

        function clearToken(service) { setToken(service, ''); }

        /* --------------------------- Состояние --------------------------- */

        // Опубликованный контент устарел (после публикации содержимое менялось)
        function isPublishedStale() {
            if (!state.lastPublish) return false;
            return state.content !== state.lastPublish.content;
        }

        /* ========================== Публичный API ========================== */

        const api = {
            version: VERSION,

            // --- Содержимое ---
            setContent,
            getContent: () => state.content,
            getFileName: () => state.fileName,
            setFileName(name) { state.fileName = sanitizeFileName(name, 'quiz'); },

            // --- Загрузка ---
            loadFromFile,          // (opts?) => {source,fileName,content}|null
            loadFromGist,          // (ref, opts?) => {source,fileName,content,gist}
            extractGistId,         // (ref) => id|null

            // --- Сохранение ---
            saveToFile,            // (opts?) => {ok,method,fileName}
            setAutosave,           // (enabled)
            isAutosaveEnabled: () => state.autosaveEnabled,
            scheduleAutosave,      // планирование вручную (после своих изменений)
            getLastSaveTime: () => state.lastSaveTime,

            // --- Публикация ---
            publishToGist,         // (opts?) => {target,gistId,gistUrl,rawUrl,taskUrl}
            publishToGitverse,     // (opts?) => {target,project,branch,fileName,rawUrl,taskUrl}
            publishToServer,       // (opts?) => {target,fileName,taskType,rawUrl,taskUrl}
            listServerFiles,       // (opts?) => {files:[{name,size,modified,url}],url}
            resetPublishState,     // ()
            buildTaskUrl(rawUrl, flags, baseUrl) {   // baseUrl по умолчанию — config.testAppUrl
                return buildTaskUrlStatic(rawUrl, flags, baseUrl || config.testAppUrl);
            },
            getTaskUrl,            // (flags?) => ссылка по последней публикации

            // --- Токены ---
            setToken,              // ('github'|'gitverse'|'server', value)
            getToken,              // ('github'|'gitverse'|'server') => string
            clearToken,            // ('github'|'gitverse'|'server')
            hasToken(service) { return !!getToken(service); },

            // --- Состояние ---
            isDirty: () => state.dirty,
            isPublishedStale,
            getLastPublish: () => state.lastPublish,
            getServerEndpoint: () => state.serverEndpoint || config.serverEndpoint,
            getGistInfo() {
                return { gistId: state.gistId, gistUrl: state.gistUrl, gistFilename: state.gistFilename, rawUrl: state.rawUrl };
            },

            // --- События: on/off; on() возвращает функцию отписки ---
            on(event, fn) {
                (state.listeners[event] = state.listeners[event] || new Set()).add(fn);
                return () => api.off(event, fn);
            },
            off(event, fn) {
                if (state.listeners[event]) state.listeners[event].delete(fn);
            },

            // --- Служебное ---
            config,
            destroy() {
                clearTimeout(state.autoSaveTimeout);
                state.listeners = {};
            },
        };

        return api;
    }

    return {
        create,
        VERSION,
        FilesApiError,
        isFsAccessSupported,
        extractGistId,
        buildTaskUrl: buildTaskUrlStatic,
    };
});
