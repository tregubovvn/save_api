# Moodle File API

Файловый сервис, выделенный в результате рефакторинга **Moodle XML Редактора**.
В коде оставлены только возможности, связанные с файлами:

| Возможность | Что умеет |
|---|---|
| **Загрузка** | файл с диска (File System Access API + fallback `<input type=file>`), GitHub Gist (ссылка / raw / ID) |
| **Сохранение** | запись в выбранный файл без повторных диалогов, диалог «Сохранить как», скачивание (Firefox/Safari), автосохранение с задержкой |
| **Публикация** | GitHub Gist (создание/обновление приватного Gist), GitVerse (коммит XML в репозиторий), собственный сервер (tregubovvn.ru — папка Task_Arhive по паролю, имя файла `<Тип>_<10 цифр>.xml`), сборка ссылки на приложение тестирования (mt_v2) |

Библиотека **не зависит от UI редактора**: содержимое — произвольный текст (обычно Moodle XML), интерфейс отдаётся вызывающему приложению через методы и события.

```
moodle-file-api/
├── file-api.js            — библиотека (единственный файл, без зависимостей)
├── index.html             — тестовая страница (проверка всех возможностей)
├── app.js                 — код тестовой страницы (пример интеграции)
├── style.css              — стили тестовой страницы
├── README.md
└── server/                — серверная часть публикации на свой сайт
    ├── publish.php        — PHP-эндпоинт приёма файлов (загрузить на хостинг)
    ├── htaccess.txt       — положить в папку архива под именем .htaccess
    └── README-server.md   — инструкция по настройке сервера
```

---

## Быстрый старт

```html
<script src="file-api.js"></script>
<script>
    const api = FilesApi.create({ gistFilename: 'quiz.xml' });

    // Токены и пароли (хранятся в localStorage браузера)
    api.setToken('github', 'ghp_…');      // Gist
    api.setToken('gitverse', '…');        // публикация в репозиторий
    api.setToken('server', '…');          // пароль публикации на свой сервер

    // Содержимое (например, из вашего <textarea>)
    api.setContent(xmlText);              // помечает задание изменённым, планирует автосохранение

    // События для обновления своего интерфейса
    api.on('status', e => console.log(e.message));
    api.on('load',   e => console.log('загружено:', e.fileName));
    api.on('save',   e => console.log('сохранено:', e.method, e.fileName));
    api.on('publish',e => console.log('опубликовано:', e.rawUrl, e.taskUrl));
</script>
```

Все методы возвращают Promise и бросают `FilesApiError` (свойство `code`) при неудаче — перехватывайте через `try/catch`:

```js
try {
    const r = await api.publishToGist({ description: 'Коэффициент нервной регуляции' });
    location.href = r.taskUrl;            // открыть тест в приложении mt_v2
} catch (e) {
    if (e.code === 'GITHUB_TOKEN_REQUIRED') api.setToken('github', prompt('GitHub Token'));
    if (e.code === 'VALIDATION') alert(e.message);   // не прошла проверка beforePublish
}
```

---

## API

### Содержимое

| Метод | Описание |
|---|---|
| `setContent(text, opts?)` | Установить содержимое. По умолчанию: `dirty = true`, событие `content-change`, планирование автосохранения. `{silent: true}` — только присвоить |
| `getContent()` | Текущее содержимое (строка) |
| `getFileName()` / `setFileName(name)` | Базовое имя файла (используется при сохранении и в GitVerse) |

### Загрузка

