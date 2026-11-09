<?php
/**
 * =========================================================================
 *  File API — эндпоинт публикации XML-заданий на сервере tregubovvn.ru.
 * =========================================================================
 *  Принимает JSON-запросы от библиотеки file-api.js (методы
 *  publishToServer и listServerFiles) и от любых сторонних приложений.
 *
 *  Действия (поле action в JSON-теле):
 *    publish — сохранить XML-файл в папку архива заданий.
 *              Имя файла строго вида: <Тип>_<10 цифр>.xml, где Тип —
 *              ReadTest | MoodleTest | FormulaTest.
 *              Пример: ReadTest_8241937605.xml
 *    list    — вернуть список файлов в папке архива.
 *
 *  Доступ к обоим действиям защищён паролем (константа SERVER_PASSWORD ниже).
 *  Сами файлы доступны публично по прямым ссылкам вида
 *  https://tregubovvn.ru/Task_Arhive/ReadTest_8241937605.xml —
 *  это нужно, чтобы приложение тестирования могло открыть тест.
 *  Сервер работает по HTTPS — на хостинге должен быть включён
 *  действительный SSL-сертификат.
 *
 *  Требования: PHP 7.4+.
 *  Установка и настройка — см. README-server.md (рядом с этим файлом).
 * =========================================================================
 */

declare(strict_types=1);

/* ============================ НАСТРОЙКИ ============================ */

// Пароль публикации — ЗАДАЙТЕ СВОЙ и укажите его же в настройках тестовой
// страницы (⚙ Настройки → «Пароль публикации») или в api.setToken('server', …)
const SERVER_PASSWORD = 'CHANGE_ME_PASSWORD';

// Папка архива заданий. По умолчанию — рядом с этим файлом:
// скрипт лежит в корне сайта -> папка https://tregubovvn.ru/Task_Arhive/
const ARCHIVE_DIR = __DIR__ . '/Task_Arhive';

// Адрес сайта для сборки публичных ссылок на файлы (без слеша на конце)
const PUBLIC_BASE_URL = 'https://tregubovvn.ru';

// Максимальный размер одного файла, байт (512 КБ — с запасом для XML)
const MAX_CONTENT_SIZE = 524288;

// Допустимые типы задания (префикс имени файла)
const ALLOWED_TASK_TYPES = ['ReadTest', 'MoodleTest', 'FormulaTest'];

// ====================================================================

/** Единый ответ сервера (JSON) + завершение работы. */
function respond(bool $ok, string $message, array $data = [], int $http = 200): void
{
    http_response_code($http);
    echo json_encode(
        array_merge(['ok' => $ok, 'message' => $message], $data),
        JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES
    );
    exit;
}

/* CORS: тестовая страница и интегрируемые приложения могут находиться
   на других доменах. При желании ограничьте: замените * на список
   своих origin (в заголовке можно указать только один origin за раз). */
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');
header('Content-Type: application/json; charset=utf-8');

/* Preflight-запрос браузера — отвечаем, что всё разрешено */
if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') {
    http_response_code(204);
    exit;
}

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    respond(false, 'Метод не поддерживается — используйте POST с JSON-телом', [], 405);
}

/* ---------- Разбор запроса ---------- */

$raw = file_get_contents('php://input');
if ($raw === false || $raw === '') {
    respond(false, 'Пустой запрос — ожидается JSON-тело', [], 400);
}
$body = json_decode($raw, true);
if (!is_array($body)) {
    respond(false, 'Некорректный JSON в теле запроса', [], 400);
}

/* ---------- Проверка пароля (для любого действия) ---------- */

$password = (string)($body['password'] ?? '');
if ($password === '') {
    respond(false, 'Не передан пароль публикации', [], 401);
}
if (!hash_equals(SERVER_PASSWORD, $password)) {
    // небольшая пауза против перебора пароля
    usleep(300000);
    respond(false, 'Неверный пароль публикации', [], 401);
}

$action = (string)($body['action'] ?? 'publish');

/* ---------- Действие: list — список файлов в архиве ---------- */

if ($action === 'list') {
    $files = [];
    if (is_dir(ARCHIVE_DIR)) {
        $names = scandir(ARCHIVE_DIR);
        if ($names !== false) {
            foreach ($names as $name) {
                $path = ARCHIVE_DIR . '/' . $name;
                if (!is_file($path) || !preg_match('/\.xml$/i', $name)) continue;
                $files[] = [
                    'name'     => $name,
                    'size'     => filesize($path),
                    'modified' => date('c', (int)filemtime($path)),
                    'url'      => PUBLIC_BASE_URL . '/' . basename(ARCHIVE_DIR) . '/' . rawurlencode($name),
                ];
            }
        }
    }
    // свежие сверху
    usort($files, static function (array $a, array $b): int {
        return strcmp($b['modified'], $a['modified']);
    });
    respond(true, 'Файлов в архиве: ' . count($files), [
        'files' => $files,
        'url'   => PUBLIC_BASE_URL . '/' . basename(ARCHIVE_DIR),
    ]);
}

/* ---------- Действие: publish — сохранить файл ---------- */

if ($action !== 'publish') {
    respond(false, 'Неизвестное действие: ' . $action . ' (publish | list)', [], 400);
}

$fileName = (string)($body['fileName'] ?? '');

// Строгая проверка имени: <Тип>_<ровно 10 цифр>.xml — заодно исключает
// path traversal (в имени невозможны «/» и «..»)
$typesPattern = implode('|', ALLOWED_TASK_TYPES);
if (preg_match('/^(' . $typesPattern . ')_\d{10}\.xml$/', $fileName) !== 1) {
    respond(false, 'Имя файла должно быть вида ' . $typesPattern . '_1234567890.xml', [], 400);
}

$content = (string)($body['content'] ?? '');
if (trim($content) === '') {
    respond(false, 'Пустое содержимое файла', [], 400);
}
$contentLength = strlen($content);
if ($contentLength > MAX_CONTENT_SIZE) {
    respond(false, 'Файл больше ' . (int)(MAX_CONTENT_SIZE / 1024) . ' КБ', [], 413);
}

// Лёгкая проверка, что это похоже на XML (защита от загрузки мусора)
if (strpos(ltrim($content), '<?xml') !== 0 && strpos(ltrim($content), '<quiz') !== 0) {
    respond(false, 'Содержимое не похоже на XML-задание (ожидается <?xml или <quiz)', [], 400);
}

/* ---------- Запись файла ---------- */

if (!is_dir(ARCHIVE_DIR) && !mkdir(ARCHIVE_DIR, 0755, true)) {
    respond(false, 'Не удалось создать папку ' . basename(ARCHIVE_DIR) . ' — создайте её вручную и дайте права на запись', [], 500);
}
if (!is_writable(ARCHIVE_DIR)) {
    respond(false, 'Нет прав на запись в папку ' . basename(ARCHIVE_DIR), [], 500);
}

$path = ARCHIVE_DIR . '/' . $fileName;
$exists = is_file($path);

if (@file_put_contents($path, $content, LOCK_EX) === false) {
    respond(false, 'Не удалось записать файл — проверьте права на папку', [], 500);
}
@chmod($path, 0644);

respond(true, $exists ? 'Файл обновлён' : 'Файл опубликован', [
    'fileName' => $fileName,
    'size'     => $contentLength,
    'url'      => PUBLIC_BASE_URL . '/' . basename(ARCHIVE_DIR) . '/' . $fileName,
    'updated'  => $exists,
]);
