'use strict';

/* =========================================================================
   Prompts API — режимы (промпты) редакторов rt / mt / ft.

   Все промпты хранятся в ОДНОМ файле prompts.xml на GitHub Gist:

     <?xml version="1.0" encoding="UTF-8"?>
     <prompts version="1">
       <prompt type="rt" name="Название режима"><![CDATA[Markdown-текст]]></prompt>
     </prompts>

   Модель:
     • Каждый <prompt>: type — вид теста (rt | mt | ft), name — название
       режима, текст внутри CDATA — Markdown-промпт. Файл можно править и
       руками прямо на gist.github.com: CDATA читается как есть.
     • Чтение — публичное: GET Gist работает без токена, поэтому все режимы
       доступны всегда. Текст последней удачной загрузки кэшируется в
       localStorage и используется при сбое сети.
     • Редактирование (название, вид теста, текст, добавление, удаление,
       сохранение в Gist) — только с GitHub Token (PATCH Gist).
     • Экземпляр API показывает промпты своего вида теста (config.type), но
       хранит весь файл целиком: сохранение записывает все промпты обратно.
     • Выбор режима переключает режим работы редактора: приложение читает
       активный промпт через getActivePrompt() и слушает событие mode-change.

   Подключение:
     <script src="prompts-api.js"></script>
     const prompts = PromptsApi.create({ type: 'rt', tokenProvider: () => token });
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

    const VERSION = '2.0.0';
    const GITHUB_API = 'https://api.github.com';

    // XML-формат файла промптов.
    const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>';
    const XML_ROOT_COMMENT = '<!-- Промпты редакторов. Каждый <prompt>: type — вид теста (rt | mt | ft),'
        + ' name — название режима, текст внутри CDATA — промпт в Markdown.'
        + ' Файл можно править и руками: текст каждого промпта лежит внутри CDATA. -->';

    // Общий Gist со всеми промптами (публичный: читается без токена).
    const DEFAULT_PROMPTS_GIST_URL = 'https://gist.github.com/tregubovvn/2f9804a3ad5439b1bb60957b8969826a';

    // Виды тестов и их названия.
    const TYPE_LABELS = {
        rt: 'Reading Test',
        mt: 'Moodle Quiz',
        ft: 'Formula Test',
    };

    // Допустимые значения type, включая старые имена пресетов.
    const TYPE_ALIASES = {
        rt: 'rt', reading: 'rt', rt_v2: 'rt', read: 'rt',
        mt: 'mt', moodle: 'mt', mt_v2: 'mt', quiz: 'mt',
        ft: 'ft', formulas: 'ft', ft_v2: 'ft', formula: 'ft',
    };

    function normalizeType(type) {
        const key = String(type === undefined || type === null ? '' : type).trim().toLowerCase();
        return TYPE_ALIASES[key] || '';
    }

    const DEFAULTS = {
        type: '',                      // 'rt' | 'mt' | 'ft' — чьи промпты показывать; '' — все
        gistUrl: '',                   // ссылка на общий Gist ('' — по умолчанию)
        gistFilename: 'prompts.xml',   // имя файла внутри Gist
        gistDescription: 'Промпты редакторов: все режимы в одном XML',
        storagePrefix: 'moodlePromptsApi',
        tokenProvider: null,           // () => token — если токен живёт в настройках приложения
        dialogTitle: 'Режим работы редактора',
        dialogHint: 'Все промпты хранятся в одном XML на GitHub Gist. Название режима и вид теста задаются у каждого промпта. Чтение — без токена, редактирование — с GitHub Token.',
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

    /* ------------------------------ XML формата ------------------------------ */

    function escapeXmlAttr(value) {
        return String(value === undefined || value === null ? '' : value)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
    }

    // Содержимое CDATA не ломается на «]]>»: стандартное экранирование.
    function escapeCdata(text) {
        return String(text === undefined || text === null ? '' : text)
            .replace(/\]\]>/g, ']]]]><![CDATA[>');
    }

    function decodeXmlEntities(value) {
        return String(value || '')
            .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
            .replace(/&amp;/g, '&');
    }

    function parseXmlAttrs(fragment) {
        const attrs = {};
        const re = /([:\w-]+)\s*=\s*"([^"]*)"|([:\w-]+)\s*=\s*'([^']*)'/g;
        let m;
        while ((m = re.exec(fragment))) {
            const name = (m[1] || m[3] || '').toLowerCase();
            attrs[name] = decodeXmlEntities(m[2] !== undefined ? m[2] : (m[4] || ''));
        }
        return attrs;
    }

    // Тело <prompt>: если обёрнуто в CDATA — внутренний текст (склейка
    // экранированных «]]>» разворачивается), иначе — текст с сущностями.
    function unwrapCdata(raw) {
        const text = String(raw || '');
        const start = text.indexOf('<![CDATA[');
        const end = text.lastIndexOf(']]>');
        if (start >= 0 && end > start) {
            return text.slice(start + 9, end).replace(/\]\]\]\]><!\[CDATA\[>/g, ']]>');
        }
        return decodeXmlEntities(text);
    }

    // Список открывающих тегов <prompt …> с атрибутами и сырым телом.
    // Поиск закрывающего </prompt> учитывает CDATA: внутри неё </prompt> —
    // просто текст. XML-комментарии пропускаются целиком, а тег <prompts>
    // не принимается за <prompt> (проверяется следующий символ).
    function parsePromptEntries(xml) {
        const text = String(xml === undefined || xml === null ? '' : xml).replace(/^\uFEFF/, '');
        const entries = [];
        const tagRe = /<prompt(?=[\s/>])/g;
        let from = 0;
        for (;;) {
            const comment = text.indexOf('<!--', from);
            tagRe.lastIndex = from;
            const match = tagRe.exec(text);
            if (comment >= 0 && (match === null || comment < match.index)) {
                const commentEnd = text.indexOf('-->', comment + 4);
                if (commentEnd < 0) break;
                from = commentEnd + 3;
                continue;
            }
            if (match === null) break;
            const open = match.index;
            const tagEnd = text.indexOf('>', open);
            if (tagEnd < 0) break;
            const attrs = parseXmlAttrs(text.slice(open + 7, tagEnd));
            let scan = tagEnd + 1;
            let close = -1;
            for (;;) {
                const cdataAt = text.indexOf('<![CDATA[', scan);
                const closeAt = text.indexOf('</prompt>', scan);
                if (closeAt < 0) break;
                if (cdataAt >= 0 && cdataAt < closeAt) {
                    const cdataEnd = text.indexOf(']]>', cdataAt + 9);
                    if (cdataEnd < 0) break;
                    scan = cdataEnd + 3;
                    continue;
                }
                close = closeAt;
                break;
            }
            if (close < 0) break;
            entries.push({ attrs: attrs, raw: text.slice(tagEnd + 1, close) });
            from = close + 9;
        }
        return entries;
    }

    // Разбор prompts.xml → [{ id, name, type, text }]. Записи без названия
    // пропускаются; неизвестный type сохраняется как '' (такая запись не
    // видна в редакторах, но не теряется при сохранении).
    function parsePromptsXml(xml) {
        const used = new Set();
        return parsePromptEntries(xml).map(entry => {
            const name = cleanTitle(entry.attrs.name || '');
            if (!name) return null;
            return {
                id: uniqueId(promptIdFromTitle(name), used),
                name: name,
                type: normalizeType(entry.attrs.type),
                text: unwrapCdata(entry.raw).trim(),
            };
        }).filter(Boolean);
    }

    // Сборка prompts.xml: все промпты, каждый — свой <prompt> с CDATA.
    function buildPromptsXml(items) {
        const body = (items || []).map(item => {
            const name = cleanTitle(item.name) || 'Без названия';
            const type = normalizeType(item.type);
            const text = String(item.text || '').trim();
            return '  <prompt type="' + escapeXmlAttr(type) + '" name="' + escapeXmlAttr(name) + '"><![CDATA['
                + escapeCdata(text) + ']]></prompt>';
        }).join('\n');
        return XML_DECLARATION + '\n' + XML_ROOT_COMMENT + '\n<prompts version="1">\n'
            + (body ? body + '\n' : '') + '</prompts>\n';
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
            type: mode.type || '',
            text: mode.text,
            source: mode.source,
            chars: (mode.text || '').length,
        };
    }

    /* ------------------------- Фабрика экземпляра ------------------------- */

    function create(options = {}) {
        const config = Object.assign({}, DEFAULTS, options);
        // Старое имя опции preset ('rt_v2' | 'mt_v2') понимается как вид теста.
        if (!config.type && config.preset) config.type = normalizeType(config.preset);
        config.type = normalizeType(config.type);

        const store = safeStorage();
        const K = {
            token: config.storagePrefix + '_gh_token',
            gist: config.storagePrefix + '_gist_url',
            mode: config.storagePrefix + '_mode',
            cache: config.storagePrefix + '_xml_cache',
        };

        const state = {
            modes: [],                 // весь файл целиком: промпты всех видов тестов
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
                || list.find(f => /\.(xml|md|markdown|txt)$/i.test(f.filename || ''))
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

        /* --------------------- Промпты: доступ и кэш --------------------- */

        // Промпты, видимые этому экземпляру: своего вида теста ('' — все виды).
        function typedModes() {
            return state.modes.filter(m => !config.type || m.type === config.type);
        }

        function typeLabel(type) {
            return TYPE_LABELS[type] || (type ? type : 'без вида теста');
        }

        // Промпты из кэша последней удачной загрузки (полный XML файла).
        function modesFromCache() {
            const cached = store.getItem(K.cache);
            if (!cached) return null;
            try {
                const modes = parsePromptsXml(cached);
                return modes.length ? modes : null;
            } catch (e) {
                return null;
            }
        }

        /* ------------------------------- Загрузка ------------------------------- */

        function persistActive() {
            store.setItem(K.mode, JSON.stringify({ id: state.activeId, name: state.activeName }));
        }

        function persistGist() {
            if (state.gistUrl) store.setItem(K.gist, state.gistUrl);
        }

        function resolveActive() {
            const visible = typedModes();
            let active = visible.find(p => p.id === state.activeId);
            if (!active && state.activeName) {
                active = visible.find(p => p.name === state.activeName);
            }
            if (!active) active = visible[0] || null;
            state.activeId = active ? active.id : '';
            state.activeName = active ? active.name : '';
            persistActive();
            return active;
        }

        // Загрузка промптов: один публичный Gist читается БЕЗ токена.
        // При сбое сети используется кэш последней удачной загрузки.
        async function load(opts = {}) {
            if (state.loadingPromise && !opts.force) return state.loadingPromise;
            state.loadingPromise = (async () => {
                status('Загрузка промптов…');
                const errors = [];

                const gistRef = opts.gistUrl || state.gistUrl || state.gistId;
                let modes = null;
                if (!gistRef) {
                    errors.push('Gist с промптами не указан');
                } else {
                    try {
                        const gist = await fetchGistFile(gistRef, 'промпты из Gist');
                        state.gistId = gist.id;
                        state.gistUrl = gist.url;
                        state.rawUrl = gist.rawUrl;
                        persistGist();
                        modes = parsePromptsXml(gist.content);
                        if (!modes.length) {
                            errors.push('В файле ' + config.gistFilename + ' нет ни одного промпта');
                        }
                        try { store.setItem(K.cache, gist.content); } catch (e) { /* кэш не критичен */ }
                    } catch (e) {
                        const cached = modesFromCache();
                        if (cached) {
                            modes = cached;
                            errors.push('Промпты из Gist: ' + e.message + ' (взяты из кэша)');
                        } else {
                            errors.push('Промпты из Gist: ' + e.message);
                        }
                    }
                }

                if (modes) state.modes = modes;
                state.loaded = true;
                state.dirty = false;
                resolveActive();

                emit('prompts-change', { modes: listModes() });
                emit('load', { modes: listModes(), errors: errors.slice(), gistUrl: state.gistUrl });
                if (errors.length) status('Промпты загружены с замечаниями (' + errors.length + ')', true);
                else if (hasToken()) status('Загружено промптов: ' + listModes().length);
                else status('Загружено промптов: ' + listModes().length + ' (только чтение — для редактирования укажите GitHub Token)');
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
            return typedModes().map(p => ({
                id: p.id,
                name: p.name,
                type: p.type || '',
                typeLabel: typeLabel(p.type),
                source: p.source,
                chars: (p.text || '').length,
                empty: !(p.text || '').trim(),
            }));
        }

        function getPrompt(id) {
            const mode = id ? state.modes.find(p => p.id === id) : null;
            return cloneMode(mode || null);
        }

        function getModeId() {
            if (!typedModes().length) return '';
            if (!typedModes().some(p => p.id === state.activeId)) resolveActive();
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
            const mode = state.modes.find(p => p.id === id);
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
                fail('TOKEN_REQUIRED', action + ': укажите GitHub Token в окне режимов или в настройках приложения.');
            }
        }

        function assertNameFree(name, exceptId, type) {
            const needle = cleanTitle(name).toLowerCase();
            if (!needle) fail('VALIDATION', 'Укажите название режима');
            const kind = normalizeType(type);
            const clash = state.modes.find(p =>
                p.id !== exceptId
                && (p.type || '') === kind
                && p.name.trim().toLowerCase() === needle);
            if (clash) fail('VALIDATION', 'Режим с названием «' + cleanTitle(name) + '» для этого вида теста уже есть');
        }

        function addMode(payload = {}) {
            assertToken('Добавление режима');
            const name = cleanTitle(payload.name);
            const type = normalizeType(payload.type) || config.type || 'rt';
            assertNameFree(name, '', type);
            const used = new Set(state.modes.map(p => p.id));
            const id = uniqueId(promptIdFromTitle(name), used);
            const mode = {
                id: id,
                name: name,
                type: type,
                text: String(payload.text || '').trim(),
                source: 'local',
            };
            state.modes.push(mode);
            state.dirty = true;
            emit('prompts-change', { modes: listModes() });
            return cloneMode(mode);
        }

        function updateMode(id, patch = {}) {
            assertToken('Изменение режима');
            const mode = state.modes.find(p => p.id === id);
            if (!mode) fail('NOT_FOUND', 'Режим не найден: ' + id);
            if (patch.name !== undefined) {
                const name = cleanTitle(patch.name);
                assertNameFree(name, id, mode.type);
                const used = new Set(state.modes.filter(p => p.id !== id).map(p => p.id));
                const newId = uniqueId(promptIdFromTitle(name), used);
                if (newId !== id) {
                    mode.id = newId;
                    if (state.activeId === id) state.activeId = newId;
                }
                mode.name = name;
                if (state.activeId === mode.id) state.activeName = name;
            }
            if (patch.type !== undefined) {
                const type = normalizeType(patch.type);
                assertNameFree(mode.name, id, type);
                mode.type = type;
            }
            if (patch.text !== undefined) mode.text = String(patch.text || '').trim();
            state.dirty = true;
            persistActive();
            resolveActive();   // режим мог сменить вид теста и уйти из списка
            emit('prompts-change', { modes: listModes() });
            return cloneMode(mode);
        }

        function removeMode(id) {
            assertToken('Удаление режима');
            const index = state.modes.findIndex(p => p.id === id);
            if (index === -1) fail('NOT_FOUND', 'Режим не найден: ' + id);
            state.modes.splice(index, 1);
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

        // Сохранение ВСЕХ промптов (всех видов тестов) в один XML-файл Gist.
        // Без токена невозможно; сам файл публичный и читается без токена.
        async function save(opts = {}) {
            assertToken('Сохранение промптов в Gist');
            if (state.saving) fail('BUSY', 'Сохранение уже выполняется');
            if (!state.modes.length) fail('EMPTY', 'Нет промптов для сохранения');
            const content = buildPromptsXml(state.modes);
            state.saving = true;
            status('Сохранение промптов в Gist…');
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
                            public: true,   // публичный: редакторы читают промпты без токена
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
                try { store.setItem(K.cache, content); } catch (e) { /* кэш не критичен */ }

                state.modes.forEach(p => { if (p.source === 'local') p.source = 'gist'; });
                state.dirty = false;
                const payload = {
                    gistId: state.gistId,
                    gistUrl: state.gistUrl,
                    rawUrl: state.rawUrl,
                    count: state.modes.length,
                };
                emit('prompts-change', { modes: listModes() });
                emit('save', payload);
                status('Промпты сохранены: ' + state.gistUrl);
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
                '.pa-add{display:flex;gap:8px;flex-wrap:wrap}',
                '.pa-add .pa-input{flex:1;min-width:220px}',
                '.pa-select-sm{height:38px;padding:0 10px;font-size:13px;flex:0 0 210px}',
                '.pa-edit-grid{display:flex;gap:8px}',
                '.pa-edit-grid .pa-input{flex:1;min-width:0}',
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
                '      <div class="pa-token-note">Промпты открыты для чтения. Чтобы редактировать их (название, вид теста, текст, добавление и удаление), укажите GitHub Token с правом gist.</div>',
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
                '        <div class="pa-edit-grid">',
                '          <input type="text" class="pa-input" data-pa="edit-name" maxlength="160" placeholder="Название режима">',
                '          <select class="pa-select pa-select-sm" data-pa="edit-type" aria-label="Вид теста"></select>',
                '        </div>',
                '        <textarea class="pa-textarea" data-pa="edit-area" spellcheck="false" aria-label="Текст промпта (Markdown)"></textarea>',
                '        <div class="pa-edit-actions">',
                '          <button type="button" class="pa-btn" data-pa="edit-cancel">Отмена</button>',
                '          <button type="button" class="pa-btn pa-btn-primary" data-pa="edit-save">Сохранить промпт</button>',
                '        </div>',
                '      </div>',
                '    </div>',
                '    <div class="pa-add">',
                '      <input type="text" class="pa-input" data-pa="new-name" maxlength="160" placeholder="Название нового режима">',
                '      <select class="pa-select pa-select-sm" data-pa="new-type" aria-label="Вид теста нового режима"></select>',
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

        function fillTypeSelect(select, value) {
            select.innerHTML = Object.keys(TYPE_LABELS).map(key =>
                '<option value="' + key + '">' + escapeHtml(TYPE_LABELS[key]) + '</option>').join('');
            select.value = normalizeType(value) || 'rt';
        }

        function startEdit() {
            const prompt = selectedPrompt();
            if (!prompt) { dialogStatus('Сначала выберите режим', true); return; }
            dialog.editing = true;
            dialog.els['edit-name'].value = prompt.name || '';
            fillTypeSelect(dialog.els['edit-type'], prompt.type || config.type);
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
                updated = updateMode(prompt.id, {
                    name: dialog.els['edit-name'].value,
                    type: dialog.els['edit-type'].value,
                    text: dialog.els['edit-area'].value,
                });
            } catch (e) {
                dialogStatus(e.message, true);
                return;
            }
            dialog.selectedId = updated.id;
            cancelEdit();
            renderDialog();
            dialogStatus('Промпт обновлён. Нажмите «Сохранить в Gist», чтобы записать изменение.');
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
                const ok = typeof window !== 'undefined' && typeof window.confirm === 'function'
                    ? window.confirm('Удалить режим «' + prompt.name + '»? Изменение попадёт в Gist только после сохранения.')
                    : true;
                if (!ok) return;
                try {
                    removeMode(prompt.id);
                    dialog.selectedId = getModeId();
                    renderDialog();
                    dialogStatus('Режим удалён. Нажмите «Сохранить в Gist», чтобы записать изменение.');
                } catch (e) { dialogStatus(e.message, true); }
                return;
            }
            if (action === 'add') {
                try {
                    const mode = addMode({
                        name: dialog.els['new-name'].value,
                        type: dialog.els['new-type'].value,
                        text: '',
                    });
                    dialog.els['new-name'].value = '';
                    dialog.selectedId = mode.id;
                    renderDialog();
                    startEdit();
                    dialogStatus('Режим добавлен. Напишите текст промпта, нажмите «Сохранить промпт», затем «Сохранить в Gist».');
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
                    dialogStatus('Токен сохранён, загрузка промптов…');
                    await reloadDialog();
                } else {
                    await reloadDialog();
                    dialogStatus('Токен удалён: промпты доступны только для чтения');
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
                if (!typedModes().some(p => p.id === dialog.selectedId)) dialog.selectedId = getModeId();
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
                (config.type ? '' : ' · ' + escapeHtml(mode.typeLabel)) +
                (mode.empty ? ' — промпт пуст' : '') + '</option>').join('');
            if (!modes.length) {
                els.select.innerHTML = '<option value="">— промпты не загружены —</option>';
            }

            const fallback = getModeId() || (modes[0] && modes[0].id) || '';
            if (!modes.some(m => m.id === dialog.selectedId)) dialog.selectedId = fallback;
            if (dialog.selectedId) els.select.value = dialog.selectedId;

            // Виды теста для полей «вид теста» при правке и добавлении.
            const typeOptions = Object.keys(TYPE_LABELS).map(key =>
                '<option value="' + key + '">' + escapeHtml(TYPE_LABELS[key]) + '</option>').join('');
            els['edit-type'].innerHTML = typeOptions;
            els['new-type'].innerHTML = typeOptions;
            els['new-type'].value = config.type || 'rt';

            const prompt = selectedPrompt();
            if (prompt) {
                els['preview-title'].textContent = 'Промпт «' + prompt.name + '»';
                const source = prompt.source === 'gist' ? 'из Gist'
                    : prompt.source === 'local' ? 'новый (не сохранён)' : 'локальный';
                els['preview-meta'].textContent = typeLabel(prompt.type) + ' · ' + source +
                    ' · ' + (prompt.text || '').length + ' символов' +
                    (hasUnsavedChanges() ? ' · есть несохранённые изменения' : '');
                els.preview.textContent = prompt.text || '— промпт пуст —';
                els['edit-type'].value = normalizeType(prompt.type) || config.type || 'rt';
                els.edit.disabled = !hasToken();
                els.delete.disabled = !hasToken();
                els.add.disabled = !hasToken();
                els.apply.disabled = !(prompt.text || '').trim();
            } else {
                els['preview-title'].textContent = 'Режим не выбран';
                els['preview-meta'].textContent = '';
                els.preview.textContent = '— нет данных —';
                els.edit.disabled = true;
                els.delete.disabled = true;
                els.add.disabled = true;
                els.apply.disabled = true;
            }

            els['token-box'].hidden = hasToken();
            // Ссылку на Gist не перезаписываем, пока пользователь её вводит.
            if (document.activeElement !== els.gist) els.gist.value = state.gistUrl || '';
            els.save.disabled = !hasToken();
            els.foot.textContent = 'Промптов: ' + modes.length +
                (config.type ? ' · вид: ' + typeLabel(config.type) : '') +
                ' · ' + (hasToken() ? 'Gist доступен для правки' : 'только чтение — нужен GitHub Token') +
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

        // Промпты видны сразу, не дожидаясь сети: из кэша последней удачной
        // загрузки. load() обновляет их из Gist.
        if (!state.modes.length) {
            const cached = modesFromCache();
            if (cached) state.modes = cached;
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
        parsePromptsXml,
        buildPromptsXml,
        normalizeType,
        TYPE_LABELS,
        promptIdFromTitle,
        gistIdFromRef,
        DEFAULT_PROMPTS_GIST_URL,
        PromptsApiError,
    };
});
