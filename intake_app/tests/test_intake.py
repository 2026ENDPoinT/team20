import copy
import http.client
import json
from pathlib import Path
import sqlite3
import tempfile
import threading
import unittest

from intake_app.domain import ValidationError, validate_document, document_warnings
from intake_app.recommendations import recommend
from intake_app.server import Application
from everytime_import import collect

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

    def test_recommendation_groups_use_grade_and_keep_future_requirements(self):
        document = profile()
        document.update(history_complete=True)
        document['student'].update(admission_year=2025, grade=3, target_term='2026-2',
                                   program_type='standard_single_major_day')
        document = validate_document(document)
        db = BASE.parent / 'db' / 'courses.sqlite3'
        result = recommend(db, document)
        candidates = {row['course_code']: row for row in result['candidates']}
        order = list(candidates)
        self.assertEqual(list(dict.fromkeys(row['group'] for row in result['candidates'])), [
            'current_major_required', 'future_major_required', 'required_general', 'major_credits', 'general_credits',
        ])
        self.assertEqual(candidates['109004']['group'], 'current_major_required')
        self.assertEqual(candidates['109114']['group'], 'future_major_required')
        self.assertEqual(candidates['109114']['requirement_ids'], ['capstone_2'])
        self.assertLess(order.index('109078'), order.index('109180'))
        self.assertTrue(candidates['109180']['lower_grade'])
        self.assertEqual(candidates['109004']['eligibility'], 'needs_review')
        self.assertEqual(candidates['100057']['group'], 'required_general')
        capstone_1 = next(rule for rule in result['requirements'] if rule['id'] == 'capstone_1')
        self.assertEqual(capstone_1['recommendation_group'], 'future_major_required')
        self.assertFalse(capstone_1['offered'])
        document['student']['grade'] = 4
        result = recommend(db, document)
        self.assertEqual(next(row['group'] for row in result['candidates'] if row['course_code'] == '109114'),
                         'current_major_required')

    def test_major_elective_alternatives_use_target_year_and_confirmed_history(self):
        document = profile()
        document['student'].update(target_term='2026-2', program_type='standard_single_major_day')
        db = BASE.parent / 'db' / 'courses.sqlite3'

        def candidates():
            result = recommend(db, validate_document(document))
            return {row['course_code']: row for row in result['candidates']}

        offered = candidates()
        self.assertEqual(offered['109073']['alternative_group'], offered['109829']['alternative_group'])
        self.assertEqual(offered['109073']['alternative_group']['id'], '109073')
        self.assertTrue(offered['109834']['sections'])
        self.assertNotIn('109341', offered)
        self.assertNotIn('alternative_group', offered['109261'])

        document['course_attempts'] = [
            dict(id='linear-algebra', course_name='선형대수학', lecture_code='109073-11001', term='2024-2',
                 completion_status='completed', user_confirmed=True),
            dict(id='database', course_name='데이터베이스', lecture_code='109341-21001', term='2024-2',
                 completion_status='completed', user_confirmed=True),
        ]
        remaining = candidates()
        self.assertTrue({'109073', '109829', '109341', '109834'}.isdisjoint(remaining))

        document['student']['target_term'] = '2025-1'
        general_linear_algebra = candidates()['100591']
        self.assertEqual(general_linear_algebra['group'], 'general_credits')
        self.assertNotIn('alternative_group', general_linear_algebra)

        document['course_attempts'] = []
        document['student'].update(admission_year=2022, target_term='2022-2')
        self.assertNotIn('alternative_group', candidates()['109073'])

    def test_confirmed_current_alternatives_are_reserved_without_credit(self):
        document = profile()
        document['student'].update(target_term='2026-2', program_type='standard_single_major_day')
        document['history_complete'] = True
        db = BASE.parent / 'db' / 'courses.sqlite3'
        result = recommend(db, validate_document(document))
        candidates = {row['course_code']: row for row in result['candidates']}
        self.assertEqual(candidates['109004']['alternative_group']['id'], 'programming_2')

        for code in ('109073', '109004'):
            candidate = candidates[code]
            document['course_attempts'].append(dict(
                id=code, course_name=candidate['course_name'], term='2026-2',
                lecture_code=f"{code}-{candidate['sections'][0]['section_code']}",
                completion_status='in_progress', user_confirmed=True,
            ))

        result = recommend(db, validate_document(document))
        remaining = {row['course_code'] for row in result['candidates']}
        self.assertFalse({'109073', '109829', '109004', '109417'} & remaining)
        requirements = {rule['id']: rule for rule in result['requirements']}
        self.assertTrue(requirements['programming_2']['in_progress'])
        self.assertNotEqual(requirements['programming_2']['status'], 'met')
        self.assertEqual(requirements['major']['current'], 0)
        self.assertEqual(result['credit_reviews'], [])

        document['course_attempts'][0]['lecture_code'] = '109073-99999'
        result = recommend(db, validate_document(document))
        self.assertIn('109829', {row['course_code'] for row in result['candidates']})

    def test_duplicate_elective_credit_needs_review(self):
        document = profile()
        document['student'].update(admission_year=2022, target_term='2026-2',
                                   program_type='standard_single_major_day')
        document['history_complete'] = True
        document['course_attempts'] = [
            dict(id='linear-algebra-ko', course_name='선형대수학', lecture_code='109073-11001',
                 term='2022-2', completion_status='completed', user_confirmed=True),
            dict(id='linear-algebra-en', course_name='Linear Algebra', lecture_code='109829-11001',
                 term='2023-2', completion_status='completed', user_confirmed=True),
        ]
        result = recommend(BASE.parent / 'db' / 'courses.sqlite3', validate_document(document))
        self.assertEqual(result['credit_reviews'], [
            {'title': '선형대수학', 'course_codes': ['109073', '109829']},
        ])
        requirements = {rule['id']: rule for rule in result['requirements']}
        for id in ('total', 'major'):
            self.assertEqual(requirements[id]['current'], 0)
            self.assertEqual(requirements[id]['status'], 'needs_review')
        self.assertTrue(result['partial'])

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

    def test_import_preview_apply_reimport_and_official_comparison(self):
        name = '프로그래밍입문(2)'
        professor = '강동완'

        def fake_collection(url, **options):
            xml = f'''<response><table identifier="example" year="2026" semester="2">
                <subject id="subject-id"><internal value="109004-11001"/>
                <name value="{name}"/><professor value="{professor}"/></subject>
                <subject><name value="수동 과목"/></subject>
                </table></response>'''
            return collect(url, fetcher=lambda identifier: xml)

        original = self.server.collector
        self.server.collector = fake_collection
        self.addCleanup(setattr, self.server, 'collector', original)
        official = Path(self.temp.name) / 'official.sqlite'
        with sqlite3.connect(official) as connection:
            connection.executescript('''
                CREATE TABLE snapshots (snapshot_id INTEGER, term TEXT, sha256 TEXT);
                CREATE TABLE active_terms (term TEXT, snapshot_id INTEGER);
                CREATE TABLE course_offerings (snapshot_id INTEGER, offering_id TEXT, course_code TEXT,
                    section TEXT, course_name TEXT, professor TEXT, payload_json TEXT);
                INSERT INTO snapshots VALUES (1, '20262', 'fixture-hash');
                INSERT INTO active_terms VALUES ('20262', 1);
            ''')
            connection.execute('INSERT INTO course_offerings VALUES (?, ?, ?, ?, ?, ?, ?)',
                (1, '20262:109004:11001:00500001', '109004', '11001', name, professor, '{"credits":"3"}'))
        connection.close()
        self.addCleanup(setattr, self.server, 'official_db', self.server.official_db)
        self.server.official_db = official
        _, before = self.request('/api/input')
        payload = {'version': before['version'], 'shared_url': 'https://everytime.kr/app/@example'}
        status, preview = self.request('/api/import/preview', payload)
        self.assertEqual(status, 200, preview)
        self.assertEqual(self.request('/api/input')[1], before)
        self.assertNotIn('source_timetable_id', json.dumps(preview))
        self.assertNotIn('subject-id', json.dumps(preview))
        self.assertTrue(all(row['completion_status'] == 'unconfirmed' for row in preview['course_attempts']))

        apply = {'version': before['version'], 'import_id': preview['import_id'],
                 'accepted_attempt_ids': [row['id'] for row in preview['course_attempts']],
                 'accepted_update_ids': []}
        status, saved = self.request('/api/import/apply', apply)
        self.assertEqual(status, 200, saved)
        self.assertEqual(self.request('/api/import/apply', apply)[0], 409)
        comparison = self.request('/api/offerings/compare', {'version': saved['version']})[1]
        self.assertTrue(all(row['status'] == 'not_checked' for row in comparison['matches']))

        document = saved['document']
        for row in document['course_attempts']:
            row.update(completion_status='completed', user_confirmed=True, review_notes='직접 확인')
        status, saved = self.request('/api/input', {'version': saved['version'], 'document': document})
        self.assertEqual(status, 200, saved)
        comparison = self.request('/api/offerings/compare', {'version': saved['version']})[1]
        self.assertIn('offering_matched', [row['status'] for row in comparison['matches']])
        self.assertIn('missing_lecture_code', [row['reason'] for row in comparison['matches']])
        payload['version'] = saved['version']
        status, repeated = self.request('/api/import/preview', payload)
        self.assertEqual(status, 200, repeated)
        self.assertEqual([row['action'] for row in repeated['changes']], ['unchanged', 'unchanged'])

        professor = '변경된 교수'
        status, changed = self.request('/api/import/preview', payload)
        self.assertEqual(status, 200, changed)
        self.assertEqual(changed['changes'][0]['changed_fields'], ['professor'])
        self.assertEqual(changed['changes'][0]['action'], 'update')
        status, updated = self.request('/api/import/apply', {
            'version': saved['version'], 'import_id': changed['import_id'],
            'accepted_attempt_ids': [], 'accepted_update_ids': [changed['course_attempts'][0]['id']],
        })
        self.assertEqual(status, 200, updated)
        rows = {row['lecture_code']: row for row in updated['document']['course_attempts']}
        self.assertFalse(rows['109004-11001']['user_confirmed'])
        self.assertEqual(rows['109004-11001']['review_notes'], '직접 확인')
        self.assertTrue(rows[None]['user_confirmed'])

if __name__=='__main__':unittest.main()
