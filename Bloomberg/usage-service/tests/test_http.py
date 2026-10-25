import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from http.server import ThreadingHTTPServer

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from server import Handler, Ledger
from translation import Config, Translator
from test_translation import FakeApple, article


class HTTPTest(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.ledger=Ledger(Path(self.tmp.name)/'usage.sqlite3')
        self.translator=Translator(self.ledger,Config(Path(self.tmp.name)/'config.json'),FakeApple())
        self.server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
        self.server.ledger=self.ledger;self.server.translator=self.translator
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
        self.base='http://127.0.0.1:'+str(self.server.server_port)

    def tearDown(self):
        self.server.shutdown();self.server.server_close();self.thread.join()
        self.translator.google_pool.shutdown(wait=True)
        self.tmp.cleanup()

    def request(self,path,data=None,headers=None):
        request=Request(self.base+path,data=json.dumps(data).encode() if data is not None else None,
                        headers=dict({'Content-Type':'application/json'} if data is not None else {},**(headers or {})))
        with urlopen(request,timeout=5) as response:
            return json.load(response)

    def test_translation_archive_stats_and_cached_response_over_http(self):
        first=self.request('/api/translate',article())
        self.assertTrue(first['complete']);self.assertFalse(first['cacheHit'])
        second=self.request('/api/translate',article())
        self.assertTrue(second['cacheHit'])
        saved=self.request('/api/articles/'+first['key'])
        self.assertEqual(saved['source']['paragraphs'],article()['paragraphs'])
        self.assertEqual(saved['title_translation'],'苹果译文0')
        self.assertEqual(self.request('/api/articles')['cache_hits'],1)
        self.assertEqual(self.request('/api/stats')['record_count'],1)

    def test_secret_is_not_returned_by_configuration_or_bad_request(self):
        self.request('/api/config',{'baidu_appid':'12345678','baidu_key':'DO_NOT_DISCLOSE'})
        public=self.request('/api/config')
        self.assertTrue(public['baidu_key_configured'])
        self.assertNotIn('DO_NOT_DISCLOSE',json.dumps(public))
        with self.assertRaises(HTTPError) as caught:
            self.request('/api/translate',dict(article(),Cookie='DO_NOT_DISCLOSE'))
        self.assertEqual(caught.exception.code,400)
        self.assertNotIn('DO_NOT_DISCLOSE',caught.exception.read().decode())

    def test_browser_cross_origin_writes_denied_and_legacy_clients_supported(self):
        with self.assertRaises(HTTPError) as caught:
            self.request('/api/config',{'provider':'google'},{'Origin':'https://untrusted.example'})
        self.assertEqual(caught.exception.code,403)
        ticket=self.request('/api/reserve',{'id':'legacy_request_00000001','provider':'google','appid':'','characters':10})
        self.assertTrue(ticket['allowed'])
        self.assertTrue(self.request('/api/complete',{'id':ticket['id'],'state':'success'})['updated'])
        self.assertEqual(self.request('/api/stats')['record_count'],1)


if __name__=='__main__':unittest.main()
