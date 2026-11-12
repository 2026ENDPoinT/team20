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

    def load(self):
        connection = self.connect()
        try:
            row = connection.execute('SELECT * FROM student_input WHERE id=1').fetchone()
            if row is None:
                return dict(version=0, document=None, review_state='draft', updated_at=None)
            return dict(version=row['version'], document=json.loads(row['document_json']),
                        review_state=row['review_state'], updated_at=row['updated_at'])
        finally:
            connection.close()

    def save(self, document, version, reviewed=False):
        connection = self.connect()
        try:
            with connection:
                connection.execute('BEGIN IMMEDIATE')
                row = connection.execute('SELECT version FROM student_input WHERE id=1').fetchone()
                current = row['version'] if row else 0
                if current != version:
                    raise ConflictError('다른 창에서 저장한 내용이 있습니다. 현재 내용을 JSON으로 내려받은 뒤 새로고침해주세요.')
                updated = datetime.now(timezone.utc).isoformat()
                connection.execute('INSERT OR REPLACE INTO student_input VALUES (1,?,?,?,?)',
                    (current + 1, json.dumps(document, ensure_ascii=False), 'reviewed' if reviewed else 'draft', updated))
            return dict(version=current + 1, updated_at=updated, review_state='reviewed' if reviewed else 'draft')
        finally:
            connection.close()

