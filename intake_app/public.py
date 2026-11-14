"""Public beta entry point. Student profiles belong to the visitor's browser."""
from contextlib import closing
from hashlib import sha256
from http import HTTPStatus
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3
from threading import BoundedSemaphore, Lock
from time import monotonic
from urllib.parse import urlsplit

from everytime_import.importer import ImportFailure, collect

from .advisor import AdvisorError, GeminiAdvisor, TASK_ACTIONS, valid_intent
from .domain import ValidationError, document_warnings, ensure, validate_document
from .imports import prepare_import, replace_import
from .interest_tags import load_tags
from .offerings import active_snapshots, compare_offerings
from .recommendations import recommend
from .server import BASE, MAX_BODY, OFFICIAL_DB, RATINGS_DB, SCHEDULE_ACTIONS

STATIC = {
    '/': ('index.html', 'text/html; charset=utf-8'),
    '/recommendations': ('index.html', 'text/html; charset=utf-8'),
    '/schedules': ('index.html', 'text/html; charset=utf-8'),
    '/app.js': ('app.js', 'text/javascript; charset=utf-8'),
    '/style.css': ('style.css', 'text/css; charset=utf-8'),
    '/fonts/gowun-batang-bold.woff': ('fonts/gowun-batang-bold.woff', 'font/woff'),
    '/fonts/noto-sans-kr.woff': ('fonts/noto-sans-kr.woff', 'font/woff'),
}
SECURITY_HEADERS = [
    ('Cache-Control', 'no-store'),
    ('X-Content-Type-Options', 'nosniff'),
    ('Referrer-Policy', 'no-referrer'),
    ('Content-Security-Policy',
     "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; "
     "frame-ancestors 'none'; base-uri 'none'; form-action 'self'"),
]


def fingerprint(document):
    data = json.dumps(document, sort_keys=True, separators=(',', ':')).encode('utf-8')
    return sha256(data).digest()


