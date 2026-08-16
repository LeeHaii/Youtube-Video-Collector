"""Replace one PyInstaller CArchive PYSOURCE entry without changing dependencies.

This is an offline maintenance fallback. Normal releases should still use the
full PyInstaller build in build-executables.js.
"""

import argparse
import marshal
import os
import struct
import zlib
from dataclasses import dataclass
from pathlib import Path


COOKIE_MAGIC = b"MEI\014\013\012\013\016"
COOKIE_STRUCT = struct.Struct("!8sIIII64s")
TOC_HEADER_STRUCT = struct.Struct("!iIIIBB")


@dataclass
class ArchiveEntry:
    name: str
    data: bytes
    uncompressed_size: int
    compressed: int
    typecode: int


def parse_archive(raw: bytes):
    if len(raw) < COOKIE_STRUCT.size:
        raise ValueError("CArchive is too small")

    magic, package_size, toc_offset, toc_size, python_version, python_library = (
        COOKIE_STRUCT.unpack_from(raw, len(raw) - COOKIE_STRUCT.size)
    )
    if magic != COOKIE_MAGIC:
        raise ValueError("PyInstaller CArchive cookie was not found")
    if package_size != len(raw):
        raise ValueError(f"CArchive size mismatch: cookie={package_size}, actual={len(raw)}")
    if toc_offset + toc_size != len(raw) - COOKIE_STRUCT.size:
        raise ValueError("CArchive TOC bounds are invalid")

    entries = []
    cursor = toc_offset
    toc_end = toc_offset + toc_size
    while cursor < toc_end:
        entry_size, position, compressed_size, uncompressed_size, compressed, typecode = (
            TOC_HEADER_STRUCT.unpack_from(raw, cursor)
        )
        if entry_size < TOC_HEADER_STRUCT.size or cursor + entry_size > toc_end:
            raise ValueError("CArchive TOC entry bounds are invalid")
        name_bytes = raw[cursor + TOC_HEADER_STRUCT.size:cursor + entry_size]
        name = name_bytes.split(b"\0", 1)[0].decode("utf-8")
        data = raw[position:position + compressed_size]
        if len(data) != compressed_size:
            raise ValueError(f"CArchive data bounds are invalid for {name}")
        entries.append(ArchiveEntry(name, data, uncompressed_size, compressed, typecode))
        cursor += entry_size

    return entries, python_version, python_library


def build_archive(entries, python_version: int, python_library: bytes) -> bytes:
    data_parts = []
    toc_parts = []
    position = 0

    for entry in entries:
        data_parts.append(entry.data)
        name = entry.name.encode("utf-8") + b"\0"
        entry_size = TOC_HEADER_STRUCT.size + len(name)
        entry_size = (entry_size + 15) & ~15
        toc_parts.append(
            TOC_HEADER_STRUCT.pack(
                entry_size,
                position,
                len(entry.data),
                entry.uncompressed_size,
                entry.compressed,
                entry.typecode,
            )
            + name
            + bytes(entry_size - TOC_HEADER_STRUCT.size - len(name))
        )
        position += len(entry.data)

    data = b"".join(data_parts)
    toc = b"".join(toc_parts)
    package_size = len(data) + len(toc) + COOKIE_STRUCT.size
    cookie = COOKIE_STRUCT.pack(
        COOKIE_MAGIC,
        package_size,
        len(data),
        len(toc),
        python_version,
        python_library,
    )
    return data + toc + cookie


def replace_source_entry(entries, entry_name: str, source_path: Path) -> None:
    matches = [entry for entry in entries if entry.name == entry_name]
    if len(matches) != 1:
        raise ValueError(f"Expected exactly one {entry_name!r} entry; found {len(matches)}")

    entry = matches[0]
    if chr(entry.typecode) != "s":
        raise ValueError(f"Entry {entry_name!r} is type {chr(entry.typecode)!r}, not PYSOURCE")

    previous_marshaled = zlib.decompress(entry.data) if entry.compressed else entry.data
    previous_code = marshal.loads(previous_marshaled)
    source = source_path.read_bytes()
    new_code = compile(source, previous_code.co_filename, "exec", dont_inherit=True)
    marshaled = marshal.dumps(new_code)
    entry.data = zlib.compress(marshaled, level=9) if entry.compressed else marshaled
    entry.uncompressed_size = len(marshaled)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--executable", required=True, type=Path)
    parser.add_argument("--package", required=True, type=Path)
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--entry", required=True)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--output-package", type=Path)
    args = parser.parse_args()

    executable = args.executable.read_bytes()
    old_package = args.package.read_bytes()
    if not executable.endswith(old_package):
        raise ValueError("The supplied CArchive is not the executable's exact suffix")

    entries, python_version, python_library = parse_archive(old_package)
    replace_source_entry(entries, args.entry, args.source)
    new_package = build_archive(entries, python_version, python_library)
    # Parse the generated package before touching the target executable.
    generated_entries, generated_version, generated_library = parse_archive(new_package)
    if generated_version != python_version or generated_library != python_library:
        raise ValueError("Generated CArchive metadata does not match the source archive")
    if [entry.name for entry in generated_entries] != [entry.name for entry in entries]:
        raise ValueError("Generated CArchive entry order does not match the source archive")

    output = executable[:-len(old_package)] + new_package
    temporary_output = args.output.with_suffix(args.output.suffix + ".tmp")
    temporary_output.write_bytes(output)
    os.replace(temporary_output, args.output)
    if args.output_package:
        temporary_package = args.output_package.with_suffix(args.output_package.suffix + ".tmp")
        temporary_package.write_bytes(new_package)
        os.replace(temporary_package, args.output_package)
    print(f"Repacked {args.entry}: {args.output} ({len(output)} bytes)")


if __name__ == "__main__":
    main()