| Метод | Описание |
|---|---|
| `loadFromFile(opts?)` | Открыть файл с диска. Chrome/Edge — `showOpenFilePicker` (файл запоминается: дальнейшие сохранения пишутся в него без диалогов); Firefox/Safari — `<input type="file">` (сохранение — через скачивание). `{fsAccess: false}` — принудительно fallback. Возвращает `{source:'file', fileName, content}` или `null` (отмена) |
| `loadFromGist(ref, opts?)` | Загрузить из GitHub Gist. `ref` — ссылка `gist.github.com/user/id`, raw-ссылка, ID или даже ссылка теста с `?name=<raw>`. Приватные Gist требуют GitHub Token, публичные читаются без него. Возвращает `{source:'gist', fileName, content, gist:{gistId, gistUrl, rawUrl, description}}` |
| `extractGistId(ref)` | ID Gist из любой принятой формы ссылки (или `null`) |

После `loadFromGist` Gist **привязывается**: последующий `publishToGist()` обновит именно его (как в редакторе).

### Сохранение

| Метод | Описание |
|---|---|
| `saveToFile(opts?)` | Порядок: 1) уже выбранный файл — запись без диалогов; 2) диалог «Сохранить как» (Chrome/Edge); 3) скачивание. `{fileName}` — имя. Возвращает `{ok, method:'handle'|'picker'|'download', fileName}` |
| `setAutosave(enabled)` | Включить/выключить автосохранение (запоминается в localStorage) |
| `isAutosaveEnabled()` | Текущее состояние |
| `scheduleAutosave()` | Планирование вручную (после своих изменений) |
| `getLastSaveTime()` | Метка времени последней записи на диск |

Автосохранение работает **только в ранее выбранный файл** (File System Access API): после изменений пишёт в него через 1,5 с (настраивается `autoSaveDebounceMs`). Если файл ещё не выбран — библиотека не скачивает файлы молча, а просит один раз выбрать файл (событие `autosave-skip`).

### Публикация

| Метод | Описание |
|---|---|
| `publishToGist(opts?)` | Создать приватный Gist или обновить привязанный. `{description, gistId?, gistFilename?, token?}`. Возвращает `{target:'gist', gistId, gistUrl, rawUrl, taskUrl}` |
| `publishToGitverse(opts?)` | Коммит XML в репозиторий GitVerse. `{repo?, fileName?, branch?, message?, description?, token?}`. Если `repo` не указан — берётся запомненный, иначе выбирается автоматически (предпочтение репозиториям с `moodle/quiz/test` в названии). Возвращает `{target:'gitverse', project, branch, fileName, rawUrl, taskUrl}` |
| `publishToServer(opts?)` | **Публикация на свой сервер** (tregubovvn.ru). `{taskType?, password?, endpoint?, folder?, fileName?, description?}`. Имя файла генерируется само: `<Тип>_<10 случайных цифр>.xml`, где `Тип` — один из `ReadTest`, `MoodleTest`, `FormulaTest`. Пароль — `api.setToken('server', …)`. Возвращает `{target:'server', fileName, taskType, rawUrl, taskUrl, updated}` |
| `listServerFiles(opts?)` | Список файлов в папке архива на сервере: `{password?, endpoint?, folder?}` → `{files:[{name, size, modified, url}], url}` |
| `resetPublishState()` | Отвязать Gist/файл — следующая публикация создаст новый |
| `getTaskUrl(flags?)` | Ссылка на тест в приложении mt_v2 по raw-ссылке последней публикации |
| `buildTaskUrl(rawUrl, flags, baseUrl?)` | То же из произвольной raw-ссылки. Флаги: `{checkmode, headershow, crushmode, randommode}` (в URL попадают только включённые: `&checkmode=true`…) |
| `getLastPublish()` | Информация о последней публикации |

Формат ссылки на тест (согласован с приложением mt_v2):

```
https://tregubovvn.github.io/mt_v2/index.html?name=<encodeURIComponent(rawUrl)>&checkmode=true&…
```

`testAppUrl` можно заменить в `FilesApi.create({ testAppUrl: '…' })` — тогда `taskUrl` будет вести в ваше приложение.

### Публикация на свой сервер (tregubovvn.ru)

