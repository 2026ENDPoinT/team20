import copy
import http.client
import json
from pathlib import Path
import tempfile
import threading
import unittest

from intake_app.domain import ValidationError, validate_document, document_warnings
from intake_app.server import Application

BASE = Path(__file__).resolve().parents[1]

def profile():
    return dict(student=dict(department_id='DEPT_CS', admission_year=2024, grade=2,
        admission_type='freshman', target_term='2027-1', min_credits=15, max_credits=20,
        interests=['경제', '인공지능']), history_complete=False, course_attempts=[])


def manual_course():
    return {
        'id': 'manual-1',
        'course_name': '데이터베이스',
        'term': '2026-2',
        'meetings': [{'day': 'MON', 'start_time': '09:00', 'end_time': '10:30',
                      'locations': ['미래관-101', '미래관-102']}],
    }

class DomainTests(unittest.TestCase):
    def test_profile_and_optional_fields(self):
        result = validate_document(profile(), final=True)
        self.assertEqual(result['student']['interests'], ['경제', '인공지능'])
        self.assertIsNone(result['student']['transfer_recognized_credits'])

    def test_draft_can_be_incomplete_but_review_cannot(self):
        value = profile(); value['student']['admission_year'] = None
        validate_document(value)
        with self.assertRaises(ValidationError): validate_document(value, final=True)

    def test_bad_credit_range_and_bool_rejected(self):
        for field, value in [('min_credits', 25), ('grade', True), ('min_credits', float('nan'))]:
            document=profile(); document['student'][field]=value
            with self.assertRaises(ValidationError): validate_document(document)

    def test_bad_terms_and_time_order_rejected(self):
        for semester in ('2026-3', '2026', 'whatever'):
            document=profile();document['student']['target_term']=semester
            with self.assertRaises(ValidationError): validate_document(document)
        document = profile()
        document['course_attempts'] = [manual_course()]
        document['course_attempts'][0]['meetings'][0]['end_time'] = '08:00'
        with self.assertRaises(ValidationError): validate_document(document)

    def test_review_requires_confirmed_completion_status_and_unmatched_code(self):
        document = profile()
        course = manual_course()
        document['course_attempts'] = [course]
        with self.assertRaises(ValidationError):
            validate_document(document, final=True)
        course.update(user_confirmed=True, completion_status='completed')
        validate_document(document, final=True)
        course['course_id'] = 'invented'
        with self.assertRaises(ValidationError):
            validate_document(document)

    def test_transfer_and_partial_history_are_explicit(self):
        document = profile()
        document['student'].update(admission_type='transfer', transfer_recognized_credits=42)
        document = validate_document(document)
        self.assertEqual(document['student']['transfer_recognized_credits'], 42)
        self.assertTrue(any('일부' in message for message in document_warnings(document)))

    def test_duplicate_ids_rejected_but_repeated_course_names_retained(self):
        course = manual_course()
        document = profile()
        document['course_attempts'] = [course, copy.deepcopy(course)]
        with self.assertRaises(ValidationError): validate_document(document)
        document['course_attempts'][1]['id']='separate-block'
        result=validate_document(document)
        self.assertEqual(len(result['course_attempts']), 2)
        self.assertTrue(any('동명' in warning for warning in document_warnings(result)))

class StorageAndHttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp=tempfile.TemporaryDirectory(prefix='intake-tests-',dir=BASE)
        cls.server=Application(('127.0.0.1',0),Path(cls.temp.name)/'test.sqlite')
        cls.thread=threading.Thread(target=cls.server.serve_forever,daemon=True);cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown();cls.server.server_close();cls.thread.join()
        target=Path(cls.temp.name).resolve()
        assert target.parent==BASE.resolve() and target.name.startswith('intake-tests-')
        cls.temp.cleanup()

    def request(self, path, body=None, headers=None):
        conn=http.client.HTTPConnection('127.0.0.1',self.server.server_port,timeout=5)
        try:
            data=json.dumps(body) if body is not None else None
            h={'Content-Type':'application/json','X-App-Token':self.server.token};h.update(headers or {})
            conn.request('GET' if body is None else 'POST',path,data,h)
            response=conn.getresponse();raw=response.read()
            return response.status, json.loads(raw) if 'json' in response.getheader('Content-Type','') else raw
        finally:conn.close()

    def test_save_reload_and_stale_version(self):
        _, before = self.request('/api/input')
        document = profile()
        course = manual_course()
        course.update(completion_status='completed', user_confirmed=True)
        document['course_attempts'] = [course]
        status, saved = self.request('/api/input', {
            'document': document, 'version': before['version'], 'reviewed': True,
        })
        self.assertEqual(status, 200)
        _, loaded = self.request('/api/input')
        self.assertEqual(loaded['review_state'], 'reviewed')
        self.assertEqual(loaded['document'], saved['document'])
        self.assertEqual(loaded['document']['student']['interests'], document['student']['interests'])
        self.assertEqual(loaded['document']['course_attempts'][0]['meetings'], course['meetings'])
        status, _ = self.request('/api/input', {'document': document, 'version': before['version']})
        self.assertEqual(status, 409)

    def test_invalid_request_does_not_replace_saved_record(self):
        _,before=self.request('/api/input');bad=profile();bad['student']['grade']=8
        status,_=self.request('/api/input',{'document':bad,'version':before['version']})
        self.assertEqual(status,400)
        _,after=self.request('/api/input');self.assertEqual(before,after)

    def test_local_only_and_csrf_boundary(self):
        status,_=self.request('/api/input',{'document':profile(),'version':0},headers={'X-App-Token':''})
        self.assertEqual(status,403)
        status,_=self.request('/api/config',headers={'Origin':'https://elsewhere.example'})
        self.assertEqual(status,403)
        status,_=self.request('/api/config',headers={'Host':'attacker.example'})
        self.assertEqual(status,403)

    def test_static_allowlist_does_not_expose_database(self):
        self.assertEqual(self.request('/')[0],200)
        self.assertEqual(self.request('/runtime/student_inputs.sqlite')[0],404)
        self.assertEqual(self.request('/../store.py')[0],404)

if __name__=='__main__':unittest.main()