class PublicApp:
    def __init__(self, origin, *, official_db=OFFICIAL_DB, ratings_db=RATINGS_DB, collector=collect):
        parsed = urlsplit(origin)
        if (parsed.scheme != 'https' or not parsed.hostname or parsed.username or
                parsed.password or parsed.path or parsed.query or parsed.fragment):
            raise ValueError('공개 HTTPS 주소�??�정?�주?�요.')
        self.origin = origin
        self.host = parsed.netloc.lower()
        self.official_db = Path(official_db)
        self.ratings_db = ratings_db
        self.collect = collector
        self.token = secrets.token_urlsafe(32)
        self.compute_slots = BoundedSemaphore(2)
        self.import_slot = Lock()
        self.preview_lock = Lock()
        self.previews = {}
        self.advisor = GeminiAdvisor()
        self.static = {path: ((BASE / 'static' / name).read_bytes(), content_type)
                       for path, (name, content_type) in STATIC.items()}

    def __call__(self, environ, start_response):
        status, body, content_type = self.dispatch(environ)
        if content_type == 'application/json; charset=utf-8':
            body = json.dumps(body, ensure_ascii=False, allow_nan=False).encode('utf-8')
        start_response(f'{status} {HTTPStatus(status).phrase}', [
            ('Content-Type', content_type), ('Content-Length', str(len(body))), *SECURITY_HEADERS])
        return [body]

    def dispatch(self, env):
        content_type = 'application/json; charset=utf-8'

        def reply(status, value):
            return status, value, content_type

        host = env.get('HTTP_HOST', '').lower()
        origin = env.get('HTTP_ORIGIN')
        if host != self.host or (origin and origin != self.origin):
            return reply(403, {'error': '공식 ?�비??주소�??�근?�주?�요.'})
        method, path = env['REQUEST_METHOD'], env['PATH_INFO']
        try:
            if method == 'GET':
                if path in self.static:
                    body, mime = self.static[path]
                    return 200, body, mime
                if path == '/healthz':
                    uri = self.official_db.resolve().as_uri() + '?mode=ro'
                    with closing(sqlite3.connect(uri, uri=True)) as db:
                        db.row_factory = sqlite3.Row
                        ready = bool(active_snapshots(db))
                    return reply(200 if ready else 503, {'ok': ready})
                if path == '/api/config':
                    tags, aliases, _ = load_tags()
                    return reply(200, {
                        'csrf_token': self.token, 'browser_storage': True,
                        'schedule_course_exclusions': True,
                        'advisor_chat': True,
                        'gemini_advisor': self.advisor.available,
                        'interest_tags': [{key: tag[key] for key in ('id', 'label', 'group')} for tag in tags],
                        'interest_aliases': {label: sorted(ids) for label, ids in aliases.items()},
                    })
                if path == '/api/input':
                    return reply(405, {'error': '공개 버전???�생 ?�보??브라?��??�서 관리합?�다.'})
                return reply(404, {'error': '경로�?찾을 ???�습?�다.'})
            if method != 'POST':
                return reply(405, {'error': '지?�하지 ?�는 ?�청?�니??'})
            token = env.get('HTTP_X_APP_TOKEN', '')
            if (origin != self.origin or not token.isascii() or
                    not secrets.compare_digest(token, self.token)):
                return reply(403, {'error': '?�이지�??�로고침?????�시 ?�도?�주?�요.'})
            if path not in SCHEDULE_ACTIONS and path not in (
                '/api/recommendations', '/api/input', '/api/import/preview',
                '/api/import/apply', '/api/offerings/compare', '/api/advisor/chat',
            ):
                return reply(404, {'error': '경로�?찾을 ???�습?�다.'})
            ensure(env.get('CONTENT_TYPE', '').split(';')[0] == 'application/json', 'JSON ?�청�?지?�합?�다.')
            length = int(env.get('CONTENT_LENGTH') or '0')
            ensure(0 < length <= MAX_BODY, '?�청??비어 ?�거???�무 ?�니??')
            value = json.loads(env['wsgi.input'].read(length))
            ensure(isinstance(value, dict), '?�청 ?�식 ?�류')
            if path == '/api/advisor/chat':
                question = value.get('question')
                previous = value.get('previous_intent')
                topic = value.get('topic')
                ensure(isinstance(question, str)
                       and 1 <= len(question.strip()) <= 400
                       and (previous is None or valid_intent(previous)), '질문 형식을 확인해주세요.')
                return reply(200, self.advisor.ask(question.strip(), previous, topic))
            version = value.get('version')
            ensure(type(version) is int and version >= 0, '?�력 버전 ?�류')
            reviewed = value.get('reviewed', False)
            ensure(type(reviewed) is bool, '?�력 ?�인 ?�태 ?�류')
            document = validate_document(value.get('document'), final=path == '/api/input' and reviewed)
            if path == '/api/input':
                for key in ('min_credits', 'max_credits'):
                    credits = document['student'][key]
                    ensure(credits is None or credits == int(credits), '?�망?�점?� ?�수�??�력?�주?�요.')
                return reply(200, dict(document=document, warnings=document_warnings(document)))
            if path in ('/api/import/preview', '/api/import/apply'):
                client = env.get('HTTP_X_COURSE_VISITOR', '')
                ensure(re.fullmatch(r'[a-f0-9-]{36}', client) is not None, '??브라?��??�서 ?�시 가?��?주세??')
                if path.endswith('/apply'):
                    return reply(200, self.apply_import(client, document, value))
                if not self.import_slot.acquire(blocking=False):
                    return reply(429, {'error': '?�간??가?�오기�? 진행 중입?�다. ?�시 ???�시 ?�도?�주?�요.'})
                try:
                    return reply(200, self.preview_import(client, document, value))
                finally:
                    self.import_slot.release()
            if not self.compute_slots.acquire(blocking=False):
                return reply(429, {'error': '?�청??많습?�다. ?�시 ???�시 ?�도?�주?�요.'})
            try:
                return reply(200, self.calculate(path, document, value))
            finally:
                self.compute_slots.release()
        except AdvisorError as exc:
            return reply(exc.status, {'error': str(exc)})
        except (ValidationError, ImportFailure) as exc:
            return reply(400, {'error': str(exc)})
        except (ValueError, TypeError, RecursionError):
            return reply(400, {'error': '?�력 ?�식???�인?�주?�요.'})
        except (OSError, sqlite3.Error):
            return reply(503, {'error': '강좌 ?�이?��? ?�을 ???�습?�다. ?�시 ???�시 ?�도?�주?�요.'})

    def calculate(self, path, document, value):
        if path == '/api/offerings/compare':
            result = dict(kind='offering_comparison', schema_version=1,
                          matches=compare_offerings(self.official_db, document))
        elif path == '/api/recommendations':
            if value.get('automatic_term') is True:
                document['student'].update(target_term=None, recognition_notes='')
            result = recommend(self.official_db, document, ratings_db=self.ratings_db)
        elif path == '/api/schedules':
            result = SCHEDULE_ACTIONS[path](self.official_db, document, value, ratings_db=self.ratings_db,
                                            include_graduation_projection=True)
        else:
            result = SCHEDULE_ACTIONS[path](self.official_db, document, value, ratings_db=self.ratings_db)
        return dict(result, input_revision=value['version'])

    def preview_import(self, client, document, value):
        url = value.get('shared_url')
        ensure(isinstance(url, str) and len(url) <= 300, '?�브리�???공유 링크�??�인?�주?�요.')
        collection = self.collect(url, timeout=45, max_tables=20)
        preview, hashes = prepare_import(collection, document, {})
        if value.get('official_only') is True:
            matches = compare_offerings(self.official_db, preview, require_completion=False)
            confirmed = {row['course_attempt_id'] for row in matches if row['status'] == 'offering_matched'}
            preview['official_excluded_count'] = len(matches) - len(confirmed)
            preview['course_attempts'] = [row for row in preview['course_attempts'] if row['id'] in confirmed]
            preview['changes'] = [row for row in preview['changes'] if row['incoming_attempt_id'] in confirmed]
            hashes = {key: item for key, item in hashes.items() if key in confirmed}
        preview.update(import_id=secrets.token_urlsafe(24), base_revision=value['version'])
        now = monotonic()
        with self.preview_lock:
            for key, item in list(self.previews.items()):
                if item[0] <= now or item[1] == client:
                    del self.previews[key]
            if len(self.previews) >= 8:
                del self.previews[next(iter(self.previews))]
            self.previews[preview['import_id']] = (now + 300, client, fingerprint(document), preview, hashes)
        return preview

    def apply_import(self, client, document, value):
        import_id = value.get('import_id')
        ensure(isinstance(import_id, str), '가?�오�?미리보기�??�시 ?�어주세??')
        with self.preview_lock:
            item = self.previews.get(import_id)
            ensure(item is not None and item[0] > monotonic() and item[1] == client,
                   '미리보기가 만료?�습?�다. 공유 링크�??�시 가?��?주세??')
            _, _, saved_digest, preview, hashes = item
            ensure(saved_digest == fingerprint(document) and preview['base_revision'] == value['version'],
                   '?�생 ?�력??변경됐?�니?? 공유 링크�??�시 가?��?주세??')
            ensure(value.get('replace') is True, '가?�올 과목???�시 ?�택?�주?�요.')
            replace_import(document, preview, hashes, value.get('accepted_attempt_ids'))
            return dict(document=validate_document(document), warnings=document_warnings(document))


def main():
    from waitress import serve

    app = PublicApp(os.environ['RENDER_EXTERNAL_URL'])
    serve(app, host='0.0.0.0', port=int(os.environ.get('PORT', '10000')),
          threads=6, connection_limit=60, channel_timeout=60, max_request_body_size=MAX_BODY)


if __name__ == '__main__':
    main()