Файлы уходят на PHP-эндпоинт (`server/publish.php` из этой поставки) и складываются
в папку архива заданий. Доступ к публикации защищён паролем; сами файлы
доступны по прямым ссылкам — по ним их открывает приложение тестирования.

```js
const api = FilesApi.create({
    serverEndpoint: 'https://tregubovvn.ru/publish.php',  // адрес publish.php
    serverFolder: 'Task_Arhive',                          // папка архива
    serverBaseUrl: 'https://tregubovvn.ru',               // адрес сайта для ссылок
    taskTypes: ['ReadTest', 'MoodleTest', 'FormulaTest'], // допустимые префиксы
});

api.setToken('server', 'пароль_с_сервера');
const r = await api.publishToServer({ taskType: 'ReadTest', description: 'Название' });
// r.fileName → «ReadTest_8241937605.xml» (случайное 10-значное число)
// r.rawUrl   → «https://tregubovvn.ru/Task_Arhive/ReadTest_8241937605.xml»
// r.taskUrl  → ссылка на тест в mt_v2

const list = await api.listServerFiles();   // что уже опубликовано
```

Пошаговая настройка сервера (загрузка `publish.php`, пароль, права папки,
HTTPS, проверка через curl, типичные ошибки) — в файле
**[server/README-server.md](server/README-server.md)**.

### Токены

```js
api.setToken('github', 'ghp_…');   // сервисы: 'github' | 'gitverse' | 'server'
api.getToken('github');
api.hasToken('gitverse');          // true/false
api.clearToken('github');
```

Хранятся в localStorage под ключами с префиксом `storagePrefix` (по умолчанию `moodleFileApi`). Токены никуда, кроме API GitHub/GitVerse и вашего эндпоинта публикации, не передаются. Для сервиса `'server'` хранится пароль публикации на ваш сайт.

### Состояние

| Метод | Описание |
|---|---|
| `isDirty()` | Есть изменения, не записанные на диск |
| `isPublishedStale()` | Содержимое изменилось после последней публикации (пора публиковать заново) |
| `getGistInfo()` | `{gistId, gistUrl, gistFilename, rawUrl}` |

### События (`api.on(событие, fn)`)

| Событие | Когда | Данные |
|---|---|---|
| `content-change` | `setContent()` без `silent` | `{content, fileName}` |
| `dirty-change` | изменился флаг несохранённых правок | `{dirty}` |
| `load` | успешная загрузка (файл/Gist) | `{source, fileName, content, gist}` |
| `save` | запись на диск | `{method, fileName, at, content}` |
| `autosave` | автосохранение выполнено | `{fileName, at, content}` |
| `autosave-skip` | автосохранение не выполнено | `{reason: 'NO_FILE' \| 'NO_PERMISSION'}` |
| `autosave-change` | переключение автосохранения | `{enabled}` |
| `publish` | публикация (Gist/GitVerse) | `{target, rawUrl, taskUrl, …}` |
| `publish-reset` | сброс привязки публикации | `{}` |
| `file-selected` | выбран файл для записи | `{fileName}` |
| `token-change` | изменился токен | `{service, has}` |
| `status` | текстовый статус для статус-строки | `{message}` |
| `error` | ошибка внутри фоновых операций (автосохранение) | `{error, context}` |

`api.on()` возвращает функцию отписки: `const off = api.on('save', fn); off();`

### Хуки конфигурации

