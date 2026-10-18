"""Offline BPE counts; caches stay inside the BEAM data directory supplied by the caller."""
import json
import sys

import tiktoken


def main():
    request = json.load(sys.stdin)
    encoder = tiktoken.get_encoding(request.get("encoding", "cl100k_base"))
    print(json.dumps([len(encoder.encode(text)) for text in request["texts"]]))


if __name__ == "__main__":
    main()
