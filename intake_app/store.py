import json
from pathlib import Path
import sqlite3
from datetime import datetime, timezone

class ConflictError(ValueError):
    pass

class Store:
    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        connection = self.connect()
        try:
            connection.executescript('''
                CREATE TABLE IF NOT EXISTS student_input (
                    id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL,
                    document_json TEXT NOT NULL, review_state TEXT NOT NULL, updated_at TEXT NOT NULL);
                PRAGMA user_version=1;
            ''')
        finally:
            connection.close()

    def connect(self):
        connection = sqlite3.connect(self.path, timeout=10)
        connection.row_factory = sqlite3.Row
        return connection

    def load(self, *, include_import_origins=False):
        connection = self.connect()
        try:
            row = connection.execute('SELECT * FROM student_input WHERE id=1').fetchone()
            document = json.loads(row['document_json']) if row else None
            origins = document.pop('_import_origins', {}) if document else {}
            result = (dict(version=row['version'], document=document, review_state=row['review_state'],
                           updated_at=row['updated_at']) if row else
                      dict(version=0, document=None, review_state='draft', updated_at=None))
            if include_import_origins:
                result['import_origins'] = origins
            return result
        finally:
            connection.close()

    def save(self, document, version, reviewed=False, *, import_origins=None):
        connection = self.connect()
        try:
            with connection:
                connection.execute('BEGIN IMMEDIATE')
                row = connection.execute('SELECT version, document_json FROM student_input WHERE id=1').fetchone()
                current = row['version'] if row else 0
                if current != version:
                    raise ConflictError('다른 창에서 저장한 내용이 있습니다. 현재 내용을 JSON으로 내려받은 뒤 새로고침해주세요.')
                updated = datetime.now(timezone.utc).isoformat()
                origins = json.loads(row['document_json']).get('_import_origins', {}) if row else {}
                origins.update(import_origins or {})
                stored = dict(document, _import_origins={
                    item['id']: origins[item['id']] for item in document['course_attempts']
                    if item['source'] == 'everytime' and item['id'] in origins
                })
                connection.execute('INSERT OR REPLACE INTO student_input VALUES (1,?,?,?,?)',
                    (current + 1, json.dumps(stored, ensure_ascii=False), 'reviewed' if reviewed else 'draft', updated))
            return dict(version=current + 1, updated_at=updated, review_state='reviewed' if reviewed else 'draft')
        finally:
            connection.close()

