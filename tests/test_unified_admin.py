"""Shared-login boundaries for the existing website administration APIs."""
import asyncio
import unittest
from unittest.mock import MagicMock, patch

from fastapi import HTTPException
from starlette.requests import Request
from starlette.responses import Response

import main
from darts_cms import COOKIE, session_cookie, session_subject


def request(method='GET', path='/api/v1/darts/admin/verify', token='a' * 64, csrf=False, query=b''):
    headers = [(b'host', b'testserver')]
    if token:
        headers.append((b'cookie', f'{COOKIE}={token}'.encode()))
    if csrf:
        headers.append((b'x-cms-request', b'1'))
    return Request({'type':'http', 'method':method, 'scheme':'http', 'server':('testserver',80),
                    'path':path, 'query_string':query, 'headers':headers})


def connection(row):
    connect = MagicMock()
    connect.return_value.__enter__.return_value.cursor.return_value.__enter__.return_value.fetchone.return_value = row
    return connect


class UnifiedAdminTests(unittest.TestCase):
    def test_owner_cookie_authorizes_existing_admin_routes_without_password_headers(self):
        with patch.object(main, 'ADMIN_PASSWORD', 'test-password'), patch.object(main, 'DARTS_ADMIN_USERNAME', 'owner'):
            connect = connection((None, main.darts_owner_fingerprint(), None, None, None))
            with patch.object(main, 'db_connect', connect):
                main.require_darts_admin(None, None, request())
                main.require_darts_admin(None, None, request('POST', csrf=True))
                with self.assertRaises(HTTPException) as caught:
                    main.require_darts_admin(None, None, request('POST'))
                self.assertEqual(caught.exception.status_code, 403)

    def test_editor_even_from_barver_cannot_access_global_player_or_sponsor_administration(self):
        for row in [(8, None, 1, True, 'redaktion'), (8, None, 1, False, 'redaktion'), None,
                    (None, 'old-owner-fingerprint', None, None, None)]:
            with patch.object(main, 'ADMIN_PASSWORD', 'test-password'), patch.object(main, 'DARTS_ADMIN_USERNAME', 'owner'), patch.object(main, 'db_connect', connection(row)):
                with self.assertRaises(HTTPException) as caught:
                    main.require_darts_admin(None, None, request())
                self.assertEqual(caught.exception.status_code, 403 if row and row[0] and row[3] else 401)

    def test_explicit_invalid_credentials_never_fall_back_to_owner_cookie(self):
        with patch.object(main, 'ADMIN_PASSWORD', 'test-password'), patch.object(main, 'DARTS_ADMIN_USERNAME', 'owner'):
            connect = connection((None, main.darts_owner_fingerprint(), None, None, None))
            with patch.object(main, 'db_connect', connect), self.assertRaises(HTTPException):
                main.require_darts_admin('wrong', 'owner', request())
            connect.assert_not_called()

    def test_missing_or_malformed_cookie_is_rejected_before_database_access(self):
        for token in ['', '../token', 'b' * 63]:
            connect = connection(None)
            with self.assertRaises(HTTPException):
                session_subject(request(token=token), connect, lambda:'fingerprint')
            connect.assert_not_called()

    def test_cookie_migration_keeps_session_httponly_and_removes_old_narrow_cookie(self):
        response = Response()
        session_cookie(response, request(), 'a' * 64)
        cookies = response.headers.getlist('set-cookie')
        self.assertTrue(any('Path=/api/v1/cms' in cookie and 'Max-Age=0' in cookie for cookie in cookies))
        self.assertTrue(any('Path=/api/v1;' in cookie and 'HttpOnly' in cookie and 'SameSite=strict' in cookie for cookie in cookies))

    def test_only_embedded_editor_allows_same_origin_frames(self):
        async def response(_request):
            return Response()
        for req, expected in [(request(path='/cms'), 'DENY'),
                              (request(path='/darts-admin', query=b'embedded=1'), 'SAMEORIGIN'),
                              (request(path='/darts'), 'DENY')]:
            result = asyncio.run(main.security_headers(req, response))
            self.assertEqual(result.headers['X-Frame-Options'], expected)
            if req.url.path == '/cms':
                self.assertIn("frame-src 'self'", result.headers['Content-Security-Policy'])
        self.assertEqual(main.darts_admin_display().headers['location'], '/cms?view=players')
