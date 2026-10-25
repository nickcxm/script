"""Translation providers, persistent article archive and request deduplication."""
import concurrent.futures
import hashlib
import datetime as dt
from collections import Counter
import http.client
import json
import os
from pathlib import Path
import re
import select
import subprocess
import threading
import time
import uuid
from urllib.parse import urlencode, urlsplit

ROOT = Path(__file__).resolve().parent
TZ = dt.timezone(dt.timedelta(hours=8))
MARKER = re.compile(r'[【\[［]\s*(?:[pPＰｐ]\s*)?([0-9０-９](?:[ \t]*[0-9０-９])*)\s*[】\]］]')


class TranslationFailure(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code, self.message = code, message


def packed(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'))


def marker_id(match):
    return int(''.join(match.group(1).split()))


def without_prefix(text):
    match = MARKER.match(text.strip())
    return text.strip()[match.end():].strip() if match else text.strip()


def align(text, expected):
    """Number matching is best effort; unresolved groups stay merged, never guessed."""
    if not MARKER.sub('', text).strip():
        raise TranslationFailure('response', '翻译结果缺少正文。')
    matches = list(MARKER.finditer(text))
    numbers = [marker_id(m) for m in matches]
    if (matches and not text[:matches[0].start()].strip()
            and len(numbers) == len(set(numbers)) and set(numbers) == set(expected)):
        pieces = [{'ids': [number], 'text': text[matches[i].end():matches[i + 1].start() if i + 1 < len(matches) else len(text)].strip()}
                  for i, number in enumerate(numbers)]
        return [piece for piece in pieces if piece['text']]
    # Preserve content and its explicit range if numbering was changed or lost.
    return [{'ids': expected, 'text': text.strip()}]


def split_source(text, limit):
    while text:
        cut = min(limit, len(text))
        if cut < len(text):
            space = text.rfind(' ', cut // 2, cut)
            if space > 0:
                cut = space + 1
        yield text[:cut]
        text = text[cut:]


def make_batches(segments, limit, byte_limit=1_000_000):
    batches, current = [], []
    for item in segments:
        # The source is English; also honor Baidu's UTF-8 byte ceiling.
        head = '【%s】' % item['id']
        buffer = ''
        pieces = []
        for char in item['text'].replace('\n', ' '):
            candidate = buffer + char
            if buffer and (len(head + candidate) > limit or len((head + candidate).encode()) > byte_limit):
                pieces.append(buffer); buffer = ''
            buffer += char
        if buffer:
            pieces.append(buffer)
        for piece in pieces:
            entry = {'id': item['id'], 'text': piece}
            query = '\n'.join('【%s】%s' % (x['id'], x['text']) for x in current + [entry])
            # Repeated IDs (split long paragraphs) belong in separate requests.
            if current and (len(query) > limit or len(query.encode()) > byte_limit or any(x['id'] == entry['id'] for x in current)):
                batches.append(current); current = []
            current.append(entry)
    if current:
        batches.append(current)
    return batches


class Config:
    def __init__(self, path):
        self.path = Path(path)
        self.lock = threading.RLock()
        self.value = {'provider': 'apple', 'baidu_appid': '', 'baidu_key': ''}
        if self.path.exists():
            self.value.update(json.loads(self.path.read_text()))

    def snapshot(self):
        with self.lock:
            return dict(self.value)

    def public(self):
        data = self.snapshot()
        return {'provider': data['provider'], 'baidu_appid': data['baidu_appid'],
                'baidu_key_configured': bool(data['baidu_key'])}

    def update(self, data):
        if set(data) - {'provider', 'baidu_appid', 'baidu_key', 'clear_baidu_key'}:
            raise ValueError('Unexpected configuration fields')
        with self.lock:
            new = dict(self.value)
            if data.get('provider', new['provider']) not in ('apple', 'baidu', 'google'):
                raise ValueError('Invalid provider')
            new['provider'] = data.get('provider', new['provider'])
            if 'baidu_appid' in data:
                appid = data['baidu_appid']
                if not isinstance(appid, str) or (appid and not re.fullmatch(r'\d{5,30}', appid)):
                    raise ValueError('Invalid Baidu APP ID')
                new['baidu_appid'] = appid
            if data.get('clear_baidu_key') is True:
                new['baidu_key'] = ''
            if data.get('baidu_key'):
                key = data['baidu_key']
                if not isinstance(key, str) or len(key) > 512 or re.search(r'[\r\n]', key):
                    raise ValueError('Invalid Baidu key')
                new['baidu_key'] = key
            self.path.parent.mkdir(parents=True, exist_ok=True)
            temporary = self.path.with_suffix('.tmp')
            fd = os.open(str(temporary), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, 'w') as output:
                output.write(packed(new))
            os.replace(str(temporary), str(self.path))
            self.value = new
        return self.public()


class AppleWorker:
    def __init__(self, executable=None):
        self.executable = str(executable or ROOT / 'bin' / 'apple-translate')
        self.lock, self.process = threading.Lock(), None
        self.last_status = {'ok': False, 'code': 'not_checked'}

    def stop(self):
        if self.process:
            process, self.process = self.process, None
            process.kill()
            try:
                process.communicate(timeout=2)
            except subprocess.TimeoutExpired:
                pass

    def request(self, data, timeout=12):
        started = time.monotonic()
        if not self.lock.acquire(timeout=max(0.01, timeout)):
            raise TranslationFailure('apple_busy', 'Apple 本机翻译繁忙。')
        try:
            if not os.path.isfile(self.executable):
                raise TranslationFailure('apple_unavailable', 'Apple 翻译程序尚未就绪。')
            if self.process is None or self.process.poll() is not None:
                self.stop()
                self.process = subprocess.Popen([self.executable], stdin=subprocess.PIPE,
                                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                                text=True, bufsize=1)
            self.process.stdin.write(packed(data) + '\n')
            self.process.stdin.flush()
            remaining = timeout - (time.monotonic() - started)
            if remaining <= 0 or not select.select([self.process.stdout], [], [], remaining)[0]:
                self.stop()
                raise TranslationFailure('apple_timeout', 'Apple 本机翻译超时。')
            line = self.process.stdout.readline()
            result = json.loads(line)
            if not result.get('ok'):
                code = result.get('code', 'translation_failed')
                message = 'Apple 英中语言包尚未下载完成。' if code == 'languages_missing' else 'Apple 本机翻译失败。'
                self.last_status = result
                raise TranslationFailure('apple_' + code, message)
            self.last_status = {'ok': True, 'status': 'installed'}
            return result
        except (OSError, ValueError, BrokenPipeError):
            self.stop()
            raise TranslationFailure('apple_unavailable', 'Apple 翻译程序不可用。')
        finally:
            self.lock.release()

    def status(self):
        if self.lock.locked() and self.last_status.get('ok'):
            return dict(self.last_status)
        try:
            return self.request({'op': 'status'}, timeout=4)
        except TranslationFailure as error:
            return {'ok': False, 'code': error.code, 'message': error.message}


class Archive:
    def __init__(self, ledger):
        self.ledger = ledger
        with ledger.connect() as db:
            db.executescript('''
            CREATE TABLE IF NOT EXISTS articles (
                key TEXT PRIMARY KEY, article_id TEXT NOT NULL, title TEXT NOT NULL,
                title_translation TEXT NOT NULL DEFAULT '', source_url TEXT NOT NULL,
                source_updated_at TEXT NOT NULL, created_at TEXT NOT NULL, last_seen TEXT NOT NULL,
                source_characters INTEGER NOT NULL, status TEXT NOT NULL,
                source_json TEXT NOT NULL, result_json TEXT NOT NULL DEFAULT '{}',
                cache_hits INTEGER NOT NULL DEFAULT 0, request_count INTEGER NOT NULL DEFAULT 1);
            CREATE INDEX IF NOT EXISTS articles_seen ON articles(last_seen);
            ''')

    def get(self, key):
        with self.ledger.connect() as db:
            row = db.execute('SELECT * FROM articles WHERE key=?', (key,)).fetchone()
            if not row:
                return None
            data = dict(row)
            data['source'] = json.loads(data.pop('source_json'))
            data['result'] = json.loads(data.pop('result_json'))
            return data

    def start(self, key, source):
        now = dt.datetime.now(TZ).isoformat(timespec='milliseconds')
        with self.ledger.connect() as db:
            db.execute('''INSERT INTO articles(key,article_id,title,source_url,source_updated_at,created_at,last_seen,
                        source_characters,status,source_json) VALUES(?,?,?,?,?,?,?,?,?,?)
                        ON CONFLICT(key) DO UPDATE SET last_seen=excluded.last_seen,request_count=request_count+1''',
                       (key, source['article']['id'], source['article']['title'], source['article']['url'],
                        source['article']['updatedAt'], now, now,
                        len(source['article']['title']) + sum(len(x['text']) for x in source['paragraphs']), 'translating', packed(source)))

    def finish(self, key, result):
        with self.ledger.connect() as db:
            db.execute('UPDATE articles SET result_json=?,title_translation=?,status=? WHERE key=?',
                       (packed(result), result['titleTranslation'], 'complete' if result['complete'] else 'partial', key))

    def hit(self, key):
        with self.ledger.connect() as db:
            db.execute('UPDATE articles SET cache_hits=cache_hits+1,request_count=request_count+1,last_seen=? WHERE key=?',
                       (dt.datetime.now(TZ).isoformat(timespec='milliseconds'), key))

    def listing(self, offset=0):
        with self.ledger.connect() as db:
            rows = db.execute('''SELECT key,article_id,title,title_translation,source_url,created_at,last_seen,
                         source_characters,status,cache_hits,request_count FROM articles ORDER BY last_seen DESC LIMIT 30 OFFSET ?''', (offset,))
            return {'articles': [dict(row) for row in rows],
                    'total': db.execute('SELECT COUNT(*) FROM articles').fetchone()[0],
                    'cache_hits': db.execute('SELECT COALESCE(SUM(cache_hits),0) FROM articles').fetchone()[0], 'offset': offset}


def validate_article(data):
    if set(data) - {'article', 'paragraphs'}:
        raise ValueError('Unexpected article fields')
    article, paragraphs = data.get('article'), data.get('paragraphs')
    if not isinstance(article, dict) or set(article) - {'id', 'title', 'url', 'updatedAt', 'publishedAt'}:
        raise ValueError('Invalid article')
    for key, maximum in [('id', 250), ('title', 2000), ('url', 2000), ('updatedAt', 100), ('publishedAt', 100)]:
        if not isinstance(article.get(key, ''), str) or len(article.get(key, '')) > maximum:
            raise ValueError('Invalid article field')
    if not article.get('id') or not article.get('title'):
        raise ValueError('Article id and title required')
    url = urlsplit(article.get('url', ''))
    if url.scheme != 'https' or url.hostname not in ('www.bloomberg.com', 'bloomberg.com', 'cdn-mobapi.bloomberg.com') or url.username or url.password:
        raise ValueError('Invalid source URL')
    if not isinstance(paragraphs, list) or not 0 < len(paragraphs) <= 500:
        raise ValueError('Invalid paragraphs')
    seen, normalized = set(), []
    for item in paragraphs:
        if not isinstance(item, dict) or set(item) != {'id', 'text'}:
            raise ValueError('Invalid paragraph')
        number, text = item['id'], item['text']
        if type(number) is not int or not 1 <= number <= 500 or number in seen or not isinstance(text, str) or not text.strip():
            raise ValueError('Invalid paragraph')
        seen.add(number)
        normalized.append({'id': number, 'text': text})
    if sum(len(x['text']) for x in normalized) > 100_000:
        raise ValueError('Article too long')
    return {'article': {'id': article['id'], 'title': article['title'], 'url': article['url'],
                        'updatedAt': article.get('updatedAt', ''), 'publishedAt': article.get('publishedAt', '')}, 'paragraphs': normalized}


class Translator:
    def __init__(self, ledger, config, apple=None):
        self.ledger, self.config = ledger, config
        self.archive = Archive(ledger)
        self.apple = apple or AppleWorker()
        self.flights, self.flight_lock = {}, threading.Lock()
        self.baidu_lock, self.baidu_start = threading.Lock(), 0
        self.google_pool = concurrent.futures.ThreadPoolExecutor(max_workers=3)
        self.active = threading.BoundedSemaphore(8)

    def translate(self, payload):
        source = validate_article(payload)
        config = self.config.snapshot()
        key = hashlib.sha256(packed({'version': 1, 'provider': config['provider'], 'source': source}).encode()).hexdigest()
        existing = self.archive.get(key)
        if existing and existing['status'] == 'complete':
            self.archive.hit(key)
            return dict(existing['result'], cacheHit=True)
        with self.flight_lock:
            event = self.flights.get(key)
            owner = event is None
            if owner:
                event = threading.Event(); self.flights[key] = event
        if not owner:
            if not event.wait(43):
                raise TranslationFailure('busy', '同一篇文章仍在翻译，请稍后重试。')
            existing = self.archive.get(key)
            if existing and existing['result'].get('translations'):
                self.archive.hit(key)
                return dict(existing['result'], cacheHit=True)
            raise TranslationFailure('translation_failed', '本次文章翻译未成功。')
        try:
            if not self.active.acquire(timeout=1):
                raise TranslationFailure('busy', '翻译队列已满，请稍后重试。')
            try:
                cached = self.archive.get(key)
                if cached and cached['status'] == 'complete':
                    self.archive.hit(key)
                    return dict(cached['result'], cacheHit=True)
                self.archive.start(key, source)
                result = self._translate(key, source, config, time.monotonic() + 40)
                self.archive.finish(key, result)
                return result
            finally:
                self.active.release()
        finally:
            with self.flight_lock:
                self.flights.pop(key, None); event.set()

    def _record(self, provider, key, count, config, operation):
        appid = config['baidu_appid'] if provider == 'baidu' else ''
        call_id = uuid.uuid4().hex
        ticket = self.ledger.reserve({'id': call_id, 'provider': provider, 'appid': appid, 'characters': count})
        with self.ledger.connect() as db:
            db.execute('UPDATE calls SET article_key=? WHERE id=?', (key, call_id))
        if not ticket['allowed']:
            raise TranslationFailure('monthly_quota', '百度本月 100 万字符预算已用完。')
        start = time.monotonic()
        try:
            result = operation()
        except TranslationFailure as error:
            self.ledger.complete({'id': call_id, 'state': 'failed', 'error': error.code, 'elapsed_ms': round((time.monotonic()-start)*1000)})
            raise
        except Exception:
            self.ledger.complete({'id': call_id, 'state': 'failed', 'error': 'unexpected', 'elapsed_ms': round((time.monotonic()-start)*1000)})
            raise TranslationFailure('provider_error', '翻译服务返回异常。')
        else:
            self.ledger.complete({'id': call_id, 'state': 'success', 'elapsed_ms': round((time.monotonic()-start)*1000)})
            return result

    def _http(self, host, path, deadline, body=None):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TranslationFailure('timeout', '本篇翻译超时。')
        conn = http.client.HTTPSConnection(host, timeout=min(5, remaining))
        try:
            conn.request('POST' if body is not None else 'GET', path, body=body,
                         headers={'Content-Type': 'application/x-www-form-urlencoded'} if body is not None else {'Accept': 'application/json'})
            response = conn.getresponse()
            raw = response.read(2_000_001)
            if response.status != 200 or len(raw) > 2_000_000:
                raise TranslationFailure('http_%s' % response.status, '翻译接口返回 HTTP %s。' % response.status)
            return json.loads(raw)
        except (OSError, ValueError, http.client.HTTPException):
            raise TranslationFailure('network', '翻译接口网络错误或响应无法解析。')
        finally:
            conn.close()

    def _google(self, batch, key, config, deadline):
        if time.monotonic() >= deadline:
            raise TranslationFailure('timeout', '本篇翻译超时。')
        query = '\n'.join('【%s】%s' % (x['id'], x['text']) for x in batch)
        def operation():
            raw = self._http('translate.googleapis.com', '/translate_a/single?' + urlencode(
                {'client': 'gtx', 'sl': 'en', 'tl': 'zh-CN', 'dt': 't', 'q': query}), deadline)
            try:
                text = ''.join(x[0] for x in raw[0]).strip()
                if not text:
                    raise ValueError()
            except (TypeError, IndexError, ValueError):
                raise TranslationFailure('response', 'Google 翻译结果无法解析。')
            return align(text, [x['id'] for x in batch])
        return self._record('google', key, len(query), config, operation)

    def _baidu(self, batch, key, config, deadline):
        query = '\n'.join('【%s】%s' % (x['id'], x['text']) for x in batch)
        with self.baidu_lock:
            wait = max(0, self.baidu_start + 0.15 - time.monotonic())
            if time.monotonic() + wait >= deadline:
                raise TranslationFailure('timeout', '百度排队超时。')
            if wait:
                time.sleep(wait)
            def operation():
                self.baidu_start = time.monotonic()
                salt = uuid.uuid4().hex
                sign = hashlib.md5((config['baidu_appid'] + query + salt + config['baidu_key']).encode()).hexdigest()
                raw = self._http('fanyi-api.baidu.com', '/api/trans/vip/translate', deadline,
                                 urlencode({'q': query, 'from': 'en', 'to': 'zh', 'appid': config['baidu_appid'], 'salt': salt, 'sign': sign}).encode())
                if raw.get('error_code') and str(raw['error_code']) != '52000':
                    code = str(raw['error_code'])
                    if not re.fullmatch(r'\d{1,8}', code):
                        code = 'unknown'
                    message = str(raw.get('error_msg', ''))
                    for secret in (config['baidu_key'], config['baidu_appid']):
                        if secret:
                            message = message.replace(secret, '[已隐藏]')
                    message = re.sub(r'[\x00-\x1f\x7f]', ' ', message)[:160]
                    raise TranslationFailure('baidu_' + code, '百度翻译错误 [error_code=%s; error_msg=%s]。' % (code, message))
                rows = raw.get('trans_result')
                if not isinstance(rows, list) or not rows or not all(isinstance(x.get('dst'), str) and x['dst'].strip() for x in rows):
                    raise TranslationFailure('response', '百度翻译结果无法解析。')
                expected = [x['id'] for x in batch]
                groups, current = {}, None
                for row in rows:
                    source_marker = MARKER.match(row.get('src', ''))
                    if source_marker:
                        current = marker_id(source_marker)
                    if current not in expected:
                        groups = {}; break
                    groups.setdefault(current, []).append(without_prefix(row['dst']))
                if set(groups) == set(expected) and all(''.join(x).strip() for x in groups.values()):
                    return [{'ids': [number], 'text': ''.join(groups[number])} for number in expected]
                return align('\n'.join(x['dst'] for x in rows), expected)
            return self._record('baidu', key, len(query), config, operation)

    def _translate(self, key, source, config, deadline):
        all_segments = [{'id': 0, 'text': source['article']['title']}] + source['paragraphs']
        remaining = list(all_segments)
        pieces, warnings = [], []
        provider = config['provider']
        chain = {'apple': ['apple', 'baidu', 'google'], 'baidu': ['baidu', 'google'], 'google': ['google']}[provider]
        for name in chain:
            if not remaining or time.monotonic() >= deadline:
                break
            if name == 'baidu' and not (config['baidu_appid'] and config['baidu_key']):
                if provider == 'baidu':
                    warnings.append('未配置百度 APP ID 或密钥。')
                continue
            stage_start = len(pieces)
            stage_expected, stage_done = Counter(), Counter()
            def accepted(batch, result):
                translated_ids = {number for piece in result if piece['text'].strip() for number in piece['ids']}
                stage_done.update(x['id'] for x in batch if x['id'] in translated_ids)
                pieces.extend(dict(x, provider=name) for x in result)
            try:
                if name == 'apple':
                    # A status probe doesn't translate or occupy character budgets.
                    if not self.apple.status().get('ok'):
                        raise TranslationFailure('apple_unavailable', 'Apple 英中语言包或翻译程序尚未就绪。')
                    batches = make_batches(remaining, 5800, 20_000)
                    stage_expected.update(x['id'] for batch in batches for x in batch)
                    for batch in batches:
                        def operation(batch=batch):
                            data = {'op': 'translate', 'segments': [{'id': str(i), 'text': x['text']} for i, x in enumerate(batch)]}
                            output = self.apple.request(data, min(15, max(0.01, deadline - time.monotonic())))
                            translated = {x['id']: x['text'] for x in output['translations']}
                            if set(translated) != {str(i) for i in range(len(batch))} or not all(isinstance(x, str) and x.strip() for x in translated.values()):
                                raise TranslationFailure('response', 'Apple 翻译段落无法匹配。')
                            return [{'ids': [x['id']], 'text': translated[str(i)]} for i, x in enumerate(batch)]
                        result = self._record('apple', key, sum(len(x['text']) for x in batch), config, operation)
                        accepted(batch, result)
                elif name == 'baidu':
                    batches = make_batches(remaining, 2000, 5800)
                    stage_expected.update(x['id'] for batch in batches for x in batch)
                    for batch in batches:
                        result = self._baidu(batch, key, config, deadline)
                        accepted(batch, result)
                else:
                    batches = make_batches(remaining, 1200)
                    stage_expected.update(x['id'] for batch in batches for x in batch)
                    futures = [self.google_pool.submit(self._google, batch, key, config, deadline) for batch in batches[:48]]
                    if len(batches) > 48:
                        warnings.append('文章过长，部分内容超过本次翻译批次数量限制。')
                    for batch, future in zip(batches, futures):
                        try:
                            result = future.result()
                            accepted(batch, result)
                        except TranslationFailure as error:
                            warnings.append(error.message)
            except TranslationFailure as error:
                warnings.append(error.message)
            # A split paragraph is usable only after all its fragments succeed.
            # Otherwise retry its complete source via the next provider.
            pieces[stage_start:] = [piece for piece in pieces[stage_start:]
                                    if all(stage_done[i] == stage_expected[i] for i in piece['ids'])]
            covered = {i for piece in pieces for i in piece['ids']}
            remaining = [x for x in remaining if x['id'] not in covered]
        # Rejoin fragments of a long paragraph without duplicating it in the App.
        merged = {}
        for piece in pieces:
            group = tuple(piece['ids'])
            if group not in merged:
                merged[group] = dict(piece)
            else:
                merged[group]['text'] += piece['text']
                if merged[group]['provider'] != piece['provider']:
                    merged[group]['provider'] = 'mixed'
        pieces = list(merged.values())
        title = next((x['text'] for x in pieces if x['ids'] == [0]), '')
        return {'key': key, 'cacheHit': False, 'complete': not remaining,
                'titleTranslation': title, 'translations': pieces,
                'providers': sorted({x['provider'] for x in pieces}),
                'warnings': list(dict.fromkeys(warnings)), 'missingIds': [x['id'] for x in remaining]}
