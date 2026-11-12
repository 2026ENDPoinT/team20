import argparse
from pathlib import Path
import sys

from .importer import ImportFailure, collect, save_json


def main():
    parser = argparse.ArgumentParser(description='에브리타임 공유 시간표를 공식 과목 연결 전 JSON으로 저장합니다.')
    parser.add_argument('url', help='https://everytime.kr/@식별자')
    parser.add_argument('--output', type=Path,
                        default=Path(__file__).parent/'runtime'/'course_import.json')
    parser.add_argument('--max-tables', type=int, default=100)
    args = parser.parse_args()
    try:
        document = collect(args.url, max_tables=args.max_tables)
        save_json(document, args.output)
    except (ImportFailure, OSError, ValueError) as exc:
        print(str(exc), file=sys.stderr)
        return 1
    counts = document['summary']
    print(f"{document['import_status']}: {counts['imported_tables']} tables, "
          f"{counts['course_attempts']} courses; {len(document['failures'])} failures")
    print(args.output.resolve())
    return 2 if document['failures'] else 0


if __name__ == '__main__':
    raise SystemExit(main())