```js
const api = FilesApi.create({
    // Проверка при каждой загрузке (файл и Gist): null — ок, строка — причина отказа
    validate: content => /<quiz[\s>]/i.test(content) ? null : 'Это не Moodle XML',

    // Проверка перед публикацией (как в редакторе: у всех вопросов
    // должен быть выбран правильный ответ)
    beforePublish: content => {
        // null/true — публиковать можно; false | строка | {ok:false, reason} — отказ
        return checkQuizAnswers(content);
    },

    gistFilename: 'quiz.xml',      // имя файла внутри Gist
    fileName: 'quiz.xml',          // имя по умолчанию на диске
    autoSaveDebounceMs: 1500,
    testAppUrl: 'https://…',       // приложение тестирования для getTaskUrl()
    // Публикация на свой сервер
    serverEndpoint: 'https://tregubovvn.ru/publish.php',
    serverFolder: 'Task_Arhive',
    serverBaseUrl: 'https://tregubovvn.ru',
    serverExt: '.xml',
    taskTypes: ['ReadTest', 'MoodleTest', 'FormulaTest'],
    defaultTaskType: 'ReadTest',
    accept: { 'text/xml': ['.xml'] },
    storagePrefix: 'moodleFileApi',
});
```

Коды ошибок `FilesApiError`: `VALIDATION`, `GITHUB_TOKEN_REQUIRED`, `GITVERSE_TOKEN_REQUIRED`, `SERVER_PASSWORD_REQUIRED`, `SERVER_URL_REQUIRED`, `SERVER_AUTH`, `BAD_REF`, `EMPTY`, `PERMISSION`, `HTTP`, `NETWORK`, `NO_REPO`, `DOM_REQUIRED`, `BAD_SERVICE`.

---

## Тестовая страница

Проверяет все возможности через публичное API (каждая кнопка журналирует вызов, результат и ошибки — см. «Журнал вызовов API»):

1. **Содержимое** — пример Moodle XML, ручное редактирование, индикаторы `dirty` / «опубликованный вариант устарел».
2. **Загрузка из файла** — диалог выбора; после выбора файл становится целевым для сохранений.
3. **Сохранение в файл** — запись в выбранный файл / диалог / скачивание (в Firefox/Safari).
4. **Автосохранение** — переключатель; измените содержимое и подождите 1,5 с.
5. **Загрузка из Gist** — вставьте ссылку/ID (приватные — с GitHub Token).
6. **Публикация** — GitHub Gist, GitVerse и **свой сервер tregubovvn.ru** (выбор типа ReadTest/MoodleTest/FormulaTest, пароль в ⚙ Настройки, кнопка «📄 Файлы на сервере» показывает список опубликованного); повторная публикация обновляет тот же Gist/файл, «✂ Сбросить привязку» создаёт новый.
7. **Ссылка на тест** — флаги CheckMode/ShowHeader/CrushMode/RandomMode, копирование.

Запуск (нужен любой статический сервер — File System Access API требует secure context):

```bash
cd moodle-file-api
python3 -m http.server 8080
# откройте http://localhost:8080/
```

Через `file://` страница тоже откроется, но диалоги File System Access API могут быть недоступны — сохранение тогда пойдёт через скачивание. Параметр `?no-fs` принудительно отключает File System Access API (проверка fallback-пути).

---

## Ограничения и заметки

- **CORS**: запросы к `api.github.com`, `gitverse.ru/api/v2` и вашему эндпоинту публикации выполняются из браузера напрямую, как в исходном редакторе. `publish.php` уже отдаёт CORS-заголовки и обрабатывает preflight-запросы.
- **File System Access API** поддерживается Chrome/Edge; в Firefox/Safari автоматический fallback на `<input type="file">` и скачивание — автосохранение в выбранный файл там недоступно.
- Страница работает откуда угодно (`https://`, `http://`, `localhost`, `file://`): сервер публикации tregubovvn.ru работает по HTTPS, поэтому запросы к нему браузер не блокирует даже с HTTP-страниц. Для диалогов File System Access API нужен secure context (`https://` или `localhost`) — с обычного HTTP/`file://` сохранение автоматически идёт через скачивание.
- Привязка публикации (gistId и т.п.) живёт в памяти страницы — после перезагрузки `publishToGist()` создаст новый Gist (привязку можно восстановить через `loadFromGist()`).
- Каждая публикация на сервер создаёт файл с новым случайным номером (имена не перезаписываются) — папка архива пополняется.
