"""Run with python -m intake_app.server. Local single-user prototype, not public hosting."""
import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import secrets
import sqlite3
from urllib.parse import urlsplit

from .domain import ValidationError, ensure, validate_document, document_warnings
from .store import Store, ConflictError

BASE = Path(__file__).resolve().parent
MAX_BODY = 12 * 1024 * 1024

class Application(ThreadingHTTPServer):
    daemon_threads = True
    def __init__(self, address, database):
        self.store = Store(database)
        self.token = secrets.token_urlsafe(32)
        super().__init__(address, Handler)

class Handler(BaseHTTPRequestHandler):
    server_version = 'CourseIntake/1.0'

    def log_message(self, message, *args):
        # Do not log student records or request headers.
        pass

    def send_bytes(self, status, body, content_type):
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
        self.end_headers()
        self.wfile.write(body)

    def respond(self, status, value):
        self.send_bytes(status, json.dumps(value, ensure_ascii=False, allow_nan=False).encode('utf-8'), 'application/json; charset=utf-8')

    def allowed(self):
        port = self.server.server_port
        hosts = {f'127.0.0.1:{port}', f'localhost:{port}'}
        if self.headers.get('Host') not in hosts:
            return False
        origin = self.headers.get('Origin')
        return (not origin or origin in {f'http://{host}' for host in hosts}) and self.headers.get('Sec-Fetch-Site') != 'cross-site'

    def do_GET(self):
        if not self.allowed():
            return self.respond(403, {'error': '로컬 앱에서 접근해주세요.'})
        path = urlsplit(self.path).path
        static = {'/': ('index.html', 'text/html'), '/app.js': ('app.js', 'text/javascript'), '/style.css': ('style.css', 'text/css')}
        if path in static:
            filename, mime = static[path]
            return self.send_bytes(200, (BASE / 'static' / filename).read_bytes(), mime + '; charset=utf-8')
        if path == '/api/config':
            return self.respond(200, {'csrf_token': self.server.token})
        if path == '/api/input':
            return self.respond(200, self.server.store.load())
        return self.respond(404, {'error': '경로를 찾을 수 없습니다.'})

    def do_POST(self):
        if not self.allowed() or not secrets.compare_digest(self.headers.get('X-App-Token', ''), self.server.token):
            return self.respond(403, {'error': '앱을 새로고침한 뒤 다시 시도해주세요.'})
        if urlsplit(self.path).path != '/api/input':
            return self.respond(404, {'error': '경로를 찾을 수 없습니다.'})
        try:
            self.connection.settimeout(110)
            ensure(self.headers.get('Content-Type', '').split(';')[0] == 'application/json', 'JSON 요청만 지원합니다.')
            length = int(self.headers.get('Content-Length', '0'))
            ensure(0 < length <= MAX_BODY, '요청이 비어 있거나 너무 큽니다.')
            value = json.loads(self.rfile.read(length))
            ensure(isinstance(value, dict), '요청 형식 오류')
            final = value.get('reviewed', False)
            ensure(type(final) is bool, '입력 확인 상태 오류')
            version = value.get('version')
            ensure(type(version) is int and version >= 0, '저장 버전 오류')
            document = validate_document(value.get('document'), final=final)
            result = self.server.store.save(document, version, reviewed=final)
            return self.respond(200, dict(**result, document=document, warnings=document_warnings(document)))
        except ConflictError as exc:
            return self.respond(409, {'error': str(exc)})
        except (ValidationError, ValueError, TypeError) as exc:
            return self.respond(400, {'error': str(exc) if isinstance(exc, ValidationError) else '입력 형식을 확인해주세요.'})
        except (sqlite3.Error, OSError):
            return self.respond(500, {'error': '로컬 저장 또는 처리에 실패했습니다. 폴더 권한과 디스크 공간을 확인해주세요.'})

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--db', type=Path, default=BASE / 'runtime' / 'student_inputs.sqlite')
    args = parser.parse_args()
    server = Application(('127.0.0.1', args.port), args.db)
    print(f'Local: http://127.0.0.1:{server.server_port}', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()

if __name__ == '__main__':
    main()
