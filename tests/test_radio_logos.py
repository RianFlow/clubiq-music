import asyncio
import base64
import socket
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from fastapi import HTTPException, Request
from starlette.responses import Response

import main
import radio_logos as logos


PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=')


def address(ip):
    return (socket.AF_INET, socket.SOCK_STREAM, 6, '', (ip, 80))


def response(status=200, content=PNG, media_type='image/png', location=None):
    result = MagicMock()
    result.status = status
    result.isclosed.return_value = False
    result.read1.side_effect = [content, b'']
    headers = {'Content-Type':media_type, 'Content-Length':str(len(content)), 'Location':location}
    result.getheader.side_effect = headers.get
    return result


class RadioLogoTests(unittest.TestCase):
    def setUp(self):
        logos._cache.clear()

    def test_private_and_mixed_dns_answers_are_rejected(self):
        for addresses in ([address('127.0.0.1')], [address('10.42.0.1')],
                          [address('169.254.169.254')], [address('100.109.107.13')],
                          [address('93.184.216.34'), address('192.168.1.1')]):
            with self.subTest(addresses=addresses), patch.object(logos.socket, 'getaddrinfo', return_value=addresses):
                with self.assertRaises(ValueError):
                    logos.public_target('https://radio.example/logo.png')

    def test_invalid_scheme_credentials_ports_and_headers_are_rejected_before_dns(self):
        for url in ('file:///etc/passwd', 'ftp://radio.example/logo', 'http://user:secret@radio.example/logo',
                    'https://radio.example:8091/logo', 'http://radio.example/\r\nHeader: value'):
            with self.subTest(url=url), patch.object(logos.socket, 'getaddrinfo') as dns:
                with self.assertRaises(ValueError):
                    logos.public_target(url)
                dns.assert_not_called()

    @patch.object(logos.ssl, 'create_default_context')
    @patch.object(logos.socket, 'create_connection')
    @patch.object(logos.socket, 'getaddrinfo', return_value=[address('93.184.216.34')])
    @patch.object(logos.http.client, 'HTTPConnection')
    def test_https_pins_validated_ip_and_keeps_tls_hostname(self, connection, dns, connect, tls):
        connection.return_value.getresponse.return_value = response()
        self.assertEqual(logos.download_logo('https://radio.example/logo.png'), (PNG, 'image/png'))
        self.assertEqual(connect.call_args.args[0], ('93.184.216.34', 443))
        tls.return_value.wrap_socket.assert_called_once_with(connect.return_value, server_hostname='radio.example')
        self.assertEqual(connection.call_args.args, ('radio.example', 443))
        headers = connection.return_value.request.call_args.kwargs['headers']
        self.assertNotIn('Cookie', headers)
        self.assertNotIn('Authorization', headers)

    @patch.object(logos.socket, 'create_connection')
    @patch.object(logos.socket, 'getaddrinfo')
    @patch.object(logos.http.client, 'HTTPConnection')
    def test_redirect_cannot_reach_a_private_address(self, connection, dns, connect):
        dns.side_effect = [[address('93.184.216.34')], [address('10.42.0.1')]]
        connection.return_value.getresponse.return_value = response(302, location='http://local.example/admin')
        self.assertIsNone(logos.cached_logo('http://radio.example/logo.png'))
        connect.assert_called_once()

    @patch.object(logos.socket, 'create_connection')
    @patch.object(logos.socket, 'getaddrinfo', return_value=[address('93.184.216.34')])
    @patch.object(logos.http.client, 'HTTPConnection')
    def test_html_svg_wrong_signature_and_oversized_payloads_are_rejected(self, connection, dns, connect):
        for upstream in (response(403), response(content=b'<html>error</html>', media_type='text/html'),
                         response(content=b'<svg/>', media_type='image/svg+xml'),
                         response(content=b'not an image'), response(content=PNG, media_type='image/jpeg')):
            with self.subTest(upstream=upstream):
                connection.return_value.getresponse.return_value = upstream
                self.assertIsNone(logos.download_logo('http://radio.example/logo'))
        upstream = response(content=PNG)
        upstream.getheader.side_effect = {'Content-Type':'image/png', 'Content-Length':str(logos.MAX_BYTES + 1)}.get
        connection.return_value.getresponse.return_value = upstream
        self.assertIsNone(logos.download_logo('http://radio.example/logo'))
        upstream.read1.assert_not_called()

    @patch.object(logos.socket, 'create_connection')
    @patch.object(logos.socket, 'getaddrinfo', return_value=[address('93.184.216.34')])
    @patch.object(logos.http.client, 'HTTPConnection')
    def test_actual_size_is_bounded_without_content_length(self, connection, dns, connect):
        upstream = response()
        upstream.getheader.side_effect = {'Content-Type':'image/png'}.get
        upstream.read1.side_effect = [PNG, b'x' * logos.MAX_BYTES]
        connection.return_value.getresponse.return_value = upstream
        self.assertIsNone(logos.download_logo('http://radio.example/logo'))

    @patch.object(logos, 'download_logo', return_value=(PNG, 'image/png'))
    def test_success_is_cached_by_url_and_cache_is_bounded(self, download):
        self.assertEqual(logos.cached_logo('https://radio.example/logo'), (PNG, 'image/png'))
        self.assertEqual(logos.cached_logo('https://radio.example/logo'), (PNG, 'image/png'))
        download.assert_called_once()
        for index in range(70):
            logos.cached_logo(f'https://radio.example/{index}')
        self.assertEqual(len(logos._cache), 64)

    @patch.object(logos.time, 'monotonic', return_value=0)
    @patch.object(logos, 'download_logo', side_effect=TimeoutError('offline'))
    def test_failure_is_cached_briefly_then_retried(self, download, clock):
        for _ in range(3):
            self.assertIsNone(logos.cached_logo('https://radio.example/offline'))
        download.assert_called_once()
        clock.return_value = logos.FAILURE_SECONDS + 1
        self.assertIsNone(logos.cached_logo('https://radio.example/offline'))
        self.assertEqual(download.call_count, 2)


