"""Lossless bounded passages for long-form model tasks."""

import re


def split_passages(content: str, limit: int = 900) -> list[str]:
    chunks = []
    while content:
        end = min(limit, len(content))
        if end < len(content):
            candidates = [match.end() for match in re.finditer(r"\n|[。！？]", content[:end])
                          if match.end() >= limit // 2]
            if candidates:
                end = candidates[-1]
        chunks.append(content[:end])
        content = content[end:]
    return chunks
