import concurrent.futures
import copy
import json
from pathlib import Path
import re
import sys
import tempfile
import threading
import time
import unittest
from urllib.parse import parse_qs, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server import Ledger, month_now
from translation import Config, Translator, TranslationFailure, align, make_batches, validate_article


def article(identity='TESTSTORY12345', text='The market rose today.'):
    return {'article': {'id': identity, 'title': 'Markets rally',
                        'url': 'https://www.bloomberg.com/news/articles/2026-10-25/test', 'updatedAt': '1'},
            'paragraphs': [{'id': 1, 'text': text}, {'id': 2, 'text': 'Investors remain cautious.'}]}


class FakeApple:
    def __init__(self, available=True, fail_at=None, delay=0):
        self.available, self.fail_at, self.delay = available, fail_at, delay
        self.calls = 0

    def status(self):
        return {'ok': self.available}

    def request(self, data, timeout=12):
        self.calls += 1
        if self.delay:
            time.sleep(self.delay)
        if self.calls == self.fail_at:
            raise TranslationFailure('apple_timeout', 'Apple 翻译超时。')
        return {'translations': [{'id': x['id'], 'text': '苹果译文' + x['id']} for x in reversed(data['segments'])]}


class TranslationTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.ledger = Ledger(Path(self.tmp.name) / 'usage.sqlite3')
        self.config = Config(Path(self.tmp.name) / 'config.json')
        self.apple = FakeApple()
        self.engine = Translator(self.ledger, self.config, self.apple)
        self.http_calls = []
        self.engine._http = self.fake_http

    def tearDown(self):
        self.engine.google_pool.shutdown(wait=True)
        self.tmp.cleanup()

    def fake_http(self, host, path, deadline, body=None):
        self.http_calls.append(host)
        if host == 'translate.googleapis.com':
            query = parse_qs(urlsplit(path).query)['q'][0]
            return [[[f'【{number}】谷歌译文{number}。', 'original'] for number in re.findall('【(\\d+)】', query)]]
        raise AssertionError('Baidu must not be called with exhausted quota')

    def test_apple_batch_mapping_archive_and_cache(self):
        payload = article()
        result = self.engine.translate(payload)
        self.assertTrue(result['complete'])
        self.assertEqual(result['providers'], ['apple'])
        self.assertEqual(result['titleTranslation'], '苹果译文0')
        self.assertEqual([x['ids'] for x in result['translations']], [[0], [1], [2]])
        archived = self.engine.archive.get(result['key'])
        self.assertEqual(archived['source']['paragraphs'], payload['paragraphs'])
        self.assertEqual(archived['title'], payload['article']['title'])
        self.assertEqual(archived['title_translation'], '苹果译文0')
        again = self.engine.translate(payload)
        self.assertTrue(again['cacheHit'])
        self.assertEqual(self.apple.calls, 1)
        stats = self.ledger.stats(month_now())
        self.assertEqual(stats['totals'][0]['calls'], 1)
        self.assertEqual(stats['totals'][0]['characters'], len('Markets rallyThe market rose today.Investors remain cautious.'))
        self.assertEqual(self.engine.archive.listing()['cache_hits'], 1)

    def test_identical_concurrent_articles_only_translate_once(self):
        self.apple.delay = .1
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda _: self.engine.translate(article()), range(8)))
        self.assertEqual(self.apple.calls, 1)
        self.assertEqual(sum(not r['cacheHit'] for r in results), 1)
        self.assertEqual(self.engine.archive.listing()['cache_hits'], 7)

    def test_updated_article_has_separate_version(self):
        first = self.engine.translate(article())
        updated = article(text='The market declined today.')
        updated['article']['updatedAt'] = '2'
        second = self.engine.translate(updated)
        self.assertNotEqual(first['key'], second['key'])
        self.assertEqual(self.engine.archive.listing()['total'], 2)

    def test_missing_apple_falls_back_without_fake_apple_characters(self):
        self.apple.available = False
        result = self.engine.translate(article())
        self.assertEqual(result['providers'], ['google'])
        self.assertTrue(result['complete'])
        self.assertTrue(result['warnings'])
        self.assertEqual(self.ledger.stats(month_now())['totals'][0]['provider'], 'google')

    def test_exhausted_baidu_is_blocked_and_google_fallback_recorded(self):
        self.config.update({'provider': 'baidu', 'baidu_appid': '12345678', 'baidu_key': 'PRIVATE_TEST_KEY'})
        result = self.engine.translate(article())
        self.assertEqual(result['providers'], ['google'])
        self.assertIn('100 万', ' '.join(result['warnings']))
        self.assertNotIn('fanyi-api.baidu.com', self.http_calls)
        stats = self.ledger.stats(month_now())
        self.assertEqual(stats['quotas'][0]['remaining'], 0)
        blocked = next(x for x in stats['records'] if x['state'] == 'blocked')
        self.assertEqual(blocked['article_key'], result['key'])
        self.assertNotIn('PRIVATE_TEST_KEY', json.dumps(self.engine.archive.get(result['key'])))

    def test_failed_long_paragraph_is_retried_in_full_not_cached_partially(self):
        self.apple.fail_at = 2
        result = self.engine.translate(article(text='A' * 6500))
        self.assertTrue(result['complete'])
        pieces = [x for x in result['translations'] if 1 in x['ids']]
        self.assertTrue(pieces)
        self.assertTrue(all(x['provider'] == 'google' for x in pieces))
        self.assertNotIn('苹果译文1', ''.join(x['text'] for x in pieces))

    def test_failed_result_is_archived_but_not_served_as_complete_cache(self):
        self.apple.available = False
        def fail(*args, **kwargs):
            raise TranslationFailure('network', '网络失败。')
        self.engine._http = fail
        first = self.engine.translate(article())
        self.assertFalse(first['complete'])
        self.assertEqual(self.engine.archive.get(first['key'])['status'], 'partial')
        self.engine._http = self.fake_http
        second = self.engine.translate(article())
        self.assertTrue(second['complete'])
        self.assertFalse(second['cacheHit'])

    def test_expired_google_queue_does_not_consume_characters(self):
        with self.assertRaises(TranslationFailure):
            self.engine._google([{'id': 1, 'text': 'x'}], 'test', self.config.snapshot(), time.monotonic() - 1)
        self.assertEqual(self.ledger.stats(month_now())['record_count'], 0)

    def test_provider_latency_ignores_legacy_failed_calls_and_cache(self):
        result = self.engine.translate(article())
        with self.ledger.connect() as db:
            db.execute("UPDATE calls SET elapsed_ms=2000 WHERE article_key=?", (result['key'],))
        # Cached reads must not create latency samples or provider calls.
        self.engine.translate(article())
        self.ledger.reserve({'id':'legacy_google_00000001','provider':'google','appid':'','characters':100})
        self.ledger.complete({'id':'legacy_google_00000001','state':'success','elapsed_ms':0})
        self.ledger.reserve({'id':'failed_apple_00000001','provider':'apple','appid':'','characters':100})
        self.ledger.complete({'id':'failed_apple_00000001','state':'failed','elapsed_ms':9000})
        stats = self.ledger.stats(month_now())
        apple = next(row for row in stats['totals'] if row['provider']=='apple')
        google = next(row for row in stats['totals'] if row['provider']=='google')
        self.assertEqual(apple['avg_elapsed_ms'],2000)
        self.assertEqual(apple['timed_calls'],1)
        self.assertEqual(google['timed_calls'],0)
        self.assertIsNone(google['avg_elapsed_ms'])
        self.assertEqual(stats['monthly'][0]['avg_elapsed_ms'],2000)
        self.assertGreater(apple['ms_per_1000_characters'],0)

    def test_configuration_hides_secret_persists_privately_and_keeps_blank(self):
        output = self.config.update({'baidu_appid': '12345678', 'baidu_key': 'PRIVATE_TEST_KEY'})
        self.assertTrue(output['baidu_key_configured'])
        self.assertNotIn('PRIVATE_TEST_KEY', json.dumps(output))
        self.assertEqual(self.config.path.stat().st_mode & 0o777, 0o600)
        self.config.update({'baidu_key': ''})
        self.assertEqual(Config(self.config.path).snapshot()['baidu_key'], 'PRIVATE_TEST_KEY')
        self.config.update({'clear_baidu_key': True})
        self.assertFalse(self.config.public()['baidu_key_configured'])

    def test_baidu_src_mapping_survives_translated_marker_changes(self):
        self.config.update({'provider': 'baidu', 'baidu_appid': '12345678', 'baidu_key': 'PRIVATE_TEST_KEY'})
        with self.ledger.connect() as db:
            db.execute('INSERT INTO quotas VALUES (?,?,0,0)', (month_now(), '12345678'))
        self.engine._http = lambda *args: {'trans_result': [{'src': '【0】Markets rally', 'dst': '市场上涨'}, {'src': '【1】The market rose today.', 'dst': '【 １ ]今天市场上涨。'}, {'src': '【2】Investors remain cautious.', 'dst': '投资者仍然谨慎。'}]}
        result = self.engine.translate(article())
        self.assertEqual(result['providers'], ['baidu'])
        self.assertEqual(result['titleTranslation'], '市场上涨')
        self.assertEqual(result['translations'][1]['text'], '今天市场上涨。')

    def test_batches_preserve_all_text_and_bounds(self):
        text = 'A😀' * 2100
        batches = make_batches([{'id': 1, 'text': text}], 2000, 5800)
        self.assertEqual(''.join(x['text'] for batch in batches for x in batch), text)
        for batch in batches:
            q = '\n'.join('【%s】%s' % (x['id'], x['text']) for x in batch)
            self.assertLessEqual(len(q), 2000)
            self.assertLessEqual(len(q.encode()), 5800)

    def test_number_changes_and_unmatched_groups_do_not_guess_alignment(self):
        self.assertEqual([x['ids'] for x in align('[ ２ ]第二段【1】第一段', [1, 2])], [[2], [1]])
        self.assertEqual(align('合并译文', [1, 2])[0]['ids'], [1, 2])

    def test_empty_numbered_translations_never_claim_completion(self):
        with self.assertRaises(TranslationFailure):
            align('【1】', [1])
        pieces = align('【1】【2】第二段译文', [1,2])
        self.assertEqual([x['ids'] for x in pieces], [[2]])

    def test_reject_cookies_credentials_duplicate_ids_and_arbitrary_urls(self):
        for extra in ('Cookie', 'Authorization', 'baidu_key'):
            payload = dict(article(), **{extra: 'private'})
            with self.assertRaises(ValueError): validate_article(payload)
        payload = article(); payload['paragraphs'][1]['id'] = 1
        with self.assertRaises(ValueError): validate_article(payload)
        payload = article(); payload['article']['url'] = 'http://localhost/admin'
        with self.assertRaises(ValueError): validate_article(payload)


if __name__ == '__main__': unittest.main()
