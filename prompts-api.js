'use strict';

/* =========================================================================
   Prompts API — режимы (промпты) редакторов rt_v2 и mt_v2.

   Выделено из двух редакторов, где один и тот же код (загрузка промптов,
   разбор Markdown, добавление своих режимов, сохранение в Gist) был
   продублирован с мелкими отличиями.

   Модель:
     • Режим = промпт. Название режима — заголовок ПЕРВОГО уровня (# Название)
       в тексте промпта. Один файл prompts.md в одном GitHub Gist содержит
       все режимы: каждая секция начинается с «# Название».
     • Два базовых режима есть всегда. Их текст берётся из их собственных
       публичных Gist'ов (как в редакторах) и кэшируется в localStorage.
     • Без GitHub Token общий Gist недоступен: доступны только два базовых
       режима. Свои режимы добавляются и сохраняются только по токену.
     • Выбор режима переключает режим работы редактора: приложение читает
       активный промпт через getActivePrompt() и слушает событие mode-change.
     • Переключение выполняется в большом диалоговом окне (openDialog):
       выпадающий список режимов + просмотр текста промпта, который будет
       использован, + добавление/правка/удаление своих режимов.

   Подключение:
     <script src="prompts-api.js"></script>
     const prompts = PromptsApi.create({ preset: 'rt_v2', tokenProvider: () => token });
     await prompts.load();
     prompts.openDialog();
   ========================================================================= */

