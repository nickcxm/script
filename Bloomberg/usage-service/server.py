#!/usr/bin/env python3
"""LAN translation service, article archive and conservative usage ledger."""
import datetime as dt
import json
import os
from pathlib import Path
import re
import sqlite3
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

from translation import Config, Translator, TranslationFailure

ROOT = Path(__file__).resolve().parent
LIMIT = 1_000_000
TZ = dt.timezone(dt.timedelta(hours=8))


def month_now():
    return dt.datetime.now(TZ).strftime('%Y-%m')


class Ledger:
    def __init__(self, path):
        self.path = str(path)
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as db:
            db.executescript('''
            PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS quotas (
                month TEXT NOT NULL, appid TEXT NOT NULL, opening INTEGER NOT NULL,
                used INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(month, appid));
            CREATE TABLE IF NOT EXISTS calls (
                id TEXT PRIMARY KEY, created_at TEXT NOT NULL, month TEXT NOT NULL,
                provider TEXT NOT NULL, appid TEXT NOT NULL, characters INTEGER NOT NULL,
                state TEXT NOT NULL, error TEXT NOT NULL DEFAULT '');
            CREATE INDEX IF NOT EXISTS calls_month ON calls(month, created_at);
            ''')
            columns = {row[1] for row in db.execute('PRAGMA table_info(calls)')}
            if 'article_key' not in columns:
                db.execute("ALTER TABLE calls ADD COLUMN article_key TEXT NOT NULL DEFAULT ''")
            if 'elapsed_ms' not in columns:
                db.execute('ALTER TABLE calls ADD COLUMN elapsed_ms INTEGER NOT NULL DEFAULT 0')
            db.execute('INSERT OR IGNORE INTO settings VALUES (?,?)',
                       ('exhausted_month', month_now()))

    def connect(self):
        db = sqlite3.connect(self.path, timeout=15)
        db.row_factory = sqlite3.Row
        return db

    def reserve(self, data):
        if set(data) - {'id', 'provider', 'appid', 'characters'}:
            raise ValueError('Unexpected fields; send metadata only')
        call_id = data.get('id', '')
        if not isinstance(call_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{16,100}', call_id):
            raise ValueError('Invalid request id')
        provider, appid, count = data.get('provider'), data.get('appid', ''), data.get('characters')
        if provider not in ('apple', 'baidu', 'google') or not isinstance(appid, str):
            raise ValueError('Invalid provider or appid')
        if (provider == 'baidu' and not re.fullmatch(r'\d{1,40}', appid)) or (provider != 'baidu' and appid):
            raise ValueError('Invalid appid')
        if type(count) is not int or not 0 < count <= 6000:
            raise ValueError('characters must be 1..6000 Unicode characters')
        month = month_now()
        now = dt.datetime.now(TZ).isoformat(timespec='milliseconds')
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            existing = db.execute('SELECT * FROM calls WHERE id=?', (call_id,)).fetchone()
            if existing:
                if (existing['provider'], existing['appid'], existing['characters']) != (provider, appid, count):
                    raise ValueError('Request id conflict')
                return {'id': call_id, 'allowed': existing['state'] != 'blocked', 'replayed': True}
            allowed, remaining = True, None
            if provider == 'baidu':
                exhausted = db.execute("SELECT value FROM settings WHERE key='exhausted_month'").fetchone()[0]
                db.execute('INSERT OR IGNORE INTO quotas(month,appid,opening) VALUES (?,?,?)',
                           (month, appid, LIMIT if month == exhausted else 0))
                quota = db.execute('SELECT opening,used FROM quotas WHERE month=? AND appid=?', (month, appid)).fetchone()
                allowed = quota['opening'] + quota['used'] + count <= LIMIT
                if allowed:
                    db.execute('UPDATE quotas SET used=used+? WHERE month=? AND appid=?', (count, month, appid))
                remaining = max(0, LIMIT - quota['opening'] - quota['used'] - (count if allowed else 0))
            db.execute('INSERT INTO calls(id,created_at,month,provider,appid,characters,state) VALUES(?,?,?,?,?,?,?)',
                       (call_id, now, month, provider, appid, count, 'reserved' if allowed else 'blocked'))
        return {'id': call_id, 'allowed': allowed, 'remaining': remaining,
                'code': '' if allowed else 'monthly_quota'}

    def complete(self, data):
        if set(data) - {'id', 'state', 'error', 'elapsed_ms'}:
            raise ValueError('Unexpected fields')
        if data.get('state') not in ('success', 'failed'):
            raise ValueError('Invalid state')
        error = data.get('error', '')
        if not isinstance(error, str) or not re.fullmatch(r'[a-zA-Z0-9_:.-]{0,100}', error):
            raise ValueError('Invalid error code')
        elapsed = data.get('elapsed_ms')
        if elapsed is not None and (type(elapsed) is not int or not 0 <= elapsed <= 120_000):
            raise ValueError('Invalid elapsed time')
        with self.connect() as db:
            row = db.execute("SELECT created_at FROM calls WHERE id=? AND state='reserved'", (data.get('id', ''),)).fetchone()
            if not row:
                return {'updated': False}
            if elapsed is None:
                # Legacy clients don't report timing; reservation-to-completion
                # includes their provider call and the small LAN round trips.
                elapsed = max(0, round((dt.datetime.now(TZ)-dt.datetime.fromisoformat(row['created_at'])).total_seconds()*1000))
            changed = db.execute("UPDATE calls SET state=?,error=?,elapsed_ms=? WHERE id=? AND state='reserved'",
                                 (data['state'], error, elapsed, data.get('id', ''))).rowcount
        return {'updated': bool(changed)}

    def stats(self, month, offset=0):
        if not re.fullmatch(r'\d{4}-(0[1-9]|1[0-2])', month):
            raise ValueError('Invalid month')
        with self.connect() as db:
            db.execute('BEGIN')  # One consistent snapshot for all dashboard totals.
            def rows(sql, args=()):
                return [dict(row) for row in db.execute(sql, args)]
            summary = '''SELECT provider, COUNT(*) attempts,
                SUM(CASE WHEN state!='blocked' THEN 1 ELSE 0 END) calls,
                SUM(CASE WHEN state!='blocked' THEN characters ELSE 0 END) characters,
                SUM(CASE WHEN state='success' THEN characters ELSE 0 END) success_characters,
                SUM(CASE WHEN state='blocked' THEN 1 ELSE 0 END) blocked,
                SUM(CASE WHEN state='failed' THEN 1 ELSE 0 END) failed,
                ROUND(AVG(CASE WHEN state='success' AND elapsed_ms>0 THEN elapsed_ms END),1) avg_elapsed_ms,
                SUM(CASE WHEN state='success' AND elapsed_ms>0 THEN 1 ELSE 0 END) timed_calls,
                ROUND(1000.0*SUM(CASE WHEN state='success' AND elapsed_ms>0 THEN elapsed_ms ELSE 0 END)
                  /NULLIF(SUM(CASE WHEN state='success' AND elapsed_ms>0 THEN characters ELSE 0 END),0),1) ms_per_1000_characters
                FROM calls {} GROUP BY provider'''
            return {'month': month, 'current_month': month_now(), 'limit': LIMIT,
                    'initial_exhausted_month': db.execute("SELECT value FROM settings WHERE key='exhausted_month'").fetchone()[0],
                    'totals': rows(summary.format('')), 'monthly': rows(summary.format('WHERE month=?'), (month,)),
                    'quotas': rows('SELECT *, MAX(0,?-opening-used) remaining FROM quotas WHERE month=? ORDER BY appid', (LIMIT, month)),
                    'daily': rows("SELECT substr(created_at,1,10) day,provider,COUNT(*) calls,SUM(characters) characters FROM calls WHERE month=? AND state!='blocked' GROUP BY day,provider ORDER BY day DESC", (month,)),
                    'records': rows('SELECT * FROM calls WHERE month=? ORDER BY created_at DESC,rowid DESC LIMIT 100 OFFSET ?', (month, offset)),
                    'record_count': db.execute('SELECT COUNT(*) FROM calls WHERE month=?', (month,)).fetchone()[0],
                    'offset': offset}


class Handler(BaseHTTPRequestHandler):
    server_version = 'TranslationUsage/1'

    def log_message(self, *_):
        pass  # No request bodies, appids, client IPs or query strings in access logs.

    def send(self, status, value, content_type='application/json; charset=utf-8'):
        raw = json.dumps(value, ensure_ascii=False).encode() if not isinstance(value, bytes) else value
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(raw)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'")
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        url = urlsplit(self.path)
        if url.path == '/health':
            self.send(200, {'ok': True, 'month': month_now(), 'version': '20261025-backend-1'})
        elif url.path == '/api/config':
            self.send(200, dict(self.server.translator.config.public(), apple=self.server.translator.apple.status()))
        elif url.path == '/api/articles':
            try:
                offset = int(parse_qs(url.query).get('offset', ['0'])[0])
                if not 0 <= offset <= 1_000_000:
                    raise ValueError()
                self.send(200, self.server.translator.archive.listing(offset))
            except ValueError:
                self.send(400, {'error': 'Invalid offset'})
        elif re.fullmatch(r'/api/articles/[a-f0-9]{64}', url.path):
            article = self.server.translator.archive.get(url.path.rsplit('/', 1)[1])
            self.send(200 if article else 404, article or {'error': 'Not found'})
        elif url.path == '/api/stats':
            try:
                query = parse_qs(url.query)
                offset = int(query.get('offset', ['0'])[0])
                if not 0 <= offset <= 1_000_000:
                    raise ValueError('Invalid offset')
                self.send(200, self.server.ledger.stats(query.get('month', [month_now()])[0], offset))
            except ValueError as error:
                self.send(400, {'error': str(error)})
        elif url.path in ('/', '/app.js', '/style.css'):
            filename, kind = {'/': ('index.html', 'text/html'), '/app.js': ('app.js', 'text/javascript'),
                              '/style.css': ('style.css', 'text/css')}[url.path]
            self.send(200, (ROOT / filename).read_bytes(), kind + '; charset=utf-8')
        else:
            self.send(404, {'error': 'Not found'})

    def do_POST(self):
        # Reject cross-origin browser writes; native Surge requests have no Origin.
        origin = self.headers.get('Origin')
        if origin and origin != 'http://' + self.headers.get('Host', ''):
            return self.send(403, {'error': 'Cross-origin request denied'})
        if self.headers.get('Content-Type', '').split(';')[0] != 'application/json':
            return self.send(415, {'error': 'JSON required'})
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= (1_048_576 if self.path == '/api/translate' else 2048):
                raise ValueError('Invalid content length')
            data = json.loads(self.rfile.read(length))
            if not isinstance(data, dict):
                raise ValueError('JSON object required')
            if self.path == '/api/translate':
                result = self.server.translator.translate(data)
            elif self.path == '/api/config':
                result = self.server.translator.config.update(data)
            elif self.path == '/api/reserve':
                result = self.server.ledger.reserve(data)
            elif self.path == '/api/complete':
                result = self.server.ledger.complete(data)
            else:
                return self.send(404, {'error': 'Not found'})
            self.send(200, result)
        except TranslationFailure as error:
            self.send(503, {'error': error.code, 'message': error.message})
        except (ValueError, TypeError):
            self.send(400, {'error': 'Invalid request data'})
        except sqlite3.Error:
            self.send(503, {'error': 'Ledger unavailable'})


def main():
    os.umask(0o077)
    ledger = Ledger(os.environ.get('USAGE_DB', str(ROOT / 'data' / 'usage.sqlite3')))
    server = ThreadingHTTPServer(('0.0.0.0', int(os.environ.get('PORT', '18746'))), Handler)
    server.ledger = ledger
    server.translator = Translator(ledger, Config(Path(ledger.path).parent / 'config.json'))
    print('Translation usage listening on port %s' % server.server_port, flush=True)
    server.serve_forever()


if __name__ == '__main__':
    main()