class RadioLogoRouteTests(unittest.TestCase):
    @patch.object(main, 'db_connect')
    @patch.object(main, 'cached_logo', return_value=(PNG, 'image/png'))
    def test_route_loads_only_saved_url_and_returns_cacheable_image(self, logo, connect):
        cursor = connect.return_value.__enter__.return_value.cursor.return_value.__enter__.return_value
        cursor.fetchone.return_value = ('http://radio.example/logo',)
        result = main.radio_station_logo(5)
        cursor.execute.assert_called_once_with('SELECT logo_url FROM music_radio_stations WHERE id = %s;', (5,))
        logo.assert_called_once_with('http://radio.example/logo')
        self.assertEqual(result.body, PNG)
        self.assertEqual(result.media_type, 'image/png')
        self.assertIn(str(logos.CACHE_SECONDS), result.headers['cache-control'])

    @patch.object(main, 'db_connect')
    @patch.object(main, 'cached_logo', return_value=None)
    def test_broken_logo_uses_local_placeholder_and_missing_station_does_not_fetch(self, logo, connect):
        cursor = connect.return_value.__enter__.return_value.cursor.return_value.__enter__.return_value
        cursor.fetchone.return_value = (None,)
        result = main.radio_station_logo(5)
        self.assertEqual(result.path, 'static/radio-placeholder.svg')
        self.assertTrue(Path(result.path).is_file())
        cursor.fetchone.return_value = None
        logo.reset_mock()
        with self.assertRaises(HTTPException) as error:
            main.radio_station_logo(999)
        self.assertEqual(error.exception.status_code, 404)
        logo.assert_not_called()

    def test_station_and_all_player_views_use_same_origin_artwork(self):
        row = (5, 'Test', 'http://radio.example/stream', None, 'http://radio.example/logo', 'pop', True, 0)
        self.assertEqual(main.radio_station_dict(row)['logo_image_url'], '/api/v1/music/radio/stations/5/logo')
        state = {'source_mode':'radio', 'radio_station':{'id':5, 'logo_url':row[4]},
                 'current':{'title':'Test', 'thumbnail':row[4]}}
        result = main.player_image_urls(state)
        self.assertEqual(result['current']['thumbnail'], '/api/v1/music/radio/stations/5/logo')
        playlist = {'source_mode':'playlist', 'current':{'thumbnail':'/api/v1/music/thumbnails/youtube/123456'}}
        self.assertEqual(main.player_image_urls(playlist), playlist)
        self.assertEqual(main.station_logo_path('../private'), '/static/radio-placeholder.svg')

    def test_csp_is_not_weakened_for_external_logos(self):
        async def next_response(_):
            return Response('ok')
        result = asyncio.run(main.security_headers(Request({'type':'http', 'method':'GET', 'path':'/', 'headers':[]}), next_response))
        self.assertIn("img-src 'self' data:;", result.headers['content-security-policy'])

    def test_all_pages_load_shared_image_helper_before_app_script(self):
        root = Path(__file__).resolve().parents[1]
        for page, script in [('index.html','app.js'), ('remote.html','remote.js'), ('party.html','party.js')]:
            source = (root / page).read_text(encoding='utf-8')
            self.assertLess(source.index('/static/images.js'), source.index('/static/' + script))
            self.assertIn('setMediaImage(', (root / 'static' / script).read_text(encoding='utf-8'))
