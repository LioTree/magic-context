"""One-time conversion of a BEAM parquet split into JSON Lines, one conversation per line.

The TypeScript harness has no parquet reader and adds no npm dependencies, so this script runs
once per split inside a private venv that has pyarrow installed (see README.md).

Usage: python parquet_to_jsonl.py <input.parquet> <output.jsonl>
"""

import json
import sys

import pyarrow.parquet as pq


def main() -> None:
    source, target = sys.argv[1], sys.argv[2]
    rows = pq.read_table(source).to_pylist()
    with open(target, "w", encoding="utf-8") as out:
        for row in rows:
            out.write(json.dumps(row, ensure_ascii=False) + "\n")
    print(f"{len(rows)} rows -> {target}")


if __name__ == "__main__":
    main()
