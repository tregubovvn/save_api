'use strict';

/* =========================================================================
   ResultsApi — сохранение результатов теста во внешнюю базу (Student Tracker).

   Выделено из rt_v2 (public/api.js → StudentAPI) и mt_v2 (встроенный клиент
   Supabase в app.js): обе реализации делали одно и то же — проверяли поля,
   ограничивали частоту записи, отправляли запись и открывали страницу оценок.

   Провайдер — Supabase-совместимый REST:
     POST {endpoint}/rest/v1/{table}   — создать запись
     GET  {endpoint}/rest/v1/{table}?student_id=eq.{id}&order=date_time.desc
   Заголовки: apikey + Authorization: Bearer <apiKey>.

   Подключение:
     <script src="results-api.js"></script>
     const results = ResultsApi.create({
         endpoint: 'https://<project>.supabase.co',
         apiKey: '<anon key>',
     });
     await results.save({ studentId: '123456', activity: 'RE:AD — тест', grade: '4' });
   ========================================================================= */

(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();          // CommonJS (Node, сборщики)
    } else {
        root.ResultsApi = factory();         // глобальная переменная (браузер)
    }
})(typeof self !== 'undefined' ? self : this, function () {

    const VERSION = '1.0.0';

    const DEFAULTS = {
        endpoint: '',                 // адрес проекта Supabase (без /rest/v1)
        apiKey: '',                   // anon key; для приватных таблиц — ключ с правами записи
        table: 'records',
        minIntervalMs: 10 * 60 * 1000, // ограничение частоты записей на одного студента
        storagePrefix: 'studentResults',
        headers: {},                  // дополнительные заголовки запроса
    };

    class ResultsApiError extends Error {
        constructor(message, code) {
            super(message);
            this.name = 'ResultsApiError';
            this.code = code || 'ERROR';
        }
    }

    // localStorage с запасным вариантом в памяти (Node, приватный режим)
    function safeStorage() {
        try {
            const t = '__mra_probe__';
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

    function create(options = {}) {
        const config = Object.assign({}, DEFAULTS, options);
        const store = safeStorage();
        const K = { studentId: config.storagePrefix + '_student_id' };
        const state = { listeners: {}, lastSaved: null };

        /* --------------------------- События --------------------------- */

        function emit(event, payload) {
            const set = state.listeners[event];
            if (!set) return;
            set.forEach(fn => {
                try { fn(payload); } catch (e) {
                    if (typeof console !== 'undefined') console.error('[ResultsApi] ошибка подписчика "' + event + '":', e);
                }
            });
        }

        function fail(err, context) {
            const e = err instanceof Error ? err : new ResultsApiError(String(err));
            if (context) e.context = context;
            throw e;
        }

        /* --------------------------- Запросы --------------------------- */

        function baseUrl(path) {
            const base = String(config.endpoint || '').replace(/\/+$/, '');
            if (!base) fail(new ResultsApiError('Не задан endpoint проекта', 'ENDPOINT_REQUIRED'), 'request');
            return base + path;
        }

        function headers(extra) {
            return Object.assign({
                'apikey': config.apiKey,
                'Authorization': 'Bearer ' + config.apiKey,
                'Content-Type': 'application/json',
            }, config.headers || {}, extra || {});
        }

        async function request(url, opts, context) {
            let res;
            try {
                res = await fetch(url, opts);
            } catch (e) {
                fail(new ResultsApiError('Сеть: ' + e.message, 'NETWORK'), context);
            }
            let text = '';
            try { text = await res.text(); } catch (e) { text = ''; }
            let data = null;
            if (text) {
                try { data = JSON.parse(text); } catch (e) { data = null; }
            }
            if (!res.ok) {
                const detail = (data && (data.message || data.error_description || data.error)) ||
                    String(text || '').slice(0, 120);
                fail(new ResultsApiError('HTTP ' + res.status + (detail ? ': ' + detail : ''), 'HTTP'), context);
            }
            return { res, data, text };
        }

        /* --------------------------- Записи --------------------------- */

        function normalizeRecord(input) {
            const studentId = String((input && input.studentId) || '').trim();
            if (!studentId) {
                fail(new ResultsApiError('Не указан ИД студента', 'STUDENT_ID_REQUIRED'), 'save');
            }
            const activity = String((input && input.activity) || '').trim();
            if (!activity) {
                fail(new ResultsApiError('Не указано название активности', 'ACTIVITY_REQUIRED'), 'save');
            }
            const grade = input && input.grade;
            if (grade === undefined || grade === null || String(grade).trim() === '') {
                fail(new ResultsApiError('Не указана оценка', 'GRADE_REQUIRED'), 'save');
            }
            return {
                student_id: studentId,
                activity,
                grade: String(grade),
                comment: String((input && input.comment) || ''),
                date_time: (input && input.dateTime) || new Date().toISOString(),
            };
        }

        // Сколько ещё ждать до следующей разрешённой записи для этого студента.
        // Ограничение дублирует серверное, но нужно для понятного сообщения.
        async function rateLimitStatus(studentId) {
            const interval = Number(config.minIntervalMs) || 0;
            if (interval <= 0) return { limited: false, waitMs: 0 };
            const last = await list(studentId, { limit: 1 });
            if (!last.length) return { limited: false, waitMs: 0 };
            const diff = Date.now() - new Date(last[0].date_time).getTime();
            const waitMs = interval - diff;
            return { limited: diff >= 0 && waitMs > 0, waitMs: Math.max(0, waitMs) };
        }

        async function list(studentId, opts = {}) {
            const id = String(studentId || '').trim();
            if (!id) fail(new ResultsApiError('Не указан ИД студента', 'STUDENT_ID_REQUIRED'), 'list');

            let url = baseUrl('/rest/v1/' + config.table) +
                '?student_id=eq.' + encodeURIComponent(id) +
                '&order=date_time.desc';
            if (opts.limit) url += '&limit=' + encodeURIComponent(opts.limit);
            if (opts.select) url += '&select=' + encodeURIComponent(opts.select);

            const { data } = await request(url, { headers: headers() }, 'list');
            return Array.isArray(data) ? data : [];
        }

        async function save(input, opts = {}) {
            const record = normalizeRecord(input);

            if (opts.checkInterval !== false) {
                const rl = await rateLimitStatus(record.student_id);
                if (rl.limited) {
                    const total = Math.round((Number(config.minIntervalMs) || 0) / 60000);
                    const wait = Math.ceil(rl.waitMs / 60000);
                    fail(new ResultsApiError(
                        'Можно сохранять не чаще раза в ' + total + ' мин. Подождите ещё ' + wait + ' мин.',
                        'RATE_LIMIT'), 'save');
                }
            }

            const { data } = await request(baseUrl('/rest/v1/' + config.table), {
                method: 'POST',
                headers: headers({ Prefer: 'return=minimal' }),
                body: JSON.stringify(record),
            }, 'save');

            state.lastSaved = record;
            emit('result-saved', { record });
            return { success: true, record, response: data };
        }

        /* ----------------------- ИД студента в браузере ----------------------- */

        function setStudentId(value) {
            const v = String(value || '').trim();
            try {
                if (v) store.setItem(K.studentId, v);
                else store.removeItem(K.studentId);
            } catch (e) { /* ignore */ }
            emit('student-id-change', { studentId: v });
            return v;
        }

        function getStudentId() {
            try { return store.getItem(K.studentId) || ''; } catch (e) { return ''; }
        }

        /* --------------------------- Публичный API --------------------------- */

        const api = {
            version: VERSION,
            config,

            save,                 // ({studentId, activity, grade, comment, dateTime}) => {success, record}
            list,                 // (studentId, {limit}) => [{student_id, activity, grade, ...}]
            rateLimitStatus,      // (studentId) => {limited, waitMs}

            setStudentId,
            getStudentId,
            hasStudentId() { return !!getStudentId(); },

            getLastSaved: () => state.lastSaved,

            on(event, fn) {
                (state.listeners[event] = state.listeners[event] || new Set()).add(fn);
                return () => api.off(event, fn);
            },
            off(event, fn) {
                if (state.listeners[event]) state.listeners[event].delete(fn);
            },

            destroy() { state.listeners = {}; },
        };

        return api;
    }

    return { create, VERSION, ResultsApiError };
});
