import concurrent.futures
import importlib.util
from pathlib import Path
import tempfile
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('usage_server', Path(__file__).resolve().parents[1] / 'server.py')
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)


class LedgerTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.ledger = server.Ledger(Path(self.temp.name) / 'usage.sqlite3')

    def tearDown(self):
        self.temp.cleanup()

    def request(self, number, provider='baidu', characters=1000, appid='12345678'):
        return {'id': 'request_test_%08d' % number, 'provider': provider,
                'appid': appid if provider == 'baidu' else '', 'characters': characters}

    def open_quota(self, used=0):
        with self.ledger.connect() as db:
            db.execute('INSERT INTO quotas VALUES (?,?,0,?)', (server.month_now(), '12345678', used))

    def test_current_month_starts_exhausted(self):
        self.assertFalse(self.ledger.reserve(self.request(1))['allowed'])
        stats = self.ledger.stats(server.month_now())
        self.assertEqual(stats['quotas'][0]['opening'], 1000000)
        self.assertEqual(stats['quotas'][0]['remaining'], 0)
        self.assertEqual(stats['monthly'][0]['characters'], 0)
        self.assertEqual(stats['monthly'][0]['blocked'], 1)

    def test_concurrent_requests_cannot_exceed_limit(self):
        self.open_quota(999000)
        with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
            results = list(pool.map(lambda i: self.ledger.reserve(self.request(i)), range(24)))
        self.assertEqual(sum(r['allowed'] for r in results), 1)
        quota = self.ledger.stats(server.month_now())['quotas'][0]
        self.assertEqual(quota['used'], 1000000)

    def test_idempotency_persistence_and_completion_does_not_release(self):
        self.open_quota()
        first = self.ledger.reserve(self.request(1))
        self.assertTrue(first['allowed'])
        self.ledger = server.Ledger(self.ledger.path)
        self.assertTrue(self.ledger.reserve(self.request(1))['replayed'])
        self.ledger.complete({'id': first['id'], 'state': 'failed', 'error': 'timeout'})
        stats = self.ledger.stats(server.month_now())
        self.assertEqual(stats['quotas'][0]['used'], 1000)
        self.assertEqual(stats['monthly'][0]['calls'], 1)
        self.assertEqual(stats['records'][0]['state'], 'failed')
        with self.assertRaises(ValueError):
            self.ledger.reserve(self.request(1, characters=20))

    def test_month_rollover_and_appid_isolation(self):
        self.ledger.reserve(self.request(1))
        with patch.object(server, 'month_now', return_value='2099-01'):
            self.assertTrue(self.ledger.reserve(self.request(2))['allowed'])
            self.assertTrue(self.ledger.reserve(self.request(3, appid='98765432'))['allowed'])
            stats = self.ledger.stats('2099-01')
            self.assertEqual(len(stats['quotas']), 2)
            self.assertTrue(all(q['remaining'] == 999000 for q in stats['quotas']))
        self.assertEqual(self.ledger.stats(server.month_now())['quotas'][0]['remaining'], 0)

    def test_google_no_quota_and_provider_totals(self):
        for i in range(3):
            req = self.request(i, provider='google', characters=25)
            self.assertTrue(self.ledger.reserve(req)['allowed'])
            self.ledger.complete({'id': req['id'], 'state': 'success'})
        stats = self.ledger.stats(server.month_now())
        self.assertEqual(stats['quotas'], [])
        self.assertEqual(stats['totals'][0]['characters'], 75)
        self.assertEqual(stats['totals'][0]['success_characters'], 75)
        self.assertEqual(stats['daily'][0]['calls'], 3)

    def test_never_accept_text_or_credentials(self):
        for extra in ('text', 'key', 'url', 'body', 'token'):
            with self.assertRaises(ValueError):
                self.ledger.reserve(dict(self.request(1), **{extra: 'private'}))
        for chars in (0, -1, 6001, 1.5, True, '10'):
            with self.assertRaises(ValueError):
                self.ledger.reserve(self.request(1, characters=chars))


if __name__ == '__main__':
    unittest.main()
