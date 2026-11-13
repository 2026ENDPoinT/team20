"""Run with python -m intake_app.server. Local single-user prototype, not public hosting."""
import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import secrets
import sqlite3
from threading import Lock
from time import monotonic
from urllib.parse import urlsplit

from everytime_import.importer import ImportFailure, collect

from .domain import ValidationError, ensure, validate_document, document_warnings
from .imports import apply_import, check_import_sources, prepare_import, replace_import
from .offerings import compare_offerings
from .recommendations import recommend
from .schedules import basket_sections, generate, search_schedule_courses
from .interest_tags import load_tags
from .store import Store, ConflictError

BASE = Path(__file__).resolve().parent
MAX_BODY = 12 * 1024 * 1024
OFFICIAL_DB = BASE.parent / 'db' / 'courses.sqlite3'
RATINGS_DB = BASE.parent / 'db' / 'everytime_ratings.sqlite3'
EMPTY_DOCUMENT = {'student': {}, 'course_attempts': []}
SCHEDULE_ACTIONS = {
    '/api/schedules': generate,
    '/api/schedules/sections': basket_sections,
    '/api/schedules/search': search_schedule_courses,
}

class Application(ThreadingHTTPServer):
    daemon_threads = True
    def __init__(self, address, database, official_db=OFFICIAL_DB, *, collector=collect, ratings_db=RATINGS_DB):
        paths = [Path(path).resolve() for path in (database, official_db, ratings_db) if path is not None]
        if len(set(paths)) != len(paths):
            raise ValueError('학생 입력, 공식 강좌, 에브리타임 별점에 서로 다른 DB 파일을 지정해주세요.')
        self.store = Store(database)
        self.official_db = official_db
        self.ratings_db = ratings_db
        self.collector = collector
        self.import_lock = Lock()
        self.previews = {}
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
        static = {'/': ('index.html', 'text/html'), '/recommendations': ('index.html', 'text/html'), '/schedules': ('index.html', 'text/html'), '/app.js': ('app.js', 'text/javascript'), '/style.css': ('style.css', 'text/css')}
        if path in ('/fonts/gowun-batang-bold.woff', '/fonts/noto-sans-kr.woff'):
            return self.send_bytes(200, (BASE / 'static' / path.lstrip('/')).read_bytes(), 'font/woff')
        if path in static:
            filename, mime = static[path]
            return self.send_bytes(200, (BASE / 'static' / filename).read_bytes(), mime + '; charset=utf-8')
        if path == '/api/config':
            tags, aliases, _ = load_tags()
            return self.respond(200, {
                'csrf_token': self.server.token,
                'schedule_course_exclusions': True,
                'interest_tags': [{key: tag[key] for key in ('id', 'label', 'group')} for tag in tags],
                'interest_aliases': {label: sorted(ids) for label, ids in aliases.items()},
            })
        if path == '/api/input':
            saved = self.server.store.load()
            if saved['document'] is not None:
                saved['document'] = validate_document(saved['document'])
            return self.respond(200, saved)
        return self.respond(404, {'error': '경로를 찾을 수 없습니다.'})

    def do_POST(self):
        if not self.allowed() or not secrets.compare_digest(self.headers.get('X-App-Token', ''), self.server.token):
            return self.respond(403, {'error': '앱을 새로고침한 뒤 다시 시도해주세요.'})
        path = urlsplit(self.path).path
        if path not in ('/api/input', '/api/import/preview', '/api/import/apply', '/api/offerings/compare',
                        '/api/recommendations') and path not in SCHEDULE_ACTIONS:
            return self.respond(404, {'error': '경로를 찾을 수 없습니다.'})
        try:
            self.connection.settimeout(110)
            ensure(self.headers.get('Content-Type', '').split(';')[0] == 'application/json', 'JSON 요청만 지원합니다.')
            length = int(self.headers.get('Content-Length', '0'))
            ensure(0 < length <= MAX_BODY, '요청이 비어 있거나 너무 큽니다.')
            value = json.loads(self.rfile.read(length))
            ensure(isinstance(value, dict), '요청 형식 오류')
            version = value.get('version')
            ensure(type(version) is int and version >= 0, '저장 버전 오류')
            if path == '/api/import/preview':
                return self.preview_import(value, version)
            if path == '/api/import/apply':
                return self.commit_import(value, version)
            if path == '/api/offerings/compare':
                return self.compare_saved(version)
            if path in SCHEDULE_ACTIONS:
                saved = self.load_version(version)
                ensure(saved['document'] is not None, '내 정보에서 학생 정보를 먼저 저장해주세요.')
                action = SCHEDULE_ACTIONS[path]
                result = action(self.server.official_db, validate_document(saved['document']), value,
                                ratings_db=self.server.ratings_db)
                self.load_version(version)
                return self.respond(200, dict(result, input_revision=version))
            if path == '/api/recommendations':
                saved = self.load_version(version)
                ensure(saved['document'] is not None, '학생 정보와 이수내역을 먼저 저장해주세요.')
                document = validate_document(saved['document'])
                if value.get('automatic_term') is True:
                    document['student'].update(target_term=None, recognition_notes='')
                result = recommend(self.server.official_db, document, ratings_db=self.server.ratings_db)
                self.load_version(version)
                return self.respond(200, dict(result, input_revision=version))
            final = value.get('reviewed', False)
            ensure(type(final) is bool, '입력 확인 상태 오류')
            document = validate_document(value.get('document'), final=final)
            for key in ('min_credits', 'max_credits'):
                credits = document['student'][key]
                ensure(credits is None or credits == int(credits), '희망학점은 정수로 입력해주세요.')
            saved = self.load_version(version)
            check_import_sources(document, saved['document'])
            result = self.server.store.save(document, version, reviewed=final)
            return self.respond(200, dict(**result, document=document, warnings=document_warnings(document)))
        except ConflictError as exc:
            return self.respond(409, {'error': str(exc)})
        except (ValidationError, ImportFailure, ValueError, TypeError) as exc:
            return self.respond(400, {'error': str(exc) if isinstance(exc, (ValidationError, ImportFailure))
                                      else '입력 형식을 확인해주세요.'})
        except (sqlite3.Error, OSError):
            return self.respond(500, {'error': '로컬 저장 또는 처리에 실패했습니다. 폴더 권한과 디스크 공간을 확인해주세요.'})

    def load_version(self, version, *, include_origins=False):
        saved = self.server.store.load(include_import_origins=include_origins)
        if saved['version'] != version:
            raise ConflictError('다른 창에서 저장한 내용이 있습니다. 새로고침하고 다시 진행해주세요.')
        return saved

    def preview_import(self, value, version):
        saved = self.load_version(version, include_origins=True)
        document = validate_document(saved['document'] or EMPTY_DOCUMENT)
        url = value.get('shared_url')
        ensure(isinstance(url, str) and len(url) <= 300, '에브리타임 공유 링크를 확인해주세요.')
        if not self.server.import_lock.acquire(blocking=False):
            return self.respond(429, {'error': '시간표를 가져오는 중입니다. 완료 후 다시 시도해주세요.'})
        try:
            collection = self.server.collector(url, timeout=180)
            self.load_version(version)
            preview, hashes = prepare_import(collection, document, saved['import_origins'])
            if value.get('official_only') is True:
                try:
                    matches = compare_offerings(self.server.official_db, preview, require_completion=False)
                except (sqlite3.Error, OSError, ValueError):
                    return self.respond(503, {'error': '공식 개설강좌 DB를 읽을 수 없습니다.'})
                confirmed = {item['course_attempt_id'] for item in matches if item['status'] == 'offering_matched'}
                preview['official_excluded_count'] = len(matches) - len(confirmed)
                preview['course_attempts'] = [row for row in preview['course_attempts'] if row['id'] in confirmed]
                preview['changes'] = [row for row in preview['changes'] if row['incoming_attempt_id'] in confirmed]
                hashes = {key: value for key, value in hashes.items() if key in confirmed}
            now = monotonic()
            cache = self.server.previews
            for key in list(cache):
                if cache[key][0] <= now:
                    del cache[key]
            if len(cache) >= 8:
                del cache[next(iter(cache))]
            import_id = secrets.token_urlsafe(24)
            preview.update(import_id=import_id, base_revision=version)
            cache[import_id] = (now + 1800, preview, hashes)
        finally:
            self.server.import_lock.release()
        return self.respond(200, preview)

    def commit_import(self, value, version):
        import_id = value.get('import_id')
        ensure(isinstance(import_id, str), '가져오기 미리보기를 다시 열어주세요.')
        saved = self.load_version(version)
        item = self.server.previews.get(import_id)
        if item is None or item[0] <= monotonic():
            return self.respond(404, {'error': '미리보기가 만료됐습니다. 공유 링크를 다시 가져와주세요.'})
        _, preview, hashes = item
        if preview['base_revision'] != version:
            raise ConflictError('학생 입력이 변경됐습니다. 공유 링크를 다시 가져와주세요.')
        document = validate_document(saved['document'] or EMPTY_DOCUMENT)
        if value.get('replace') is True:
            origins = replace_import(document, preview, hashes, value.get('accepted_attempt_ids'))
        else:
            origins = apply_import(document, preview, hashes, value.get('accepted_attempt_ids'),
                                   value.get('accepted_update_ids'))
        document = validate_document(document)
        result = self.server.store.save(document, version, import_origins=origins)
        return self.respond(200, dict(**result, document=document, warnings=document_warnings(document)))

    def compare_saved(self, version):
        saved = self.load_version(version)
        ensure(saved['document'] is not None, '이수내역을 저장한 후 대조해주세요.')
        document = validate_document(saved['document'])
        try:
            matches = compare_offerings(self.server.official_db, document)
        except (sqlite3.Error, OSError, ValueError):
            return self.respond(503, {'error': '공식 개설강좌 DB를 읽을 수 없습니다. DB 파일을 확인해주세요.'})
        self.load_version(version)
        return self.respond(200, dict(kind='offering_comparison', schema_version=1, input_revision=version,
                                      matches=matches))

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--db', type=Path, default=BASE / 'runtime' / 'student_inputs.sqlite')
    parser.add_argument('--official-db', type=Path, default=OFFICIAL_DB)
    parser.add_argument('--ratings-db', type=Path, default=RATINGS_DB)
    args = parser.parse_args()
    server = Application(('127.0.0.1', args.port), args.db, args.official_db, ratings_db=args.ratings_db)
    print(f'Local: http://127.0.0.1:{server.server_port}', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()

if __name__ == '__main__':
    main()
