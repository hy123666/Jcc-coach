from __future__ import annotations

import argparse
import json
from pathlib import Path

from capstone import Cs, CS_ARCH_X86, CS_MODE_64
from elftools.elf.elffile import ELFFile


DEFAULT_SO = ".omx/runtime-evidence/mumu-gameassist-jkchess/apk/lib/x86_64/libcrypto_native.so"
DEFAULT_OUT = "data/runtime/jcc/mumu-crypto-native-disassembly.json"
TARGET = "Java_com_mumu_gameassist_util_CryptoNative_decryptFile"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--so", default=DEFAULT_SO)
    parser.add_argument("--out", default=DEFAULT_OUT)
    parser.add_argument("--symbol", default=TARGET)
    return parser.parse_args()


def find_symbol(elf: ELFFile, name: str):
    for section_name in [".symtab", ".dynsym"]:
        section = elf.get_section_by_name(section_name)
        if section is None:
            continue
        for symbol in section.iter_symbols():
            if symbol.name == name:
                return {
                    "name": symbol.name,
                    "value": int(symbol["st_value"]),
                    "size": int(symbol["st_size"]),
                    "section_index": symbol["st_shndx"],
                    "bind": symbol["st_info"]["bind"],
                    "type": symbol["st_info"]["type"],
                    "source": section_name,
                }
    return None


def section_for_vaddr(elf: ELFFile, vaddr: int):
    for section in elf.iter_sections():
        start = int(section["sh_addr"])
        size = int(section["sh_size"])
        if start <= vaddr < start + size:
            return section
    return None


def get_dyn_symbols(elf: ELFFile):
    section = elf.get_section_by_name(".dynsym")
    if section is None:
        return []
    return [
        {
            "name": symbol.name,
            "value": int(symbol["st_value"]),
            "size": int(symbol["st_size"]),
            "type": symbol["st_info"]["type"],
            "bind": symbol["st_info"]["bind"],
        }
        for symbol in section.iter_symbols()
        if symbol.name
    ]


def get_relocations(elf: ELFFile):
    dyn = elf.get_section_by_name(".dynsym")
    out = []
    for section in elf.iter_sections():
        if not section.name.startswith(".rela"):
            continue
        for rel in section.iter_relocations():
            sym_name = None
            if dyn is not None and rel["r_info_sym"] != 0:
                sym_name = dyn.get_symbol(rel["r_info_sym"]).name
            out.append({
                "section": section.name,
                "offset": int(rel["r_offset"]),
                "type": int(rel["r_info_type"]),
                "symbol": sym_name,
            })
    return out


def main() -> None:
    args = parse_args()
    so_path = Path(args.so)
    with so_path.open("rb") as handle:
        elf = ELFFile(handle)
        symbol = find_symbol(elf, args.symbol)
        if symbol is None:
            raise SystemExit(f"symbol not found: {args.symbol}")
        section = section_for_vaddr(elf, symbol["value"])
        if section is None:
            raise SystemExit(f"no section for symbol: {args.symbol}")
        section_data = section.data()
        section_vaddr = int(section["sh_addr"])
        start = symbol["value"] - section_vaddr
        size = symbol["size"] or 0x500
        code = section_data[start:start + size]

        md = Cs(CS_ARCH_X86, CS_MODE_64)
        md.detail = True
        instructions = []
        for insn in md.disasm(code, symbol["value"]):
            instructions.append({
                "address": hex(insn.address),
                "mnemonic": insn.mnemonic,
                "op_str": insn.op_str,
            })

        relocations = get_relocations(elf)
        dyn_symbols = get_dyn_symbols(elf)
        imported_symbols = [
            sym for sym in dyn_symbols
            if sym["value"] == 0 and sym["type"] == "STT_FUNC"
        ]
        likely_calls = [
            item for item in instructions
            if item["mnemonic"].startswith("call") or item["mnemonic"].startswith("jmp")
        ]
        text = "\n".join(f"{item['mnemonic']} {item['op_str']}" for item in instructions)
        constants = sorted({
            token.strip(",")
            for line in instructions
            for token in line["op_str"].replace("[", " ").replace("]", " ").replace("+", " ").split()
            if token.startswith("0x")
        })

    out = {
        "schema_version": 1,
        "so_path": str(so_path).replace("\\", "/"),
        "symbol": symbol,
        "section": {
            "name": section.name,
            "vaddr": hex(section_vaddr),
            "size": int(section["sh_size"]),
        },
        "instruction_count": len(instructions),
        "instructions": instructions,
        "likely_calls": likely_calls,
        "imported_symbols": imported_symbols,
        "relocations": relocations,
        "constants": constants,
        "classification": {
            "uses_file_io": any(name in text for name in ["fopen", "fread", "fseek", "ftell", "fclose"]),
            "uses_malloc": "malloc" in text,
            "uses_jni_byte_array": any("NewByteArray" in item["op_str"] or "SetByteArrayRegion" in item["op_str"] for item in instructions),
            "note": "Call resolution requires PLT/GOT annotation; this artifact is a bounded disassembly slice, not a full decompiler.",
        },
    }
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "ok": True,
        "out": str(out_path),
        "instruction_count": len(instructions),
        "imported_symbols": [sym["name"] for sym in imported_symbols],
        "constants": constants[:20],
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