(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();          // CommonJS (Node, тесты)
    } else {
        root.PromptsApi = factory();         // глобальная переменная (браузер)
    }
})(typeof self !== 'undefined' ? self : this, function () {

    const VERSION = '1.0.0';
    const GITHUB_API = 'https://api.github.com';

    // Маркер формата: файл, записанный этой библиотекой, разбирается строго по
    // заголовкам первого уровня. Файлы без маркера с секциями «## Название»
    // читаются как старый формат (переходный период).
    const FORMAT_MARKER = '<!-- prompts-api: каждый режим — заголовок первого уровня -->';

    // Общий Gist со всеми режимами (тот же, что использовали редакторы).
    const DEFAULT_PROMPTS_GIST_URL = 'https://gist.github.com/tregubovvn/2f9804a3ad5439b1bb60957b8969826a';

    // Два базовых режима каждого редактора. id и короткое имя — для выбора
    // по умолчанию; показываемое имя берётся из заголовка H1 самого промпта.
    const PRESETS = {
        rt_v2: [
            { id: 'paragraphs', name: 'Абзацы', gistUrl: 'https://gist.github.com/tregubovvn/e837aa6949f0b20dee3925983ba2f424' },
            { id: 'proposals', name: 'Предложения', gistUrl: 'https://gist.github.com/tregubovvn/36b6169ed472e716084c8fbde5e31012' },
        ],
        mt_v2: [
            { id: 'formulas', name: 'Тесты с формулами', gistUrl: 'https://gist.github.com/tregubovvn/5abee72a0846a0481506b5947e0fb270' },
            { id: 'tasks', name: 'Создание задач', gistUrl: 'https://gist.github.com/tregubovvn/0637360f442f65ed457f133096a3c4b3' },
        ],
        // Режимы, которые лежали в общем Gist редакторов (старый формат «## »).
        legacy: [
            { id: 'paragraphs', name: 'Абзацы', gistUrl: 'https://gist.github.com/tregubovvn/e837aa6949f0b20dee3925983ba2f424' },
            { id: 'proposals', name: 'Предложения', gistUrl: 'https://gist.github.com/tregubovvn/36b6169ed472e716084c8fbde5e31012' },
            { id: 'extra', name: 'Дополнительный промпт', text: '' },
        ],
    };

    const DEFAULTS = {
        preset: null,                  // 'rt_v2' | 'mt_v2' — подставить базовые режимы
        builtins: [],                  // [{id, name, text?, gistUrl?}] — два базовых режима
        gistUrl: '',                   // ссылка на общий Gist ('' — взять сохранённую/по умолчанию)
        gistFilename: 'prompts.md',    // имя файла внутри Gist
        gistDescription: 'Режимы редактора: промпты в одном Gist',
        storagePrefix: 'moodlePromptsApi',
        tokenProvider: null,           // () => token — если токен живёт в настройках приложения
        includeBuiltinsInGist: true,   // писать базовые режимы в общий Gist (копия для полноты)
        dialogTitle: 'Режим работы редактора',
        dialogHint: 'Название режима — заголовок первого уровня его промпта. Выберите режим в списке, посмотрите промпт и нажмите «Применить режим».',
        onModeChange: null,            // (mode) => void, дублирует событие mode-change
        fetch: null,                   // подмена fetch (тесты, нестандартные окружения)
    };

    class PromptsApiError extends Error {
        constructor(message, code) {
            super(message);
            this.name = 'PromptsApiError';
            this.code = code || 'ERROR';
        }
    }

    /* ------------------------ Служебные функции ------------------------ */

    // localStorage с запасным вариантом в памяти (Node, приватный режим).
    function safeStorage() {
        try {
            const probe = '__prompts_api_probe__';
            globalThis.localStorage.setItem(probe, '1');
            globalThis.localStorage.removeItem(probe);
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

    // Заголовок режима: убираем решётки, лишние пробелы, ограничиваем длину.
    function cleanTitle(name) {
        return String(name === undefined || name === null ? '' : name)
            .replace(/^\s*#+\s*/, '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 160);
    }

    // Стабильный id режима по названию (кириллица разрешена).
    function promptIdFromTitle(title) {
        return String(title || '').toLowerCase().trim()
            .replace(/[^\p{L}\p{N}]+/gu, '-')
            .replace(/^-+|-+$/g, '');
    }

    function uniqueId(base, used) {
        const rootId = base || 'prompt';
        let id = rootId;
        let n = 2;
        while (used.has(id)) id = rootId + '-' + (n++);
        used.add(id);
        return id;
    }

    // Первая строка-заголовок первого уровня становится названием режима,
    // остальное — телом промпта. Так текст базового промпта (он начинается
    // с «# Промпт для создания заданий READ») даёт имя режима без дублирования
    // заголовка в теле.
    function splitTitle(text) {
        const lines = String(text === undefined || text === null ? '' : text)
            .replace(/^\uFEFF/, '')
            .split(/\r?\n/);
        let i = 0;
        // Пропускаем BOM, пустые строки и служебные комментарии в начале:
        // заголовок режима — первая содержательная строка текста.
        while (i < lines.length && (!lines[i].trim() || /^\s*<!--.*-->\s*$/.test(lines[i]))) i++;
        const m = i < lines.length ? /^#\s+(.+?)\s*$/.exec(lines[i]) : null;
        if (!m) return { title: '', body: String(text || '').trim() };
        return {
            title: m[1].trim(),
            body: lines.slice(i + 1).join('\n').trim(),
        };
    }

    // Внутренние заголовки первого уровня понижаются до второго: иначе они
    // читались бы как новые режимы и «разрезали» промпт на части.
    function demoteHeadings(text) {
        return String(text || '').replace(/^#(?=\s)/gm, '##');
    }

    function normalizeBody(text) {
        return demoteHeadings(String(text === undefined || text === null ? '' : text).trim());
    }

    // Разбор файла режимов. Новый формат: секции «# Название». Старый
    // (без маркера, с «## Название») поддерживается на переходный период.
    function parsePromptsMarkdown(md) {
        const text = String(md === undefined || md === null ? '' : md).replace(/^\uFEFF/, '');
        const isNewFormat = text.includes('prompts-api:') || !/^##\s+/m.test(text);
        const sections = [];
        const re = isNewFormat ? /^#\s+(.+?)\s*$/ : /^##\s+(.+?)\s*$/;
        let cur = null;
        text.split(/\r?\n/).forEach(line => {
            const m = re.exec(line);
            if (m) {
                if (cur) sections.push(cur);
                cur = { name: cleanTitle(m[1]), lines: [] };
                return;
            }
            if (cur) cur.lines.push(line);
        });
        if (cur) sections.push(cur);

        const used = new Set();
        return sections.map(sec => {
            const body = sec.lines.join('\n')
                .replace(/^\s*-{3,}\s*$/gm, '')   // разделители секций старого файла
                .trim();
            const inner = isNewFormat ? { title: '', body } : splitTitle(body);
            const name = sec.name || inner.title;
            return {
                id: uniqueId(promptIdFromTitle(name), used),
                name: name,
                text: isNewFormat ? body : inner.body,
                legacy: !isNewFormat,
            };
        }).filter(item => item.name);
    }

    // Сборка файла режимов: маркер + по секции на режим.
    function buildPromptsMarkdown(items) {
        const body = (items || []).map(item => {
            const name = cleanTitle(item.name) || cleanTitle(item.id) || 'Без названия';
            const text = demoteHeadings(String(item.text || '').trim());
            return '# ' + name + '\n\n' + text + '\n';
        }).join('\n');
        return FORMAT_MARKER + '\n\n' + body;
    }

    function gistIdFromRef(ref) {
        const s = String(ref || '').trim();
        if (!s) return '';
        if (/^[0-9a-f]{7,}$/i.test(s)) return s;
        const m = s.match(/(?:gist\.github\.com|gist\.githubusercontent\.com)\/(?:[^/\s]+\/)?([0-9a-f]{7,})/i);
        return m ? m[1] : '';
    }

    function escapeHtml(value) {
        return String(value === undefined || value === null ? '' : value)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function cloneMode(mode) {
        if (!mode) return null;
        return {
            id: mode.id,
            name: mode.name,
            text: mode.text,
            source: mode.source,
            builtin: !!mode.builtin,
            gistUrl: mode.gistUrl || '',
            chars: (mode.text || '').length,
        };
    }

    /* ------------------------- Фабрика экземпляра ------------------------- */

    function create(options = {}) {
        const config = Object.assign({}, DEFAULTS, options);
        if ((!config.builtins || !config.builtins.length) && config.preset && PRESETS[config.preset]) {
            config.builtins = PRESETS[config.preset];
        }

        const store = safeStorage();
        const K = {
            token: config.storagePrefix + '_gh_token',
            gist: config.storagePrefix + '_gist_url',
            mode: config.storagePrefix + '_mode',
            builtin: id => config.storagePrefix + '_builtin_' + id,
        };

        const builtinDefs = (config.builtins || []).map((b, i) => ({
            id: promptIdFromTitle(b.id || b.name) || ('builtin-' + (i + 1)),
            name: cleanTitle(b.name) || ('Базовый режим ' + (i + 1)),
            gistUrl: b.gistUrl || '',
            text: b.text || '',
        }));

        const state = {
            prompts: [],
            activeId: '',
            activeName: '',
            gistId: '',
            gistUrl: '',
            rawUrl: '',
            loaded: false,
            dirty: false,
            loadingPromise: null,
            saving: false,
            listeners: {},
            dialog: null,
            tokenOverride: null,   // токен, заданный в окне режимов: важнее tokenProvider
        };

        // Сохранённый выбор режима: {id, name} (id меняется при переименовании).
        try {
            const saved = JSON.parse(store.getItem(K.mode) || 'null');
            if (saved && typeof saved === 'object') {
                state.activeId = saved.id || '';
                state.activeName = saved.name || '';
            } else if (typeof saved === 'string') {
                state.activeId = saved;
            }
        } catch (e) { /* повреждённое значение игнорируем */ }

        // Явно переданный gistUrl (в том числе пустой — «Gist ещё нет»)
        // важнее сохранённого и значения по умолчанию.
        const explicitGist = Object.prototype.hasOwnProperty.call(options, 'gistUrl');
        const storedGist = String(store.getItem(K.gist) || '').trim();
        state.gistUrl = explicitGist
            ? String(options.gistUrl || '').trim()
            : (storedGist || DEFAULT_PROMPTS_GIST_URL);
        state.gistId = gistIdFromRef(state.gistUrl);

        const doFetch = config.fetch || ((...args) => fetch(...args));

        /* ------------------------------ События ------------------------------ */

        function emit(event, payload) {
            const set = state.listeners[event];
            if (set) {
                set.forEach(fn => {
                    try { fn(payload); } catch (e) {
                        if (typeof console !== 'undefined') console.error('[PromptsApi] подписчик "' + event + '":', e);
                    }
                });
            }
        }

        function status(message, isError) {
            emit('status', { message, error: !!isError });
        }

        function fail(code, message) {
            throw new PromptsApiError(message, code);
        }

        function on(event, fn) {
            if (typeof fn !== 'function') return () => {};
            (state.listeners[event] = state.listeners[event] || new Set()).add(fn);
            return () => state.listeners[event].delete(fn);
        }

        /* ------------------------------- Токен ------------------------------- */

        function getToken() {
            // Явно заданный в окне токен важнее настроек приложения (tokenProvider):
            // иначе поле токена в окне режимов было бы бесполезно.
            if (state.tokenOverride !== null) return state.tokenOverride;
            if (typeof config.tokenProvider === 'function') {
                try {
                    const fromProvider = String(config.tokenProvider() || '').trim();
                    if (fromProvider) return fromProvider;
                } catch (e) { /* провайдер недоступен — смотрим сохранённый */ }
            }
            return String(store.getItem(K.token) || '').trim();
        }

        function hasToken() { return !!getToken(); }

        function setToken(service, value) {
            if (service !== 'github') fail('BAD_SERVICE', 'Поддерживается только сервис "github"');
            const token = String(value || '').trim();
            state.tokenOverride = token;
            if (token) store.setItem(K.token, token); else store.removeItem(K.token);
            emit('token-change', { service: 'github', has: !!token });
            return !!token;
        }

        function clearToken() { return setToken('github', ''); }

        /* ------------------------------- Сеть ------------------------------- */

        function authHeaders(extra) {
            const headers = Object.assign({}, extra);
            const token = getToken();
            if (token) headers.Authorization = 'Bearer ' + token;
            return headers;
        }

        async function ghRequest(path, opts, context) {
            let res;
            try {
                res = await doFetch(GITHUB_API + path, opts);
            } catch (e) {
                fail('NETWORK', 'Сеть: ' + e.message + (context ? ' (' + context + ')' : ''));
            }
            let text = '';
            try { text = await res.text(); } catch (e) { text = ''; }
            let data = {};
            if (text) {
                try { data = JSON.parse(text) || {}; } catch (e) { data = {}; }
            }
            if (!res.ok) {
                const detail = (data && (data.message || data.error)) || ('HTTP ' + res.status);
                const code = (res.status === 401 || res.status === 403) ? 'TOKEN_INVALID'
                    : res.status === 404 ? 'NOT_FOUND' : 'HTTP';
                const err = new PromptsApiError('GitHub: ' + detail + ' (HTTP ' + res.status + ')', code);
                err.status = res.status;
                throw err;
            }
            return { data, text };
        }

        // Чтение файла режимов из Gist: сначала JSON API (там есть content),
        // для больших файлов — raw_url (content в ответе усечён).
        async function fetchGistFile(ref, context) {
            const id = gistIdFromRef(ref);
            if (!id) fail('BAD_REF', 'Не удалось определить ID Gist по ссылке: ' + ref);
            const { data } = await ghRequest('/gists/' + id, { headers: authHeaders() }, context);
            const files = data.files || {};
            const list = Object.keys(files).map(k => files[k]);
            if (!list.length) fail('EMPTY', 'В Gist нет файлов');
            const file = files[config.gistFilename]
                || list.find(f => /\.(md|markdown|txt)$/i.test(f.filename || ''))
                || list[0];
            let content = file.content || '';
            if (file.truncated && file.raw_url) {
                let raw;
                try {
                    raw = await doFetch(file.raw_url, { headers: authHeaders() });
                } catch (e) {
                    fail('NETWORK', 'Сеть: ' + e.message);
                }
                if (!raw.ok) fail('HTTP', 'HTTP ' + raw.status + ' при чтении файла Gist');
                content = await raw.text();
            }
            return {
                id: data.id,
                url: data.html_url || ('https://gist.github.com/' + data.id),
                rawUrl: file.raw_url || '',
                content: content,
                description: data.description || '',
            };
        }

        /* ---------------------------- Базовые режимы ---------------------------- */

        async function loadBuiltin(def, errors) {
            let text = '';
            const cacheKey = K.builtin(def.id);
            if (def.gistUrl) {
                try {
                    const gist = await fetchGistFile(def.gistUrl, 'базовый режим «' + def.name + '»');
                    text = gist.content || '';
                    if (text.trim()) store.setItem(cacheKey, text);
                } catch (e) {
                    text = store.getItem(cacheKey) || def.text || '';
                    errors.push('Базовый режим «' + def.name + '»: ' + e.message + (text ? ' (взят из кэша)' : ''));
                }
            } else {
                text = def.text || store.getItem(cacheKey) || '';
            }
            const parts = splitTitle(text);
            return {
                id: def.id,
                name: parts.title || def.name,
                text: parts.body,
                source: def.gistUrl ? 'gist' : 'builtin',
                builtin: true,
                gistUrl: def.gistUrl,
            };
        }

        /* ------------------------------- Загрузка ------------------------------- */

        function persistActive() {
            store.setItem(K.mode, JSON.stringify({ id: state.activeId, name: state.activeName }));
        }

        function persistGist() {
            if (state.gistUrl) store.setItem(K.gist, state.gistUrl);
        }

        function resolveActive() {
            let active = state.prompts.find(p => p.id === state.activeId);
            if (!active && state.activeName) {
                active = state.prompts.find(p => p.name === state.activeName);
            }
            if (!active) active = state.prompts[0] || null;
            state.activeId = active ? active.id : '';
            state.activeName = active ? active.name : '';
            persistActive();
            return active;
        }

        // Загрузка режимов: два базовых + (при наличии токена) режимы из общего
        // Gist. Без токена общий Gist не читается — доступны только базовые.
        async function load(opts = {}) {
            if (state.loadingPromise && !opts.force) return state.loadingPromise;
            state.loadingPromise = (async () => {
                status('Загрузка режимов…');
                const errors = [];

                const builtins = await Promise.all(builtinDefs.map(def => loadBuiltin(def, errors)));

                let gistModes = [];
                const gistRef = opts.gistUrl || state.gistUrl || state.gistId;
                if (!hasToken()) {
                    status('GitHub Token не задан: доступны только два базовых режима');
                } else if (gistRef) {
                    try {
                        const gist = await fetchGistFile(gistRef, 'режимы из Gist');
                        state.gistId = gist.id;
                        state.gistUrl = gist.url;
                        state.rawUrl = gist.rawUrl;
                        persistGist();
                        gistModes = parsePromptsMarkdown(gist.content).map(item => ({
                            id: item.id,
                            name: item.name,
                            text: item.text,
                            source: 'gist',
                            builtin: false,
                            legacy: item.legacy,
                        }));
                        if (gistModes.some(m => m.legacy)) {
                            errors.push('Общий Gist в старом формате («## Название»): после первого сохранения он будет переписан в новый формат («# Название»).');
                        }
                    } catch (e) {
                        errors.push('Режимы из Gist: ' + e.message);
                    }
                }

                // Копии базовых режимов в общем Gist не нужны: их текст всегда
                // берётся из их собственных Gist'ов. Отсекаем по id, названию и
                // тексту — так старый файл со секциями «Абзацы»/«Предложения»
                // не даёт дублей.
                const usedIds = new Set(builtins.map(b => b.id));
                const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
                const builtinNames = new Set(builtins.map(b => b.name.trim().toLowerCase()));
                const builtinShortNames = new Set(builtinDefs.map(b => b.name.trim().toLowerCase()));
                const builtinTexts = new Set(builtins.map(b => norm(b.text)).filter(Boolean));

                const merged = builtins.slice();
                for (const mode of gistModes) {
                    const lowerName = mode.name.trim().toLowerCase();
                    if (builtinNames.has(lowerName) || builtinShortNames.has(lowerName)) continue;
                    if (builtinTexts.has(norm(mode.text))) continue;
                    if (usedIds.has(mode.id)) mode.id = uniqueId(mode.id, usedIds);
                    merged.push(mode);
                }

                state.prompts = merged;
                state.loaded = true;
                state.dirty = false;
                resolveActive();

                emit('prompts-change', { modes: listModes() });
                emit('load', { modes: listModes(), errors: errors.slice(), gistUrl: state.gistUrl });
                if (errors.length) status('Режимы загружены с замечаниями (' + errors.length + ')', true);
                else status('Загружено режимов: ' + state.prompts.length);
                return { modes: listModes(), errors: errors.slice(), gistUrl: state.gistUrl };
            })();
            try {
                return await state.loadingPromise;
            } finally {
                state.loadingPromise = null;
            }
        }

        /* -------------------------------- Режимы -------------------------------- */

        function listModes() {
            return state.prompts.map(p => ({
                id: p.id,
                name: p.name,
                source: p.source,
                builtin: !!p.builtin,
                chars: (p.text || '').length,
                empty: !(p.text || '').trim(),
            }));
        }

        function getPrompt(id) {
            const mode = id ? state.prompts.find(p => p.id === id) : null;
            return cloneMode(mode || null);
        }

        function getModeId() {
            if (!state.prompts.length) return '';
            if (!state.prompts.some(p => p.id === state.activeId)) resolveActive();
            return state.activeId;
        }

        function getActivePrompt() {
            return getPrompt(getModeId());
        }

        function getPromptText() {
            const prompt = getActivePrompt();
            return prompt ? prompt.text : '';
        }

        function setMode(id) {
            const mode = state.prompts.find(p => p.id === id);
            if (!mode) fail('NOT_FOUND', 'Режим не найден: ' + id);
            state.activeId = mode.id;
            state.activeName = mode.name;
            persistActive();
            const payload = cloneMode(mode);
            emit('mode-change', payload);
            if (typeof config.onModeChange === 'function') {
                try { config.onModeChange(payload); } catch (e) {
                    if (typeof console !== 'undefined') console.error('[PromptsApi] onModeChange:', e);
                }
            }
            return payload;
        }

        function assertToken(action) {
            if (!hasToken()) {
                fail('TOKEN_REQUIRED', action + ' требует GitHub Token: без него доступны только два базовых режима');
            }
        }

        function assertNameFree(name, exceptId) {
            const needle = cleanTitle(name).toLowerCase();
            if (!needle) fail('VALIDATION', 'Укажите название режима');
            const clash = state.prompts.find(p => p.id !== exceptId && p.name.trim().toLowerCase() === needle);
            if (clash) fail('VALIDATION', 'Режим с названием «' + cleanTitle(name) + '» уже есть');
        }

        function addMode(payload = {}) {
            assertToken('Добавление своего режима');
            const name = cleanTitle(payload.name);
            assertNameFree(name);
            const used = new Set(state.prompts.map(p => p.id));
            const id = uniqueId(promptIdFromTitle(name), used);
            const mode = {
                id: id,
                name: name,
                text: normalizeBody(payload.text || ''),
                source: 'local',
                builtin: false,
            };
            state.prompts.push(mode);
            state.dirty = true;
            emit('prompts-change', { modes: listModes() });
            return cloneMode(mode);
        }

        function updateMode(id, patch = {}) {
            const mode = state.prompts.find(p => p.id === id);
            if (!mode) fail('NOT_FOUND', 'Режим не найден: ' + id);
            if (mode.builtin) {
                fail('READONLY_BUILTIN', 'Базовый режим изменить нельзя: его текст берётся из отдельного Gist');
            }
            if (patch.name !== undefined) {
                const name = cleanTitle(patch.name);
                assertNameFree(name, id);
                const used = new Set(state.prompts.filter(p => p.id !== id).map(p => p.id));
                const newId = uniqueId(promptIdFromTitle(name), used);
                if (newId !== id) {
                    mode.id = newId;
                    if (state.activeId === id) state.activeId = newId;
                }
                mode.name = name;
                if (state.activeId === mode.id) state.activeName = name;
            }
            if (patch.text !== undefined) mode.text = normalizeBody(patch.text);
            state.dirty = true;
            persistActive();
            emit('prompts-change', { modes: listModes() });
            return cloneMode(mode);
        }

        function removeMode(id) {
            const index = state.prompts.findIndex(p => p.id === id);
            if (index === -1) fail('NOT_FOUND', 'Режим не найден: ' + id);
            if (state.prompts[index].builtin) {
                fail('READONLY_BUILTIN', 'Базовый режим удалить нельзя');
            }
            state.prompts.splice(index, 1);
            if (state.activeId === id) resolveActive();
            state.dirty = true;
            emit('prompts-change', { modes: listModes() });
        }

        function hasUnsavedChanges() { return !!state.dirty; }

        function setGist(ref) {
            const value = String(ref || '').trim();
            state.gistUrl = value;
            state.gistId = gistIdFromRef(value);
            if (value) store.setItem(K.gist, value); else store.removeItem(K.gist);
            return value;
        }

        function getGistUrl() { return state.gistUrl; }

        // Сохранение ВСЕХ режимов в один Gist. Без токена невозможно.
        async function save(opts = {}) {
            assertToken('Сохранение режимов в Gist');
            if (state.saving) fail('BUSY', 'Сохранение уже выполняется');
            const items = state.prompts
                .filter(p => (config.includeBuiltinsInGist || !p.builtin))
                .filter(p => !p.builtin || String(p.text || '').trim())
                .map(p => ({ name: p.name, text: p.text }));
            if (!items.length) fail('EMPTY', 'Нет режимов для сохранения');
            const content = buildPromptsMarkdown(items);
            state.saving = true;
            status('Сохранение режимов в Gist…');
            try {
                const target = String(opts.gistUrl || state.gistUrl || state.gistId || '').trim();
                const gistId = gistIdFromRef(target);
                const filename = opts.gistFilename || config.gistFilename;
                let result;
                if (gistId) {
                    result = await ghRequest('/gists/' + gistId, {
                        method: 'PATCH',
                        headers: authHeaders({ 'Content-Type': 'application/json' }),
                        body: JSON.stringify({ files: { [filename]: { content: content } } }),
                    }, 'save');
                } else {
                    result = await ghRequest('/gists', {
                        method: 'POST',
                        headers: authHeaders({ 'Content-Type': 'application/json' }),
                        body: JSON.stringify({
                            description: opts.description || config.gistDescription,
                            public: false,
                            files: { [filename]: { content: content } },
                        }),
                    }, 'save');
                }
                const data = result.data || {};
                state.gistId = data.id || gistId;
                state.gistUrl = data.html_url || state.gistUrl || ('https://gist.github.com/' + state.gistId);
                const files = data.files || {};
                state.rawUrl = (files[filename] && files[filename].raw_url) || state.rawUrl;
                persistGist();

                state.prompts.forEach(p => { if (p.source === 'local') p.source = 'gist'; });
                state.dirty = false;
                const payload = {
                    gistId: state.gistId,
                    gistUrl: state.gistUrl,
                    rawUrl: state.rawUrl,
                    count: items.length,
                };
                emit('prompts-change', { modes: listModes() });
                emit('save', payload);
                status('Режимы сохранены: ' + state.gistUrl);
                return payload;
            } catch (e) {
                status('Сохранение: ' + e.message, true);
                throw e;
            } finally {
                state.saving = false;
            }
        }

        /* --------------------------- Диалоговое окно --------------------------- */

        const dialog = { root: null, els: null, selectedId: '', editing: false };

        const STYLE_ID = 'prompts-api-styles';

        function injectStyles() {
            if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
            const style = document.createElement('style');
            style.id = STYLE_ID;
            style.textContent = [
                '.pa-root{position:fixed;inset:0;z-index:10000;display:none;align-items:center;justify-content:center;padding:24px;background:rgba(15,23,42,.55)}',
                '.pa-root.show{display:flex;animation:pa-fade .16s ease-out}',
                '.pa-root [hidden]{display:none!important}',
                '.pa-dialog{display:flex;flex-direction:column;width:min(1080px,96vw);height:min(88vh,920px);background:#fff;color:#0f172a;border-radius:16px;box-shadow:0 32px 90px rgba(15,23,42,.45);overflow:hidden;font:14px/1.45 -apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}',
                '.pa-head{display:flex;gap:16px;align-items:flex-start;justify-content:space-between;padding:20px 24px 16px;border-bottom:1px solid #e2e8f0;background:linear-gradient(180deg,#f8fafc,#fff)}',
                '.pa-title{margin:0;font-size:20px;font-weight:650;line-height:1.25}',
                '.pa-sub{margin:6px 0 0;color:#64748b;font-size:12.5px;max-width:780px}',
                '.pa-icon{border:0;background:transparent;font-size:18px;line-height:1;padding:8px;border-radius:8px;cursor:pointer;color:#64748b}',
                '.pa-icon:hover{background:#f1f5f9;color:#0f172a}',
                '.pa-content{flex:1;min-height:0;display:flex;flex-direction:column;gap:12px;padding:16px 24px}',
                '.pa-controls{display:flex;gap:10px;align-items:center}',
                '.pa-label{font-size:11.5px;font-weight:700;color:#475569;text-transform:uppercase;letter-spacing:.04em}',
                '.pa-select{flex:1;min-width:0;height:40px;padding:0 12px;border:1px solid #cbd5e1;border-radius:10px;background:#fff;font-size:14px;color:#0f172a}',
                '.pa-select:focus{outline:2px solid #6366f1;outline-offset:1px;border-color:#6366f1}',
                '.pa-btn{height:38px;padding:0 14px;border:1px solid #cbd5e1;border-radius:10px;background:#fff;color:#1e293b;font:inherit;font-size:13px;font-weight:500;cursor:pointer;white-space:nowrap}',
                '.pa-btn:hover{background:#f8fafc}',
                '.pa-btn:disabled{opacity:.45;cursor:default}',
                '.pa-btn-sm{height:32px;padding:0 10px;font-size:12px}',
                '.pa-btn-primary{background:#4f46e5;border-color:#4f46e5;color:#fff}',
                '.pa-btn-primary:hover{background:#4338ca}',
                '.pa-btn-danger{color:#b91c1c;border-color:#fecaca}',
                '.pa-btn-danger:hover{background:#fef2f2}',
                '.pa-token{border:1px solid #fde68a;background:#fffbeb;border-radius:12px;padding:10px 12px;display:flex;flex-direction:column;gap:8px}',
                '.pa-token-note{font-size:12.5px;color:#92400e}',
                '.pa-token-row{display:flex;gap:8px}',
                '.pa-input{height:38px;padding:0 12px;border:1px solid #cbd5e1;border-radius:10px;background:#fff;color:#0f172a;font:inherit;font-size:13px;min-width:0}',
                '.pa-input:focus{outline:2px solid #6366f1;outline-offset:1px;border-color:#6366f1}',
                '.pa-mono{font-family:ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace;font-size:12px}',
                '.pa-preview-card{flex:1;min-height:0;display:flex;flex-direction:column;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;background:#f8fafc}',
                '.pa-preview-head{display:flex;gap:12px;align-items:flex-start;justify-content:space-between;padding:10px 14px;border-bottom:1px solid #e2e8f0;background:#fff}',
                '.pa-preview-title{font-size:13.5px;font-weight:650}',
                '.pa-preview-meta{margin-top:2px;color:#64748b;font-size:12px}',
                '.pa-preview-actions{display:flex;gap:6px;flex-shrink:0}',
                '.pa-preview{flex:1;min-height:0;overflow:auto;margin:0;padding:14px 16px;color:#334155;font:12.5px/1.55 ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace;white-space:pre-wrap;word-break:break-word}',
                '.pa-edit{flex:1;min-height:0;display:flex;flex-direction:column;gap:10px;padding:12px}',
                '.pa-textarea{flex:1;min-height:160px;resize:none;padding:12px;border:1px solid #cbd5e1;border-radius:10px;color:#1e293b;background:#fff;font:12.5px/1.55 ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace}',
                '.pa-edit-actions{display:flex;justify-content:flex-end;gap:8px}',
                '.pa-add{display:flex;gap:8px}',
                '.pa-add .pa-input{flex:1}',
                '.pa-gist{display:flex;gap:8px}',
                '.pa-gist .pa-input{flex:1;height:34px}',
                '.pa-status{min-height:18px;font-size:12.5px;color:#475569}',
                '.pa-status.error{color:#b91c1c}',
                '.pa-foot{display:flex;gap:12px;align-items:center;justify-content:space-between;padding:12px 24px;border-top:1px solid #e2e8f0;background:#f8fafc}',
                '.pa-foot-info{color:#64748b;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
                '@media (max-width:720px){.pa-root{padding:0}.pa-dialog{width:100vw;height:100vh;border-radius:0}.pa-content{padding:12px}.pa-head,.pa-foot{padding:14px 16px}.pa-controls{flex-wrap:wrap}.pa-add,.pa-gist{flex-wrap:wrap}}',
                '@media (prefers-reduced-motion:reduce){.pa-root.show{animation:none}}',
                'body.pa-no-scroll{overflow:hidden}',
                '@keyframes pa-fade{from{opacity:0}to{opacity:1}}',
            ].join('\n');
            document.head.appendChild(style);
        }

        function buildDialog() {
            if (dialog.root || typeof document === 'undefined') return;
            injectStyles();
            const root = document.createElement('div');
            root.className = 'pa-root';
            root.innerHTML = [
                '<div class="pa-dialog" role="dialog" aria-modal="true" aria-labelledby="paTitle">',
                '  <header class="pa-head">',
                '    <div>',
                '      <h2 class="pa-title" id="paTitle">' + escapeHtml(config.dialogTitle) + '</h2>',
                '      <p class="pa-sub">' + escapeHtml(config.dialogHint) + '</p>',
                '    </div>',
                '    <button type="button" class="pa-icon" data-pa="close" aria-label="Закрыть окно режимов">✕</button>',
                '  </header>',
                '  <div class="pa-content">',
                '    <div class="pa-controls">',
                '      <label class="pa-label" for="paSelect">Режим</label>',
                '      <select class="pa-select" id="paSelect" data-pa="select"></select>',
                '      <button type="button" class="pa-btn pa-btn-primary" data-pa="apply">Применить режим</button>',
                '    </div>',
                '    <div class="pa-token" data-pa="token-box" hidden>',
                '      <div class="pa-token-note">GitHub Token не задан — доступны только два базовых режима. Свои режимы хранятся в одном Gist и требуют токен.</div>',
                '      <div class="pa-token-row">',
                '        <input type="password" class="pa-input pa-mono" data-pa="token" placeholder="ghp_…" autocomplete="off" aria-label="GitHub Token">',
                '        <button type="button" class="pa-btn" data-pa="token-save">Сохранить токен</button>',
                '      </div>',
                '    </div>',
                '    <div class="pa-preview-card">',
                '      <div class="pa-preview-head">',
                '        <div>',
                '          <div class="pa-preview-title" data-pa="preview-title">—</div>',
                '          <div class="pa-preview-meta" data-pa="preview-meta"></div>',
                '        </div>',
                '        <div class="pa-preview-actions">',
                '          <button type="button" class="pa-btn pa-btn-sm" data-pa="edit">✎ Изменить</button>',
                '          <button type="button" class="pa-btn pa-btn-sm pa-btn-danger" data-pa="delete">Удалить</button>',
                '        </div>',
                '      </div>',
                '      <pre class="pa-preview" data-pa="preview" tabindex="0"></pre>',
                '      <div class="pa-edit" data-pa="edit-box" hidden>',
                '        <textarea class="pa-textarea" data-pa="edit-area" spellcheck="false" aria-label="Текст промпта"></textarea>',
                '        <div class="pa-edit-actions">',
                '          <button type="button" class="pa-btn" data-pa="edit-cancel">Отмена</button>',
                '          <button type="button" class="pa-btn pa-btn-primary" data-pa="edit-save">Сохранить промпт</button>',
                '        </div>',
                '      </div>',
                '    </div>',
                '    <div class="pa-add">',
                '      <input type="text" class="pa-input" data-pa="new-name" maxlength="160" placeholder="Название нового режима — оно же название промпта (заголовок первого уровня)">',
                '      <button type="button" class="pa-btn" data-pa="add">+ Добавить режим</button>',
                '    </div>',
                '    <div class="pa-gist">',
                '      <input type="text" class="pa-input pa-mono" data-pa="gist" placeholder="https://gist.github.com/… — один Gist со всеми режимами">',
                '      <button type="button" class="pa-btn pa-btn-sm" data-pa="gist-use">Указать</button>',
                '      <button type="button" class="pa-btn pa-btn-sm" data-pa="reload">↻ Из Gist</button>',
                '      <button type="button" class="pa-btn pa-btn-sm pa-btn-primary" data-pa="save">💾 Сохранить в Gist</button>',
                '    </div>',
                '    <div class="pa-status" data-pa="status" role="status" aria-live="polite"></div>',
                '  </div>',
                '  <footer class="pa-foot">',
                '    <span class="pa-foot-info" data-pa="foot"></span>',
                '    <button type="button" class="pa-btn" data-pa="close">Закрыть</button>',
                '  </footer>',
                '</div>',
            ].join('\n');

            const els = {};
            root.querySelectorAll('[data-pa]').forEach(el => { els[el.getAttribute('data-pa')] = el; });
            dialog.root = root;
            dialog.els = els;

            root.addEventListener('click', event => {
                if (event.target === root) { closeDialog(); return; }
                const trigger = event.target.closest('[data-pa]');
                if (!trigger) return;
                handleAction(trigger.getAttribute('data-pa'))
                    .catch(e => dialogStatus(e && e.message ? e.message : String(e), true));
            });
            root.addEventListener('keydown', event => {
                if (event.key === 'Escape') { event.preventDefault(); closeDialog(); }
            });
            els.select.addEventListener('change', () => {
                if (dialog.editing) cancelEdit();   // иначе текст правился бы у другого режима
                dialog.selectedId = els.select.value;
                renderDialog();
            });

            document.body.appendChild(root);
        }

        function dialogStatus(message, isError) {
            if (!dialog.els) return;
            dialog.els.status.textContent = message || '';
            dialog.els.status.classList.toggle('error', !!isError);
        }

        function selectedPrompt() {
            return getPrompt(dialog.selectedId);
        }

        function startEdit() {
            const prompt = selectedPrompt();
            if (!prompt) { dialogStatus('Сначала выберите режим', true); return; }
            if (prompt.builtin) {
                dialogStatus('Базовый режим изменить нельзя: его текст берётся из отдельного Gist', true);
                return;
            }
            dialog.editing = true;
            dialog.els['edit-area'].value = prompt.text || '';
            dialog.els['edit-box'].hidden = false;
            dialog.els.preview.hidden = true;
            dialog.els['edit-area'].focus();
        }

        function cancelEdit() {
            dialog.editing = false;
            if (!dialog.els) return;
            dialog.els['edit-box'].hidden = true;
            dialog.els.preview.hidden = false;
        }

        function saveEdit() {
            const prompt = selectedPrompt();
            if (!prompt) return;
            let updated;
            try {
                updated = updateMode(prompt.id, { text: dialog.els['edit-area'].value });
            } catch (e) {
                dialogStatus(e.message, true);
                return;
            }
            dialog.selectedId = updated.id;
            cancelEdit();
            renderDialog();
            dialogStatus('Промпт обновлён. Сохраните режимы в Gist, чтобы записать изменение.');
        }

        function applySelected() {
            const prompt = selectedPrompt();
            if (!prompt) { dialogStatus('Режим не выбран', true); return; }
            if (!(prompt.text || '').trim()) {
                dialogStatus('Промпт режима пуст — добавьте текст или выберите другой режим', true);
                return;
            }
            setMode(prompt.id);
            closeDialog();
        }

        async function handleAction(action) {
            if (action === 'close') { closeDialog(); return; }
            if (action === 'apply') { applySelected(); return; }
            if (action === 'edit') { startEdit(); return; }
            if (action === 'edit-cancel') { cancelEdit(); return; }
            if (action === 'edit-save') { saveEdit(); return; }
            if (action === 'delete') {
                const prompt = selectedPrompt();
                if (!prompt) return;
                if (prompt.builtin) { dialogStatus('Базовый режим удалить нельзя', true); return; }
                const ok = typeof window !== 'undefined' && typeof window.confirm === 'function'
                    ? window.confirm('Удалить режим «' + prompt.name + '»? Изменение попадёт в Gist только после сохранения.')
                    : true;
                if (!ok) return;
                try {
                    removeMode(prompt.id);
                    dialog.selectedId = getModeId();
                    renderDialog();
                    dialogStatus('Режим удалён. Сохраните режимы в Gist, чтобы записать изменение.');
                } catch (e) { dialogStatus(e.message, true); }
                return;
            }
            if (action === 'add') {
                try {
                    const mode = addMode({ name: dialog.els['new-name'].value, text: '' });
                    dialog.els['new-name'].value = '';
                    dialog.selectedId = mode.id;
                    renderDialog();
                    startEdit();
                    dialogStatus('Режим добавлен. Напишите текст промпта и сохраните.');
                } catch (e) {
                    dialogStatus(e.message, true);
                    if (e.code === 'TOKEN_REQUIRED') dialog.els.token.focus();
                }
                return;
            }
            if (action === 'token-save') {
                setToken('github', dialog.els.token.value);
                dialog.els.token.value = '';
                dialog.els['token-box'].hidden = hasToken();
                renderDialog();
                if (hasToken()) {
                    dialogStatus('Токен сохранён, загрузка режимов…');
                    await reloadDialog();
                } else {
                    await reloadDialog();
                    dialogStatus('Токен удалён: доступны только два базовых режима');
                }
                return;
            }
            if (action === 'gist-use') {
                setGist(dialog.els.gist.value);
                dialogStatus(state.gistUrl ? 'Gist указан: ' + state.gistUrl : 'Ссылка на Gist очищена');
                renderDialog();
                return;
            }
            if (action === 'reload') { await reloadDialog(); return; }
            if (action === 'save') {
                try {
                    dialogStatus('Сохранение режимов в Gist…');
                    const result = await save();
                    renderDialog();
                    dialogStatus('Сохранено: ' + result.gistUrl);
                } catch (e) {
                    dialogStatus(e.message, true);
                }
            }
        }

        async function reloadDialog() {
            try {
                const result = await load({ force: true });
                if (!dialog.root) return;
                if (!state.prompts.some(p => p.id === dialog.selectedId)) dialog.selectedId = getModeId();
                renderDialog();
                dialogStatus(result.errors.length ? result.errors.join(' ') : 'Загружено режимов: ' + result.modes.length, result.errors.length > 0);
            } catch (e) {
                dialogStatus(e.message, true);
            }
        }

        function renderDialog() {
            if (!dialog.root) return;
            const els = dialog.els;
            const modes = listModes();
            els.select.innerHTML = modes.map(mode =>
                '<option value="' + escapeHtml(mode.id) + '">' + escapeHtml(mode.name) +
                (mode.empty ? ' — промпт пуст' : '') + '</option>').join('');
            if (!modes.length) {
                els.select.innerHTML = '<option value="">— режимы не загружены —</option>';
            }

            const fallback = getModeId() || (modes[0] && modes[0].id) || '';
            if (!modes.some(m => m.id === dialog.selectedId)) dialog.selectedId = fallback;
            if (dialog.selectedId) els.select.value = dialog.selectedId;

            const prompt = selectedPrompt();
            if (prompt) {
                els['preview-title'].textContent = 'Промпт режима «' + prompt.name + '»';
                const source = prompt.builtin ? 'базовый режим'
                    : prompt.source === 'gist' ? 'из Gist'
                    : prompt.source === 'local' ? 'новый (не сохранён)' : 'локальный';
                els['preview-meta'].textContent = source + ' · ' + (prompt.text || '').length + ' символов' +
                    (hasUnsavedChanges() ? ' · есть несохранённые изменения' : '');
                els.preview.textContent = prompt.text || '— промпт пуст —';
                els.edit.disabled = !!prompt.builtin;
                els.delete.disabled = !!prompt.builtin;
                els.apply.disabled = !(prompt.text || '').trim();
            } else {
                els['preview-title'].textContent = 'Режим не выбран';
                els['preview-meta'].textContent = '';
                els.preview.textContent = '— нет данных —';
                els.edit.disabled = true;
                els.delete.disabled = true;
                els.apply.disabled = true;
            }

            els['token-box'].hidden = hasToken();
            // Ссылку на Gist не перезаписываем, пока пользователь её вводит.
            if (document.activeElement !== els.gist) els.gist.value = state.gistUrl || '';
            els.foot.textContent = 'Режимов: ' + modes.length +
                ' · ' + (hasToken() ? 'Gist доступен' : 'без токена — только базовые') +
                (hasUnsavedChanges() ? ' · не сохранено в Gist' : '');
        }

        function openDialog() {
            if (typeof document === 'undefined') fail('DOM_REQUIRED', 'Диалог режимов доступен только в браузере');
            buildDialog();
            dialog.selectedId = getModeId();
            renderDialog();
            dialog.root.classList.add('show');
            document.body.classList.add('pa-no-scroll');
            emit('dialog-open', {});
            const finish = () => {
                if (state.loaded) { renderDialog(); return; }
                dialogStatus('Загрузка режимов…');
                load().then(() => {
                    if (!dialog.root) return;
                    dialog.selectedId = getModeId();
                    renderDialog();
                    dialogStatus('');
                }).catch(e => dialogStatus(e.message, true));
            };
            finish();
            setTimeout(() => { try { dialog.els.select.focus(); } catch (e) { /* ignore */ } }, 30);
            return dialog.root;
        }

        function closeDialog() {
            if (!dialog.root) return;
            cancelEdit();
            dialog.root.classList.remove('show');
            if (typeof document !== 'undefined') document.body.classList.remove('pa-no-scroll');
            emit('dialog-close', {});
        }

        function isDialogOpen() {
            return !!(dialog.root && dialog.root.classList.contains('show'));
        }

        // Базовые режимы доступны сразу, не дожидаясь сети: текст берётся из
        // кэша последней удачной загрузки или из builtins[].text. load()
        // обновляет его из Gist'ов.
        function builtinStub(def) {
            const cached = store.getItem(K.builtin(def.id)) || def.text || '';
            const parts = splitTitle(cached);
            return {
                id: def.id,
                name: parts.title || def.name,
                text: parts.body,
                source: def.gistUrl ? 'gist' : 'builtin',
                builtin: true,
                gistUrl: def.gistUrl,
            };
        }
        if (!state.prompts.length) {
            state.prompts = builtinDefs.map(builtinStub);
            resolveActive();
        }

        /* -------------------------------- API -------------------------------- */

        const api = {
            version: VERSION,
            config: config,
            load, save,
            listModes, getPrompt, getPromptText, getActivePrompt, getModeId, setMode,
            addMode, updateMode, removeMode, hasUnsavedChanges,
            setGist, getGistUrl,
            getToken, hasToken, setToken, clearToken,
            openDialog, closeDialog, isDialogOpen,
            on,
        };
        return api;
    }

    return {
        VERSION,
        create,
        parsePromptsMarkdown,
        buildPromptsMarkdown,
        splitTitle,
        promptIdFromTitle,
        gistIdFromRef,
        PRESETS,
        DEFAULT_PROMPTS_GIST_URL,
        PromptsApiError,
    };
});
