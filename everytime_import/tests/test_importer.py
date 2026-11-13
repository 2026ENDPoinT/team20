import json
from pathlib import Path
import tempfile
import unittest

from everytime_import.importer import ImportFailure, collect, identifier_from_url, parse_table, save_json


def xml(identifier='abc', year='2024', semester='1', subjects=None, references=''):
    if subjects is None:
        subjects = '''<subject id="100"><internal value="001234-01001"/>
        <name value="자료구조 &amp; 실습"/><professor value="김교수"/>
        <credit value="3"/><time><data day="0" starttime="100" endtime="120"/>
        <data day="2" starttime="100" endtime="120"/></time><place value="강의실"/></subject>'''
    return (f'<response><table year="{year}" semester="{semester}" identifier="{identifier}">'
            f'{subjects}</table><user name="저장하지 않을 이름"/>'
            f'<primaryTables>{references}</primaryTables></response>')


class ParsingTests(unittest.TestCase):
    def test_link_is_strict(self):
        self.assertEqual(identifier_from_url('https://everytime.kr/@abc/'), 'abc')
        self.assertEqual(identifier_from_url('https://everytime.kr/app/@abc'), 'abc')
        for url in ['https://everytime.kr.evil/@abc', 'http://everytime.kr/@abc',
                    'https://name@everytime.kr/@abc', 'https://everytime.kr/@abc?q=x',
                    'https://everytime.kr/@abc/path', 'https://everytime.kr:bad/@abc',
                    'https://everytime.kr/app/@abc/path', 'https://everytime.kr/app/@abc?q=x',
                    'https://everytime.kr.evil/app/@abc']:
            with self.subTest(url=url), self.assertRaises(ImportFailure):
                identifier_from_url(url)

    def test_minimal_fields_keep_code_and_do_not_assume_completed(self):
        result = parse_table(xml(), 'abc')
        self.assertEqual(len(result['courses']), 1)
        row = result['courses'][0]
        self.assertEqual(row['lecture_code'], '001234-01001')
        self.assertEqual(row['course_name'], '자료구조 & 실습')
        self.assertEqual(row['professor'], '김교수')
        self.assertEqual(row['completion_status'], 'unconfirmed')
        self.assertFalse(row['user_confirmed'])
        for field in ['course_id', 'credits', 'meetings', 'time', 'place', 'source_course_code']:
            self.assertNotIn(field, row)
        self.assertEqual(row['id'], parse_table(xml(), 'abc')['courses'][0]['id'])

    def test_season_terms_and_empty_table(self):
        for semester, term in [('1', '2024-1'), ('2', '2024-2'),
                               ('여름', '2024-summer'), ('겨울', '2024-winter')]:
            result = parse_table(xml(semester=semester, subjects=''), 'abc')
            self.assertEqual(result['term'], term)
            self.assertEqual(result['courses'], [])

    def test_unknown_semester_and_invalid_responses_fail(self):
        for response in [xml(semester='3'), '<response/>', '<response><error>403</error></response>',
                         '<html>login</html>', '<response', xml(identifier='other'),
                         '<!DOCTYPE response><response/>']:
            with self.subTest(response=response), self.assertRaises(ImportFailure):
                parse_table(response, 'abc')

    def test_missing_code_is_retained_for_review(self):
        result = parse_table(xml(subjects='<subject><name value="자유 입력"/></subject>'), 'abc')
        self.assertIsNone(result['courses'][0]['lecture_code'])
        self.assertIn('missing_matching_fields', [w['code'] for w in result['warnings']])
        self.assertIn('position_based_id', [w['code'] for w in result['warnings']])

    def test_source_duplicates_only(self):
        subject = '<subject id="1"><name value="동명"/></subject>'
        result = parse_table(xml(subjects=subject+subject+subject.replace('id="1"', 'id="2"')), 'abc')
        self.assertEqual(len(result['courses']), 2)
        with self.assertRaises(ImportFailure):
            parse_table(xml(subjects=subject+subject.replace('동명', '다른 이름')), 'abc')


class CollectionTests(unittest.TestCase):
    def test_cycles_dedup_empty_terms_and_repeated_course_across_terms(self):
        refs = ''.join(f'<primaryTable year="2024" semester="{s}" identifier="{i}"/>'
                       for i, s in [('abc','1'), ('def','2'), ('empty','여름'), ('def','2')])
        pages = {'abc':xml(references=refs), 'def':xml('def', semester='2', references=refs),
                 'empty':xml('empty', semester='여름', subjects='', references=refs)}
        calls = []
        def fetch(identifier):
            calls.append(identifier)
            return pages[identifier]
        result = collect('https://everytime.kr/@abc', fetcher=fetch)
        self.assertEqual(calls, ['abc','def','empty'])
        self.assertEqual(result['summary']['imported_tables'], 3)
        self.assertEqual(result['summary']['course_attempts'], 2)
        self.assertEqual(result['import_status'], 'complete')
        self.assertNotEqual(*[r['id'] for r in result['course_attempts']])
        self.assertFalse(result['history_complete'])
        self.assertNotIn('저장하지 않을 이름', json.dumps(result, ensure_ascii=False))

    def test_failed_child_keeps_successful_rows(self):
        def fetch(identifier):
            if identifier == 'bad':
                raise ImportFailure('HTTP 403')
            return xml(references='<primaryTable year="2024" semester="2" identifier="bad"/>')
        result = collect('https://everytime.kr/@abc', fetcher=fetch)
        self.assertEqual(result['import_status'], 'partial')
        self.assertEqual(len(result['course_attempts']), 1)
        self.assertEqual(result['failures'][0]['identifier'], 'bad')

    def test_failed_root_is_not_a_successful_empty_history(self):
        result = collect('https://everytime.kr/@abc', fetcher=lambda _: '<response/>')
        self.assertEqual(result['import_status'], 'partial')
        self.assertEqual(result['summary']['imported_tables'], 0)
        self.assertEqual(len(result['failures']), 1)

    def test_limit_preserves_unfetched_reference(self):
        result = collect('https://everytime.kr/@abc', max_tables=1,
                         fetcher=lambda _: xml(references='<primaryTable year="2024" semester="2" identifier="def"/>'))
        self.assertEqual(result['failures'][0]['code'], 'table_limit')
        self.assertEqual(result['summary']['requested_tables'], 1)

    def test_term_mismatch_is_not_silently_accepted(self):
        pages = {'abc': xml(references='<primaryTable year="2024" semester="2" identifier="def"/>'),
                 'def': xml('def', semester='1')}
        result = collect('https://everytime.kr/@abc', fetcher=pages.__getitem__)
        self.assertEqual(result['import_status'], 'partial')
        self.assertEqual(result['summary']['imported_tables'], 1)

    def test_json_unicode_and_overwrite_snapshot(self):
        test_root = Path(__file__).resolve().parent
        with tempfile.TemporaryDirectory(prefix='import-test-', dir=test_root) as directory:
            assert Path(directory).resolve().parent == test_root
            output = Path(directory)/'nested'/'data.json'
            result = collect('https://everytime.kr/@abc', fetcher=lambda _: xml())
            save_json(result, output)
            save_json(result, output)
            self.assertEqual(json.loads(output.read_text(encoding='utf-8')), result)
            self.assertEqual(list(output.parent.glob('*.tmp')), [])


if __name__ == '__main__':
    unittest.main()
